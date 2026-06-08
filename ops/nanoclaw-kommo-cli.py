#!/usr/bin/env python3
"""Read-only Kommo CRM CLI for NanoClaw agents."""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime
from typing import Any

DEFAULT_MCP_URLS = [
    "http://kommo-mcp:8001/mcp",
    "http://172.21.0.2:8001/mcp",
    "http://172.19.0.4:8001/mcp",
]

USAGE = """Usage:
  python3 scripts/kommo-cli.py ping
  python3 scripts/kommo-cli.py leads [--limit N] [--query TEXT] [--pipeline_id ID]
  python3 scripts/kommo-cli.py lead <lead_id>
  python3 scripts/kommo-cli.py contacts [--limit N] [--query TEXT]
  python3 scripts/kommo-cli.py pipelines
  python3 scripts/kommo-cli.py users
  python3 scripts/kommo-cli.py analytics <action> [--pipeline_id ID] [--period TEXT] [--days N]
  python3 scripts/kommo-cli.py search <query>
  python3 scripts/kommo-cli.py report <action> [--period TEXT] [--pipeline_id ID]
  python3 scripts/kommo-cli.py insights <action> [--pipeline_id ID] [--limit N]
  python3 scripts/kommo-cli.py deals <action> [--pipeline_id ID]
  python3 scripts/kommo-cli.py tasks <action> [--user_id ID]
  python3 scripts/kommo-cli.py alerts <action>
  python3 scripts/kommo-cli.py events [--user_id ID] [--days N] [--limit N]
  python3 scripts/kommo-cli.py entity get <entity_type> <entity_id>
  python3 scripts/kommo-cli.py entity list <entity_type> [--limit N] [--query TEXT]
  python3 scripts/kommo-cli.py sql "<SELECT ...>"
  python3 scripts/kommo-cli.py sql -
  python3 scripts/kommo-cli.py raw <tool_name> [json_args]
"""


def candidate_urls() -> list[str]:
    configured = os.environ.get("KOMMO_MCP_URL", "").strip()
    if configured:
        return [configured]
    return DEFAULT_MCP_URLS


def parse_optional_args(args: list[str]) -> dict[str, Any]:
    params: dict[str, Any] = {}
    i = 0
    while i < len(args):
        if args[i].startswith("--") and i + 1 < len(args):
            key = args[i][2:]
            value: Any = args[i + 1]
            try:
                value = int(value)
            except ValueError:
                pass
            params[key] = value
            i += 2
        else:
            i += 1
    return params


def request_json(url: str, payload: dict[str, Any]) -> dict[str, Any]:
    data = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, method="POST", headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode())


def mcp_call(tool_name: str, arguments: dict[str, Any] | None = None, *, silent: bool = False) -> Any:
    payload = {
        "jsonrpc": "2.0",
        "method": "tools/call",
        "id": 1,
        "params": {"name": tool_name, "arguments": arguments or {}},
    }
    errors: list[str] = []
    for url in candidate_urls():
        try:
            result = request_json(url, payload)
            break
        except urllib.error.HTTPError as exc:
            body = exc.read().decode() if exc.fp else str(exc)
            print(json.dumps({"error": exc.code, "message": body}, ensure_ascii=False), file=sys.stderr)
            sys.exit(1)
        except Exception as exc:
            errors.append(f"{url}: {exc}")
    else:
        if silent:
            return {}
        print(json.dumps({"error": "KommoMCP unreachable", "details": errors}, ensure_ascii=False, indent=2), file=sys.stderr)
        sys.exit(1)

    if "error" in result:
        if silent:
            return {}
        print(json.dumps(result["error"], ensure_ascii=False, indent=2), file=sys.stderr)
        sys.exit(1)

    contents = result.get("result", {}).get("content", [])
    for item in contents:
        if item.get("type") == "text":
            text = item.get("text", "")
            try:
                parsed = json.loads(text)
            except (json.JSONDecodeError, TypeError):
                parsed = text
            if silent:
                return parsed
            if isinstance(parsed, str):
                print(parsed)
            else:
                print(json.dumps(parsed, ensure_ascii=False, indent=2))
            return parsed

    if silent:
        return result
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return result


