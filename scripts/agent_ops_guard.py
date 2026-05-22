#!/usr/bin/env python3
"""Small runtime guard helpers for Agent Ops registries.

Import this from an agent runner before executing tools or delegating work.
The CLI is mainly for smoke tests and examples.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from agent_ops_validate import (
    FORBIDDEN_TOOLS,
    REQUIRED_CHANNELS,
    parse_governed_channels,
    parse_nested_list_yaml,
    registry_file,
    resolve_layout,
)


class PolicyDenied(RuntimeError):
    """Raised when an Agent Ops policy denies an action."""


class AgentOpsGuard:
    def __init__(self, root: str | Path = ".") -> None:
        self.layout = resolve_layout(Path(root), None, None)
        self.tool_acl = parse_nested_list_yaml(registry_file(self.layout, "tool-acl.yaml"))
        self.call_graph = parse_nested_list_yaml(registry_file(self.layout, "call-graph.yaml"))
        self.channels = parse_governed_channels(registry_file(self.layout, "governed-channels.yaml"))
        self.blocked_tools = set(self.tool_acl.get("blocked_tools", [])) | FORBIDDEN_TOOLS

    def assert_tool_allowed(self, agent_id: str, tool_name: str) -> None:
        if tool_name in self.blocked_tools:
            raise PolicyDenied(f"{agent_id} cannot use blocked tool {tool_name}")
        entry = self.tool_acl.get(agent_id)
        allowed = set(entry.get("tools", [])) if isinstance(entry, dict) else set()
        if tool_name not in allowed:
            raise PolicyDenied(f"{agent_id} is not allowed to use {tool_name}")

    def assert_call_allowed(self, caller_agent_id: str, callee_agent_id: str) -> None:
        entry = self.call_graph.get(caller_agent_id)
        allowed = set(entry.get("can_call", [])) if isinstance(entry, dict) else set()
        if callee_agent_id not in allowed:
            raise PolicyDenied(f"{caller_agent_id} is not allowed to call {callee_agent_id}")

    def assert_channel_evidence(self, channel: str, evidence: dict[str, Any]) -> None:
        required = set(self.channels.get(channel, [])) or REQUIRED_CHANNELS.get(channel, set())
        if not required:
            raise PolicyDenied(f"unknown governed channel {channel}")
        missing = sorted(field for field in required if not evidence.get(field))
        if missing:
            raise PolicyDenied(f"{channel} missing evidence fields {missing}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Check one Agent Ops runtime policy decision.")
    parser.add_argument("--root", default=".", help="Repository root")
    subparsers = parser.add_subparsers(dest="command", required=True)

    tool = subparsers.add_parser("tool", help="Check whether an agent may use a tool")
    tool.add_argument("agent_id")
    tool.add_argument("tool_name")

    call = subparsers.add_parser("call", help="Check whether one agent may call another")
    call.add_argument("caller_agent_id")
    call.add_argument("callee_agent_id")

    channel = subparsers.add_parser("channel", help="Check governed-channel evidence JSON")
    channel.add_argument("channel")
    channel.add_argument("--evidence", required=True, help="JSON object with approval/evidence fields")

    return parser.parse_args()


def main() -> int:
    args = parse_args()
    guard = AgentOpsGuard(args.root)
    try:
        if args.command == "tool":
            guard.assert_tool_allowed(args.agent_id, args.tool_name)
        elif args.command == "call":
            guard.assert_call_allowed(args.caller_agent_id, args.callee_agent_id)
        elif args.command == "channel":
            guard.assert_channel_evidence(args.channel, json.loads(args.evidence))
    except (PolicyDenied, json.JSONDecodeError) as error:
        print(f"DENY {error}")
        return 1
    print("ALLOW")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
