#!/usr/bin/env python3
"""Validate Agent Ops contracts in a repository.

This is intentionally dependency-free. It does not sandbox an agent runtime.
It enforces the repo-level contracts that make runtime policy auditable:
agent specs, tool ACLs, call graphs, governed channels, and governed tasks.
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any


REQUIRED_AGENT_FIELDS = [
    "agent_id",
    "version",
    "description",
    "reports_to",
    "allowed_callers",
    "allowed_callees",
    "tools",
    "memory_scope",
    "write_scope",
]

REQUIRED_AGENT_SECTIONS = [
    "## Role",
    "## Inputs",
    "## Outputs",
    "## Boundaries",
    "## Evals",
]

REQUIRED_TASK_SECTIONS = [
    "## Summary",
    "## Owner",
    "## Lane",
    "## Why Governed",
    "## Scope",
    "## Required Reviews",
    "## Acceptance Criteria",
    "## Test Plan",
    "## Rollback Plan",
    "## Evidence",
]

REQUIRED_CHANNELS = {
    "email_send": {"approval_id", "approved_by", "approved_at", "recipient", "evidence_ref", "audit_log", "failure_path"},
    "social_post": {"approval_id", "approved_by", "approved_at", "platform", "content_hash", "evidence_ref", "audit_log"},
    "production_deploy": {"change_summary", "tests_passed", "security_review", "rollback_plan", "approver", "deploy_log"},
}

HIGH_RISK_TERMS = {
    "auth",
    "password",
    "email",
    "production",
    "deploy",
    "private data",
    "payment",
    "billing",
    "external",
    "delete",
    "trade",
    "financial execution",
}

FORBIDDEN_TOOLS = {
    "direct_email_send",
    "direct_social_post",
    "read_all_secrets",
    "production_delete",
    "trading_execute",
}

FORBIDDEN_SCOPE_VALUES = {
    "*",
    "all",
    "all_files",
    "all_memory",
    "all_secrets",
    "entire_repo",
    "full_repo",
    "full_memory",
    "private_memory",
    "unrestricted",
}


@dataclass(frozen=True)
class Layout:
    root: Path
    agent_dir: Path
    registry_dir: Path
    task_files: list[Path]


@dataclass(frozen=True)
class AgentSpec:
    path: Path
    values: dict[str, Any]
    body: str

    @property
    def agent_id(self) -> str:
        return str(self.values.get("agent_id", "")).strip()

    def list_value(self, key: str) -> list[str]:
        value = self.values.get(key, [])
        if isinstance(value, list):
            return [str(item).strip() for item in value if str(item).strip()]
        if isinstance(value, str) and value.strip():
            return [value.strip()]
        return []


def parse_inline_value(raw: str) -> Any:
    value = raw.strip()
    if value == ">":
        return "multiline"
    if value.startswith("[") and value.endswith("]"):
        inner = value[1:-1].strip()
        if not inner:
            return []
        return [item.strip().strip("\"'") for item in inner.split(",")]
    return value.strip("\"'")


def parse_frontmatter(path: Path) -> tuple[dict[str, Any], str]:
    text = path.read_text(errors="ignore")
    if not text.startswith("---"):
        return {}, text
    parts = text.split("---", 2)
    if len(parts) < 3:
        return {}, text
    frontmatter = parts[1]
    body = parts[2]
    values: dict[str, Any] = {}
    for raw_line in frontmatter.splitlines():
        line = raw_line.rstrip()
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        match = re.match(r"^([A-Za-z0-9_-]+):\s*(.*)$", line)
        if match:
            values[match.group(1)] = parse_inline_value(match.group(2))
    return values, body


def parse_nested_list_yaml(path: Path) -> dict[str, Any]:
    result: dict[str, Any] = {}
    current_top: str | None = None
    current_field: str | None = None

    for raw_line in path.read_text(errors="ignore").splitlines():
        if not raw_line.strip() or raw_line.lstrip().startswith("#"):
            continue
        indent = len(raw_line) - len(raw_line.lstrip(" "))
        line = raw_line.strip()

        if indent == 0 and line.endswith(":"):
            current_top = line[:-1]
            current_field = None
            result[current_top] = {}
            continue

        if current_top is None:
            continue

        if indent == 2 and line.endswith(":"):
            current_field = line[:-1]
            if isinstance(result[current_top], dict):
                result[current_top][current_field] = []
            continue

        if line.startswith("- "):
            item = line[2:].strip()
            if indent == 2:
                if not isinstance(result.get(current_top), list):
                    result[current_top] = []
                result[current_top].append(item)
            elif indent == 4 and current_field and isinstance(result.get(current_top), dict):
                result[current_top][current_field].append(item)

    return result


def parse_governed_channels(path: Path) -> dict[str, list[str]]:
    channels: dict[str, list[str]] = {}
    current_channel: str | None = None
    in_requires = False

    for raw_line in path.read_text(errors="ignore").splitlines():
        if not raw_line.strip() or raw_line.lstrip().startswith("#"):
            continue
        indent = len(raw_line) - len(raw_line.lstrip(" "))
        line = raw_line.strip()

        if indent == 2 and line.endswith(":"):
            current_channel = line[:-1]
            channels[current_channel] = []
            in_requires = False
            continue
        if indent == 4 and line == "requires:" and current_channel:
            in_requires = True
            continue
        if indent == 6 and in_requires and current_channel and line.startswith("- "):
            channels[current_channel].append(line[2:].strip())

    return channels


def resolve_layout(root: Path, agent_dir: str | None, registry_dir: str | None) -> Layout:
    root = root.resolve()
    if agent_dir or registry_dir:
        if not agent_dir or not registry_dir:
            raise ValueError("pass both --agent-dir and --registry-dir, or neither")
        agents = (root / agent_dir).resolve()
        registry = (root / registry_dir).resolve()
    elif (root / ".agent-ops").is_dir():
        agents = root / ".agent-ops" / "agents"
        registry = root / ".agent-ops" / "registry"
    else:
        agents = root / "examples" / "software-team-agents"
        registry = root / "examples" / "registry"

    task_files: list[Path] = []
    agent_ops_tasks = root / ".agent-ops" / "tasks"
    if agent_ops_tasks.is_dir():
        task_files.extend(sorted(agent_ops_tasks.glob("*.md")))
    example_task = root / "examples" / "worked-example" / "governed-task.md"
    if example_task.is_file():
        task_files.append(example_task)

    return Layout(root=root, agent_dir=agents, registry_dir=registry, task_files=task_files)


def registry_file(layout: Layout, name: str) -> Path:
    direct = layout.registry_dir / name
    if direct.exists():
        return direct
    example = layout.registry_dir / name.replace(".yaml", ".example.yaml")
    return example


def load_agents(agent_dir: Path) -> tuple[dict[str, AgentSpec], list[str]]:
    errors: list[str] = []
    agents: dict[str, AgentSpec] = {}
    files = sorted(path for path in agent_dir.glob("*.md") if path.name != "README.md")
    if not files:
        return agents, [f"missing agent files in {agent_dir}"]

    for path in files:
        values, body = parse_frontmatter(path)
        spec = AgentSpec(path=path, values=values, body=body)
        rel = str(path)
        for field in REQUIRED_AGENT_FIELDS:
            if field not in values:
                errors.append(f"{rel}: missing frontmatter field {field}")
        for section in REQUIRED_AGENT_SECTIONS:
            if section not in body:
                errors.append(f"{rel}: missing section {section}")

        agent_id = spec.agent_id
        if not agent_id:
            continue
        if agent_id in agents:
            errors.append(f"{rel}: duplicate agent_id {agent_id}")
        if path.stem != agent_id:
            errors.append(f"{rel}: filename should match agent_id {agent_id}")

        for field in ["memory_scope", "write_scope"]:
            value = str(values.get(field, "")).strip().lower()
            if value in FORBIDDEN_SCOPE_VALUES:
                errors.append(f"{rel}: {field} is too broad: {value}")

        agents[agent_id] = spec

    return agents, errors


def validate_tool_acl(layout: Layout, agents: dict[str, AgentSpec], strict: bool) -> list[str]:
    path = registry_file(layout, "tool-acl.yaml")
    if not path.exists():
        return [f"missing registry file {path}"]
    registry = parse_nested_list_yaml(path)
    blocked_tools = set(registry.get("blocked_tools", [])) | FORBIDDEN_TOOLS
    errors: list[str] = []

    for agent_id, spec in agents.items():
        requested = set(spec.list_value("tools"))
        entry = registry.get(agent_id)
        if not isinstance(entry, dict) or "tools" not in entry:
            errors.append(f"{agent_id}: missing tool ACL registry entry")
            continue
        allowed = set(entry.get("tools", []))
        blocked_requested = requested & blocked_tools
        blocked_allowed = allowed & blocked_tools
        if blocked_requested:
            errors.append(f"{agent_id}: requests blocked tools {sorted(blocked_requested)}")
        if blocked_allowed:
            errors.append(f"{agent_id}: ACL grants blocked tools {sorted(blocked_allowed)}")
        extra = requested - allowed
        if extra:
            errors.append(f"{agent_id}: requested tools not allowed by ACL {sorted(extra)}")
        if strict:
            unused_grants = allowed - requested
            if unused_grants:
                errors.append(f"{agent_id}: ACL grants tools not declared by agent {sorted(unused_grants)}")

    return errors


def validate_call_graph(layout: Layout, agents: dict[str, AgentSpec], strict: bool) -> list[str]:
    path = registry_file(layout, "call-graph.yaml")
    if not path.exists():
        return [f"missing registry file {path}"]
    registry = parse_nested_list_yaml(path)
    errors: list[str] = []
    agent_ids = set(agents)

    for agent_id, spec in agents.items():
        declared = set(spec.list_value("allowed_callees"))
        unknown = declared - agent_ids
        if unknown:
            errors.append(f"{agent_id}: calls unknown agents {sorted(unknown)}")

        entry = registry.get(agent_id)
        if not isinstance(entry, dict) or "can_call" not in entry:
            errors.append(f"{agent_id}: missing call-graph registry entry")
            continue

        allowed = set(entry.get("can_call", []))
        blocked = declared - allowed
        if blocked:
            errors.append(f"{agent_id}: allowed_callees exceed call graph {sorted(blocked)}")
        if strict:
            drift = allowed - declared
            if drift:
                errors.append(f"{agent_id}: call graph allows undeclared callees {sorted(drift)}")

        for caller in spec.list_value("allowed_callers"):
            if caller not in agent_ids:
                continue
            caller_entry = registry.get(caller, {})
            caller_allowed = set(caller_entry.get("can_call", [])) if isinstance(caller_entry, dict) else set()
            if agent_id not in caller_allowed:
                errors.append(f"{agent_id}: allowed caller {caller} cannot call it in call graph")

    return errors


def validate_governed_channels(layout: Layout) -> list[str]:
    path = registry_file(layout, "governed-channels.yaml")
    if not path.exists():
        return [f"missing registry file {path}"]
    channels = parse_governed_channels(path)
    errors: list[str] = []
    for channel, required_fields in REQUIRED_CHANNELS.items():
        actual = set(channels.get(channel, []))
        if not actual:
            errors.append(f"{channel}: missing governed channel entry")
            continue
        missing = required_fields - actual
        if missing:
            errors.append(f"{channel}: missing required evidence fields {sorted(missing)}")
    return errors


def validate_governed_tasks(layout: Layout) -> list[str]:
    errors: list[str] = []
    if not layout.task_files:
        return errors

    for path in layout.task_files:
        text = path.read_text(errors="ignore")
        rel = str(path)
        for section in REQUIRED_TASK_SECTIONS:
            if section not in text:
                errors.append(f"{rel}: missing section {section}")
        lowered = text.lower()
        if any(term in lowered for term in HIGH_RISK_TERMS) and "`governed`" not in lowered and "lane\n\ngoverned" not in lowered:
            errors.append(f"{rel}: high-risk task must use governed lane")
    return errors


def report(label: str, errors: list[str]) -> bool:
    if errors:
        print(f"FAIL {label}")
        for error in errors:
            print(f"  - {error}")
        return False
    print(f"PASS {label}")
    return True


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Validate Agent Ops contracts.")
    parser.add_argument("--root", default=".", help="Repository root to validate")
    parser.add_argument("--agent-dir", help="Agent directory relative to --root")
    parser.add_argument("--registry-dir", help="Registry directory relative to --root")
    parser.add_argument("--strict", action="store_true", help="Fail on ACL/call-graph drift, not only forbidden access")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        layout = resolve_layout(Path(args.root), args.agent_dir, args.registry_dir)
    except ValueError as error:
        print(f"FAIL layout\n  - {error}")
        return 1

    agents, agent_errors = load_agents(layout.agent_dir)
    checks = [
        ("agent specs", agent_errors),
        ("tool ACL enforcement", validate_tool_acl(layout, agents, args.strict) if agents else ["agent specs did not load"]),
        ("call graph enforcement", validate_call_graph(layout, agents, args.strict) if agents else ["agent specs did not load"]),
        ("governed channel registry", validate_governed_channels(layout)),
        ("governed tasks", validate_governed_tasks(layout)),
    ]

    ok = True
    for label, errors in checks:
        ok = report(label, errors) and ok
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