def cmd_events(args: list[str]) -> None:
    params = parse_optional_args(args)
    user_id = params.get("user_id")
    days = int(params.get("days", 3))
    limit = int(params.get("limit", 100))
    event_type = params.get("type")
    entity = params.get("entity")

    tool_params: dict[str, Any] = {
        "created_at_from": datetime.fromtimestamp(time.time() - (days * 86400)).isoformat(),
        "limit": min(limit, 100),
        "with_names": True,
    }
    if user_id:
        tool_params["filter_created_by"] = [int(user_id)]
    if event_type:
        tool_params["filter_type"] = [t.strip() for t in str(event_type).split(",")]
    if entity:
        tool_params["filter_entity"] = [e.strip() for e in str(entity).split(",")]

    all_events: list[dict[str, Any]] = []
    page = 1
    while len(all_events) < limit:
        tool_params["page"] = page
        data = mcp_call("kommo_events", tool_params, silent=True)
        events = data.get("events", []) if isinstance(data, dict) else []
        if not events:
            break
        all_events.extend(events)
        if len(events) < tool_params["limit"]:
            break
        page += 1

    limited = all_events[:limit]
    by_type: dict[str, int] = {}
    by_user: dict[str, int] = {}
    for event in limited:
        event_type_name = event.get("type", "unknown")
        by_type[event_type_name] = by_type.get(event_type_name, 0) + 1
        uid = event.get("created_by")
        if uid:
            by_user[str(uid)] = by_user.get(str(uid), 0) + 1

    print(json.dumps({
        "period_days": days,
        "total_events": len(limited),
        "by_type": by_type,
        "by_user": by_user,
        "events": limited,
    }, ensure_ascii=False, indent=2))


def require_rest(cmd: str, rest: list[str]) -> None:
    if not rest:
        print(f"Missing arguments for: {cmd}", file=sys.stderr)
        print(USAGE, file=sys.stderr)
        sys.exit(1)


def main() -> None:
    if len(sys.argv) < 2:
        print(USAGE)
        sys.exit(1)

    cmd = sys.argv[1]
    rest = sys.argv[2:]

    if cmd == "ping":
        mcp_call("kommo_ping")
    elif cmd == "leads":
        mcp_call("kommo_leads_list", parse_optional_args(rest))
    elif cmd == "lead":
        require_rest(cmd, rest)
        mcp_call("kommo_lead_get", {"lead_id": int(rest[0])})
    elif cmd == "contacts":
        mcp_call("kommo_contacts_list", parse_optional_args(rest))
    elif cmd == "pipelines":
        mcp_call("kommo_pipelines_list")
    elif cmd == "users":
        mcp_call("kommo_users_list")
    elif cmd == "analytics":
        require_rest(cmd, rest)
        params = parse_optional_args(rest[1:])
        params["action"] = rest[0]
        mcp_call("kommo_analytics", params)
    elif cmd == "search":
        require_rest(cmd, rest)
        mcp_call("kommo_search", {"action": "query", "query": " ".join(rest)})
    elif cmd == "report":
        require_rest(cmd, rest)
        params = parse_optional_args(rest[1:])
        params["action"] = rest[0]
        mcp_call("kommo_report", params)
    elif cmd == "insights":
        require_rest(cmd, rest)
        params = parse_optional_args(rest[1:])
        params["action"] = rest[0]
        mcp_call("kommo_insights", params)
    elif cmd == "deals":
        require_rest(cmd, rest)
        params = parse_optional_args(rest[1:])
        params["action"] = rest[0]
        mcp_call("kommo_deals_ext", params)
    elif cmd == "tasks":
        require_rest(cmd, rest)
        params = parse_optional_args(rest[1:])
        params["action"] = rest[0]
        mcp_call("kommo_tasks_ext", params)
    elif cmd == "alerts":
        require_rest(cmd, rest)
        params = parse_optional_args(rest[1:])
        params["action"] = rest[0]
        mcp_call("kommo_alerts", params)
    elif cmd == "entity":
        if len(rest) < 2:
            print("Usage: python3 scripts/kommo-cli.py entity get|list <entity_type> [entity_id] [--options]", file=sys.stderr)
            sys.exit(1)
        action = rest[0]
        params: dict[str, Any] = {"action": action, "entity_type": rest[1]}
        if action == "get" and len(rest) > 2:
            params["entity_id"] = int(rest[2])
            params.update(parse_optional_args(rest[3:]))
        else:
            params.update(parse_optional_args(rest[2:]))
        mcp_call("kommo_entity", params)
    elif cmd == "events":
        cmd_events(rest)
    elif cmd == "sql":
        require_rest(cmd, rest)
        query = sys.stdin.read() if rest[0] == "-" else " ".join(rest)
        query = query.strip()
        if not query:
            print("Error: empty SQL query", file=sys.stderr)
            sys.exit(1)
        mcp_call("kommo_sql", {"query": query})
    elif cmd == "raw":
        require_rest(cmd, rest)
        args = json.loads(rest[1]) if len(rest) > 1 else {}
        mcp_call(rest[0], args)
    else:
        print(f"Unknown command: {cmd}", file=sys.stderr)
        print(USAGE, file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
