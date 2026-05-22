#!/usr/bin/env python3
"""Run deterministic Agent Ops eval assertions.

This is not an LLM runner. It scores saved agent outputs so teams can compare
Codex, Claude Code, Cursor, or framework outputs with the same checks.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]


def load_output(eval_file: Path, item: dict[str, Any]) -> str:
    if "output" in item:
        return str(item["output"])
    if "output_file" in item:
        path = (eval_file.parent / str(item["output_file"])).resolve()
        if not path.is_file():
            raise FileNotFoundError(path)
        return path.read_text(errors="ignore")
    raise ValueError(f"{eval_file}: eval {item.get('name', item.get('id'))} has no output or output_file")


def check_assertion(output: str, assertion: dict[str, Any]) -> tuple[bool, str]:
    kind = assertion.get("type")
    lowered = output.lower()

    if kind == "contains":
        value = str(assertion["value"])
        ok = value.lower() in lowered
        return ok, f"contains {value!r}"

    if kind == "not_contains":
        value = str(assertion["value"])
        ok = value.lower() not in lowered
        return ok, f"does not contain {value!r}"

    if kind == "contains_all":
        values = [str(item) for item in assertion.get("values", [])]
        missing = [item for item in values if item.lower() not in lowered]
        return not missing, f"contains all values; missing={missing}"

    if kind == "contains_any":
        values = [str(item) for item in assertion.get("values", [])]
        ok = any(item.lower() in lowered for item in values)
        return ok, f"contains any of {values}"

    if kind == "regex":
        pattern = str(assertion["value"])
        ok = re.search(pattern, output, flags=re.IGNORECASE | re.MULTILINE) is not None
        return ok, f"matches /{pattern}/"

    if kind == "heading":
        value = str(assertion["value"]).strip()
        ok = re.search(rf"^#+\s+{re.escape(value)}\s*$", output, flags=re.IGNORECASE | re.MULTILINE) is not None
        return ok, f"has heading {value!r}"

    if kind == "min_word_count":
        minimum = int(assertion["value"])
        count = len(re.findall(r"\b\w+\b", output))
        return count >= minimum, f"word_count {count} >= {minimum}"

    raise ValueError(f"unknown assertion type {kind!r}")


def run_eval_file(path: Path) -> tuple[int, int]:
    data = json.loads(path.read_text())
    passed = 0
    total = 0
    for item in data.get("evals", []):
        total += 1
        name = item.get("name") or item.get("id") or f"eval-{total}"
        output = load_output(path, item)
        failures: list[str] = []
        assertions = item.get("assertions", [])
        if not assertions:
            failures.append("no assertions")
        for assertion in assertions:
            ok, message = check_assertion(output, assertion)
            if not ok:
                failures.append(message)
        if failures:
            print(f"FAIL {data.get('agent_id', 'unknown')}::{name}")
            for failure in failures:
                print(f"  - {failure}")
        else:
            print(f"PASS {data.get('agent_id', 'unknown')}::{name}")
            passed += 1
    return passed, total


def iter_eval_files(eval_dir: Path) -> list[Path]:
    return sorted(path for path in eval_dir.glob("*.json") if path.is_file())


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run deterministic Agent Ops eval assertions.")
    parser.add_argument("--root", default=".", help="Repository root used to resolve relative eval paths")
    parser.add_argument("--eval-dir", default="examples/evals", help="Directory containing eval JSON files")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    root = Path(args.root).resolve()
    eval_dir_arg = Path(args.eval_dir)
    eval_dir = eval_dir_arg if eval_dir_arg.is_absolute() else root / eval_dir_arg
    eval_dir = eval_dir.resolve()
    files = iter_eval_files(eval_dir)
    if not files:
        print(f"FAIL no eval files found in {eval_dir}")
        return 1

    passed = 0
    total = 0
    for path in files:
        file_passed, file_total = run_eval_file(path)
        passed += file_passed
        total += file_total

    print(f"RESULT {passed}/{total} evals passed")
    return 0 if passed == total and total > 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
