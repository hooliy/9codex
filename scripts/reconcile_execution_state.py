#!/usr/bin/env python3
"""Reconcile a persisted execution-state JSON document.

The daemon owns the SQLite implementation of this operation.  This small
stdlib-only utility is intentionally format-tolerant so it can also repair a
recovery handoff or an exported execution snapshot without requiring the
daemon (or credentials) to be running.

Usage:
    reconcile_execution_state.py INPUT [OUTPUT] [--revision REVISION_ID]

When OUTPUT is omitted INPUT is replaced atomically.  The default revision is
``current_requirement_revision_id`` or ``current_revision_id`` in the
document.  ``team.max_workers`` is always normalized to 20.
"""

from __future__ import annotations

import argparse
import copy
import json
import os
import tempfile
from collections import defaultdict
from pathlib import Path
from typing import Any


ACTIVE_WORK = {"assigned", "running", "verifying"}
ACTIVE_RUN = {"queued", "assigned", "running", "verifying", "rework"}
ACTIVE_SESSION = {"creating", "running", "waiting", "closing", "assigned"}
TERMINAL = {"closed", "passed", "canceled", "stale", "superseded", "interrupted"}
DEPENDENCY_COMPLETE = {"closed", "passed"}


def first(obj: dict[str, Any], *names: str, default: Any = None) -> Any:
    for name in names:
        if name in obj:
            return obj[name]
    return default


def set_field(obj: dict[str, Any], snake: str, value: Any) -> None:
    """Write the canonical snake-case key and update an existing camel key."""
    obj[snake] = value
    camel = "".join(part.title() if index else part for index, part in enumerate(snake.split("_")))
    if camel in obj:
        obj[camel] = value


def as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def json_list(value: Any) -> list[Any]:
    """Accept JSON columns as well as already-decoded API values."""
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError:
            value = [value]
    return as_list(value)


def item_id(item: dict[str, Any]) -> str:
    return str(first(item, "id", "work_item_id", "workItemId", default=""))


def revision_id(item: dict[str, Any]) -> str | None:
    value = first(item, "requirement_revision_id", "requirementRevisionId", "revision_id", "revisionId")
    return str(value) if value is not None else None


def paths(item: dict[str, Any], *names: str) -> set[str]:
    return {
        str(entry)
        for entry in json_list(first(item, *names, default=[]))
        if str(entry)
    }


def mark_historical(obj: dict[str, Any], kind: str, now: str) -> None:
    if kind == "work_item":
        status = "stale"
    elif kind == "run":
        status = "superseded"
    else:
        status = "interrupted"
    set_field(obj, "status", status)
    set_field(obj, "stale_reason", "requirement_revision_superseded")
    set_field(obj, "superseded_at", now)
    set_field(obj, "updated_at", now)
    if kind == "run":
        set_field(obj, "ended_at", first(obj, "ended_at", default=now) or now)
    if kind == "session":
        set_field(obj, "closed_at", first(obj, "closed_at", default=now) or now)


def topo_batches(
    items: list[dict[str, Any]],
    dependencies: dict[str, set[str]],
    current_ids: set[str],
    completed_ids: set[str] | None = None,
) -> list[list[str]]:
    by_id = {item_id(item): item for item in items}
    remaining = set(by_id)
    completed: set[str] = set(completed_ids or set())
    batches: list[list[str]] = []
    while remaining:
        candidates = [
            ident for ident in sorted(remaining)
            if dependencies.get(ident, set()).intersection(current_ids) <= completed
        ]
        if not candidates:
            # A malformed cycle must not make the repair loop forever. Keep
            # the cycle visible and place it in one deterministic batch.
            candidates = sorted(remaining)
        batch: list[str] = []
        batch_writes: set[str] = set()
        batch_locks: set[str] = set()
        for ident in candidates:
            item = by_id[ident]
            writes = paths(item, "write_set", "writeSet")
            locks = paths(item, "resource_locks", "resourceLocks")
            if writes & batch_writes or locks & batch_locks:
                continue
            batch.append(ident)
            batch_writes |= writes
            batch_locks |= locks
        if not batch:
            batch = [candidates[0]]
        batches.append(batch)
        completed.update(batch)
        remaining.difference_update(batch)
    return batches

