#!/usr/bin/env python3
"""Validate a compact Codex context handoff file."""

import json
import sys
from pathlib import Path


REQUIRED_TOP_LEVEL = {
    "objective",
    "work_items",
    "acceptance_commands",
    "resume_instructions",
}
REQUIRED_WORK_ITEM_FIELDS = {"dependencies", "dispatch", "monitoring", "acceptance"}


def fail(message: str) -> "NoReturn":
    print(f"handoff invalid: {message}", file=sys.stderr)
    raise SystemExit(1)


def non_empty(value: object) -> bool:
    return isinstance(value, str) and bool(value.strip())


def validate(path: Path) -> int:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except OSError as error:
        fail(f"{path}: {error}")
    except json.JSONDecodeError as error:
        fail(f"{path}: invalid JSON at line {error.lineno}, column {error.colno}: {error.msg}")

    if not isinstance(data, dict):
        fail(f"{path}: top level must be a JSON object")

    missing = sorted(REQUIRED_TOP_LEVEL - data.keys())
    if missing:
        fail(f"{path}: missing top-level fields: {', '.join(missing)}")

    raw_items = data["work_items"]
    if isinstance(raw_items, dict) and raw_items:
        items = [dict(item, key=key) for key, item in raw_items.items() if isinstance(item, dict)]
        if len(items) != len(raw_items):
            fail(f"{path}: work_items values must be objects")
    elif isinstance(raw_items, list) and raw_items:
        items = raw_items
    else:
        fail(f"{path}: work_items must be a non-empty object or array")

    keys: set[str] = set()
    dependencies: dict[str, list[str]] = {}
    for index, item in enumerate(items):
        label = f"work_items[{index}]"
        if not isinstance(item, dict):
            fail(f"{path}: {label} must be an object")
        missing = sorted(REQUIRED_WORK_ITEM_FIELDS - item.keys())
        if missing:
            fail(f"{path}: {label} missing fields: {', '.join(missing)}")

        key = item["key"]
        if not non_empty(key):
            fail(f"{path}: {label}.key must be a non-empty string")
        if key in keys:
            fail(f"{path}: duplicate work item key: {key}")
        keys.add(key)

        deps = item["dependencies"]
        if not isinstance(deps, list) or any(not non_empty(dep) for dep in deps):
            fail(f"{path}: {label}.dependencies must be an array of non-empty strings")
        if len(deps) != len(set(deps)):
            fail(f"{path}: {label}.dependencies contains duplicates")
        dependencies[key] = deps

        for field in ("dispatch", "monitoring", "acceptance"):
            if not isinstance(item[field], (dict, list, str)) or not item[field]:
                fail(f"{path}: {label}.{field} must be non-empty")

    for key, deps in dependencies.items():
        unknown = sorted(set(deps) - keys)
        if unknown:
            fail(f"{path}: {key}.dependencies references unknown keys: {', '.join(unknown)}")

    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(key: str) -> None:
        if key in visiting:
            fail(f"{path}: dependency cycle detected at {key}")
        if key in visited:
            return
        visiting.add(key)
        for dependency in dependencies[key]:
            visit(dependency)
        visiting.remove(key)
        visited.add(key)

    for key in keys:
        visit(key)

    commands = data["acceptance_commands"]
    if (
        not isinstance(commands, list)
        or not commands
        or any(not non_empty(command) for command in commands)
    ):
        fail(f"{path}: acceptance_commands must be a non-empty array of non-empty strings")

    instructions = data["resume_instructions"]
    if not (
        non_empty(instructions)
        or (
            isinstance(instructions, list)
            and instructions
            and all(non_empty(instruction) for instruction in instructions)
        )
    ):
        fail(f"{path}: resume_instructions must be a non-empty string or string array")

    return len(items)


def main() -> None:
    path = Path(sys.argv[1]) if len(sys.argv) == 2 else Path(".codex/handoff.json")
    if len(sys.argv) > 2:
        fail("usage: verify_handoff.py [path]")
    count = validate(path)
    print(f"handoff valid: {path} ({count} work items)")


if __name__ == "__main__":
    main()
