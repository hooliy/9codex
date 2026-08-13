#!/usr/bin/env python3
"""Independent acceptance test for scripts/reconcile_execution_state.py."""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path


SCRIPT = Path(__file__).with_name("reconcile_execution_state.py")
SPEC = importlib.util.spec_from_file_location("reconcile_execution_state", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


CURRENT = "rr_current"
OLD = "rr_old"
NOW = "2026-08-13T00:00:00.000Z"


def work_item(index: int, **overrides: object) -> dict[str, object]:
    item: dict[str, object] = {
        "id": f"wi-{index}",
        "requirement_revision_id": CURRENT,
        "status": "ready",
        "write_set": [f"lib/{index}.mjs"],
        "resource_locks": [f"resource:{index}"],
        "dependencies": [f"wi-{index - 1}"] if index > 1 else [],
    }
    item.update(overrides)
    return item


def main() -> None:
    current_items = [work_item(index) for index in range(1, 11)]
    current_items[0]["status"] = "closed"
    current_items[1]["status"] = "running"
    current_items[2]["dependencies"] = ["wi-1"]
    current_items[2]["write_set"] = ["lib/shared.mjs"]
    current_items[3]["dependencies"] = ["wi-1"]
    current_items[3]["write_set"] = ["lib/shared.mjs"]
    document = {
        "current_requirement_revision_id": CURRENT,
        "team": {"max_workers": 3},
        "work_items": [
            *current_items,
            work_item(99, id="wi-old", requirement_revision_id=OLD, status="running"),
        ],
        "work_item_dependencies": [
            {"work_item_id": item["id"], "depends_on_id": dependency}
            for item in current_items
            for dependency in item["dependencies"]
        ],
        "worker_sessions": [
            {"id": "session-current", "work_item_id": "wi-2", "requirement_revision_id": CURRENT, "status": "running"},
            {"id": "session-old", "work_item_id": "wi-old", "requirement_revision_id": OLD, "status": "running"},
        ],
        "runs": [
            {"id": "run-current", "work_item_id": "wi-2", "worker_session_id": "session-current", "requirement_revision_id": CURRENT, "status": "running"},
            {"id": "run-old", "work_item_id": "wi-old", "worker_session_id": "session-old", "requirement_revision_id": OLD, "status": "running"},
        ],
        "work_item_leases": [
            {"work_item_id": "wi-2", "worker_session_id": "session-current", "requirement_revision_id": CURRENT},
            {"work_item_id": "wi-old", "worker_session_id": "session-old", "requirement_revision_id": OLD},
        ],
        "resource_locks": [
            {"resource_key": "resource:2", "work_item_id": "wi-2", "worker_session_id": "session-current", "requirement_revision_id": CURRENT},
            {"resource_key": "resource:99", "work_item_id": "wi-old", "worker_session_id": "session-old", "requirement_revision_id": OLD},
        ],
        "workspace_claims": [
            {"work_item_id": "wi-2", "worker_session_id": "session-current", "requirement_revision_id": CURRENT},
            {"work_item_id": "wi-old", "worker_session_id": "session-old", "requirement_revision_id": OLD},
        ],
        "worker_capacity": [
            {"work_item_id": "wi-old", "worker_session_id": "session-old", "requirement_revision_id": OLD},
        ],
    }

    repaired = MODULE.reconcile(document, now=NOW)
    items = {item["id"]: item for item in repaired["work_items"]}
    assert repaired["team"]["max_workers"] == 20
    assert repaired["max_workers"] == 20
    assert repaired["current_requirement_revision_id"] == CURRENT
    assert len(repaired["dag"]["work_item_ids"]) == 10
    assert items["wi-old"]["status"] == "stale"
    assert repaired["worker_sessions"][1]["status"] == "interrupted"
    assert repaired["runs"][1]["status"] == "superseded"
    assert all(row.get("work_item_id") != "wi-old" for row in repaired["work_item_leases"])
    assert all(row.get("work_item_id") != "wi-old" for row in repaired["resource_locks"])
    assert all(row.get("work_item_id") != "wi-old" for row in repaired["workspace_claims"])
    assert repaired["worker_capacity"] == []
    assert items["wi-2"]["waiting_reason"] == "worker_running"
    assert items["wi-3"]["waiting_reason"] == "ready_for_worker"
    assert items["wi-3"]["queue_position"] == 1
    assert items["wi-4"]["queue_position"] != items["wi-3"]["queue_position"]
    assert items["wi-1"]["blocked_by"] == []
    assert items["wi-10"]["last_activity_at"] == NOW
    assert all("write_set" in item and "resource_locks" in item for item in current_items)
    print(json.dumps({
        "status": "passed",
        "current_work_items": len(repaired["dag"]["work_item_ids"]),
        "max_workers": repaired["team"]["max_workers"],
    }, sort_keys=True))


if __name__ == "__main__":
    main()