def authority_conflicts(
    item: dict[str, Any],
    authority: list[dict[str, Any]],
    item_by_id: dict[str, dict[str, Any]],
) -> dict[str, list[str]]:
    """Return durable lock and workspace conflicts held by another item."""
    ident = item_id(item)
    writes = paths(item, "write_set", "writeSet")
    wanted_locks = paths(item, "resource_locks", "resourceLocks")
    locked_resources: list[str] = []
    workspace_holders: list[str] = []
    for row in authority:
        holder = str(first(row, "work_item_id", "workItemId", "owner", default=""))
        if not holder or holder == ident:
            continue
        resource = str(first(row, "resource_key", "resourceKey", "key", default=""))
        if resource and resource in wanted_locks:
            locked_resources.append(resource)
        held = item_by_id.get(holder)
        if held and writes.intersection(paths(held, "write_set", "writeSet")):
            workspace_holders.append(holder)
    return {
        "resource_locks": sorted(set(locked_resources)),
        "workspace_holders": sorted(set(workspace_holders)),
    }


def row_is_historical(
    row: dict[str, Any],
    historical_item_ids: set[str],
    historical_session_ids: set[str],
    current_revision: str,
) -> bool:
    return (
        revision_id(row) not in {None, current_revision}
        or str(first(row, "work_item_id", "workItemId", default="")) in historical_item_ids
        or str(first(row, "worker_session_id", "workerSessionId", default="")) in historical_session_ids
    )


def reconcile(document: dict[str, Any], revision: str | None = None, now: str | None = None) -> dict[str, Any]:
    result = copy.deepcopy(document)
    current = revision or first(
        result,
        "current_requirement_revision_id",
        "current_revision_id",
        default=first(result.get("current_state", {}), "current_requirement_revision_id", "current_revision_id"),
    )
    if not current:
        raise ValueError("current revision is required (--revision or current_revision_id)")
    current = str(current)
    timestamp = now or str(first(result, "updated_at", "generated_at", default=""))
    if not timestamp:
        timestamp = "1970-01-01T00:00:00.000Z"

    team = result.setdefault("team", {})
    if not isinstance(team, dict):
        team = result["team"] = {}
    team["max_workers"] = 20
    result["max_workers"] = 20

    items = [item for item in as_list(result.get("work_items")) if isinstance(item, dict)]
    item_by_id = {item_id(item): item for item in items}
    historical_ids: set[str] = set()
    for item in items:
        if revision_id(item) != current:
            historical_ids.add(item_id(item))
            if first(item, "status", default="") not in TERMINAL:
                mark_historical(item, "work_item", timestamp)

    # Normalize the declared write and lock sets before recomputing a
    # conflict-free schedule. This also handles exported SQLite JSON columns.
    for item in items:
        set_field(item, "write_set", sorted(paths(item, "write_set", "writeSet")))
        set_field(item, "resource_locks", sorted(paths(item, "resource_locks", "resourceLocks")))

    dependencies: dict[str, set[str]] = defaultdict(set)
    edges = as_list(result.get("work_item_dependencies"))
    for edge in edges:
        if not isinstance(edge, dict):
            continue
        child = str(first(edge, "work_item_id", "workItemId", default=""))
        parent = str(first(edge, "depends_on_id", "dependsOnId", default=""))
        if child in item_by_id and parent in item_by_id and child != parent:
            dependencies[child].add(parent)
    for item in items:
        ident = item_id(item)
        raw = first(item, "dependencies", "dependency_ids", "dependencyIds", default=[])
        for parent in json_list(raw):
            if str(parent) in item_by_id and str(parent) != ident:
                dependencies[ident].add(str(parent))
        set_field(item, "dependencies", sorted(dependencies[ident]))

    sessions = [row for row in as_list(result.get("worker_sessions")) if isinstance(row, dict)]
    runs = [row for row in as_list(result.get("runs")) if isinstance(row, dict)]
    historical_sessions: set[str] = set()
    for session in sessions:
        linked = str(first(session, "work_item_id", "workItemId", default=""))
        if linked in historical_ids or revision_id(session) not in {None, current}:
            historical_sessions.add(str(first(session, "id", "worker_session_id", default="")))
            if first(session, "status", default="") in ACTIVE_SESSION:
                mark_historical(session, "session", timestamp)
    for run in runs:
        historical_run = row_is_historical(run, historical_ids, historical_sessions, current)
        if historical_run and first(run, "status", default="") not in TERMINAL:
            mark_historical(run, "run", timestamp)

    # Leases, locks, workspace claims, and explicit capacity reservations are
    # authority records, not history. Remove stale entries completely.
    for key in ("work_item_leases", "resource_locks", "workspace_claims", "worker_capacity", "leases", "locks"):
        rows = as_list(result.get(key))
        kept = []
        for row in rows:
            if not isinstance(row, dict):
                continue
            if row_is_historical(row, historical_ids, historical_sessions, current):
                continue
            kept.append(row)
        if key in result:
            result[key] = kept

    # The persisted DAG lists all current work (normally the requested ten
    # nodes), including completed evidence. Batches only contain dispatchable
    # non-terminal work.
    current_items = [item for item in items if revision_id(item) == current]
    current_ids = {item_id(item) for item in current_items}
    schedulable_items = [
        item for item in current_items
        if first(item, "status", default="") not in TERMINAL
    ]
    completed_ids = {
        item_id(item) for item in current_items
        if first(item, "status", default="") in DEPENDENCY_COMPLETE
    }
    batches = topo_batches(schedulable_items, dependencies, current_ids, completed_ids)
    batch_by_id = {ident: index + 1 for index, batch in enumerate(batches) for ident in batch}
    active_item_ids = {
        str(first(run, "work_item_id", "workItemId", default=""))
        for run in runs
        if revision_id(run) == current and first(run, "status", default="") in ACTIVE_RUN
    }
    # A partial export can omit a run record; durable work-item status remains
    # a conservative fallback for capacity accounting.
    active_item_ids.update(
        item_id(item) for item in current_items
        if first(item, "status", default="") in ACTIVE_WORK
    )
    active_count = len(active_item_ids)
    authority = [
        row
        for key in ("resource_locks", "workspace_claims", "locks")
        for row in as_list(result.get(key))
        if isinstance(row, dict)
    ]
    queue_position = 0
    for item in current_items:
        ident = item_id(item)
        status = str(first(item, "status", default=""))
        unmet = sorted(dep for dep in dependencies.get(ident, set())
                       if first(item_by_id.get(dep, {}), "status", default="") not in DEPENDENCY_COMPLETE)
        conflicts = authority_conflicts(item, authority, item_by_id)
        if status in TERMINAL:
            reason, action = "terminal", "retain completion evidence"
        elif unmet:
            reason, action = "dependencies_incomplete", "wait for upstream work to complete"
        elif ident in active_item_ids:
            reason, action = "worker_running", "continue worker execution"
        elif conflicts["resource_locks"] or conflicts["workspace_holders"]:
            reason, action = "resource_or_workspace_lock", "wait for the conflicting worker to release its authority"
        elif active_count >= 20:
            reason, action = "worker_capacity", "wait for an available worker slot"
        else:
            reason, action = "ready_for_worker", "dispatch a conflict-free worker"
        if status in {"backlog", "ready", "rework"} and not unmet:
            queue_position += 1
        set_field(item, "blocked_by", unmet)
        set_field(item, "lock_conflicts", conflicts)
        set_field(item, "waiting_reason", reason)
        set_field(item, "queue_position", queue_position if status in {"backlog", "ready", "rework"} and not unmet else None)
        set_field(item, "next_action", action)
        set_field(item, "last_activity_at", timestamp)
        set_field(item, "dag_batch", batch_by_id.get(ident))

    result["current_revision_id"] = current
    result["current_requirement_revision_id"] = current
    result["dag"] = {
        "revision_id": current,
        "work_item_ids": [item_id(item) for item in current_items],
        "dependencies": {
            ident: sorted(dependencies.get(ident, set()))
            for ident in current_ids
        },
        "batches": batches,
        "max_workers": 20,
        "active_workers": active_count,
        "recomputed_at": timestamp,
    }
    result["reconciliation"] = {
        "status": "completed",
        "current_revision_id": current,
        "historical_work_item_ids": sorted(historical_ids),
        "historical_worker_session_ids": sorted(historical_sessions),
        "released_authority": True,
        "last_activity_at": timestamp,
    }
    return result


def atomic_write(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_name, path)
    finally:
        try:
            os.unlink(temp_name)
        except FileNotFoundError:
            pass


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path, nargs="?")
    parser.add_argument("--revision")
    parser.add_argument("--now")
    args = parser.parse_args()
    document = json.loads(args.input.read_text(encoding="utf-8"))
    if not isinstance(document, dict):
        raise SystemExit("execution state must be a JSON object")
    repaired = reconcile(document, args.revision, args.now)
    atomic_write(args.output or args.input, repaired)
    print(json.dumps(repaired["reconciliation"], ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    main()
