#!/usr/bin/env python3
"""KommoMCP freshness checks and sync trigger for NanoClaw ops."""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import Any


DEFAULT_MCP_URLS = [
    "http://172.21.0.2:8001/mcp",
    "http://kommo-mcp:8001/mcp",
    "http://172.19.0.4:8001/mcp",
]


def request_timeout_seconds() -> int:
    value = int(os.environ.get("KOMMO_MCP_REQUEST_TIMEOUT_SECONDS", "90"))
    if value <= 0:
        raise ValueError("KOMMO_MCP_REQUEST_TIMEOUT_SECONDS must be positive")
    return value


def candidate_urls() -> list[str]:
    configured = os.environ.get("KOMMO_MCP_URL", "").strip()
    if configured:
        return [configured]
    configured_many = os.environ.get("KOMMO_MCP_URLS", "").strip()
    if configured_many:
        return [url.strip() for url in configured_many.split(",") if url.strip()]
    return DEFAULT_MCP_URLS


def request_json(url: str, payload: dict[str, Any]) -> dict[str, Any]:
    data = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, method="POST", headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=request_timeout_seconds()) as resp:
        return json.loads(resp.read().decode())


def mcp_call(tool_name: str, arguments: dict[str, Any] | None = None) -> Any:
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
            raise RuntimeError(f"{url}: HTTP {exc.code}: {body}") from exc
        except Exception as exc:
            errors.append(f"{url}: {exc}")
    else:
        raise RuntimeError(f"KommoMCP unreachable: {errors}")

    if "error" in result:
        raise RuntimeError(json.dumps(result["error"], ensure_ascii=False))

    contents = result.get("result", {}).get("content", [])
    for item in contents:
        if item.get("type") != "text":
            continue
        text = item.get("text", "")
        try:
            return json.loads(text)
        except (json.JSONDecodeError, TypeError):
            return text
    return result


def parse_dt(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def evaluate_status(status: dict[str, Any], max_age_hours: float) -> dict[str, Any]:
    now = datetime.now(timezone.utc)
    entities: dict[str, Any] = {}
    stale = False
    failed = False
    oldest: datetime | None = None

    for entity, info in sorted(status.items()):
        if not isinstance(info, dict):
            continue
        last_sync = parse_dt(info.get("last_sync_at"))
        age_hours = None
        if last_sync:
            age_hours = (now - last_sync).total_seconds() / 3600
            oldest = last_sync if oldest is None or last_sync < oldest else oldest
        entity_failed = info.get("status") != "completed" or bool(info.get("error_message"))
        entity_stale = age_hours is None or age_hours > max_age_hours
        stale = stale or entity_stale
        failed = failed or entity_failed
        entities[entity] = {
            "status": info.get("status"),
            "last_sync_at": info.get("last_sync_at"),
            "age_hours": round(age_hours, 2) if age_hours is not None else None,
            "records_count": info.get("records_count"),
            "error_message": info.get("error_message"),
            "stale": entity_stale,
            "failed": entity_failed,
        }

    return {
        "ok": not stale and not failed,
        "stale": stale,
        "failed": failed,
        "max_age_hours": max_age_hours,
        "oldest_sync_at": oldest.isoformat() if oldest else None,
        "checked_at": now.isoformat(),
        "entities": entities,
    }


def print_json(payload: Any) -> None:
    print(json.dumps(payload, ensure_ascii=False, indent=2))


def wait_for_fresh(max_age_hours: float, timeout_seconds: int, poll_seconds: int) -> dict[str, Any]:
    deadline = time.time() + timeout_seconds
    last_report: dict[str, Any] | None = None
    while time.time() <= deadline:
        status = mcp_call("kommo_sync_status")
        report = evaluate_status(status, max_age_hours)
        last_report = report
        if report["ok"]:
            return report
        time.sleep(poll_seconds)
    assert last_report is not None
    return last_report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="cmd", required=True)

    status_cmd = sub.add_parser("status", help="print raw kommo_sync_status")
    status_cmd.set_defaults(func=lambda _args: print_json(mcp_call("kommo_sync_status")) or 0)

    fresh_cmd = sub.add_parser("freshness", help="check sync freshness")
    fresh_cmd.add_argument("--max-age-hours", type=float, default=6)

    sync_cmd = sub.add_parser("sync", help="trigger Kommo sync")
    sync_cmd.add_argument("--full", action="store_true")
    sync_cmd.add_argument("--wait", action="store_true")
    sync_cmd.add_argument("--max-age-hours", type=float, default=6)
    sync_cmd.add_argument("--timeout-seconds", type=int, default=900)
    sync_cmd.add_argument("--poll-seconds", type=int, default=15)

    ensure_cmd = sub.add_parser("ensure-fresh", help="check freshness and optionally sync when stale")
    ensure_cmd.add_argument("--max-age-hours", type=float, default=6)
    ensure_cmd.add_argument("--sync-if-stale", action="store_true")
    ensure_cmd.add_argument("--timeout-seconds", type=int, default=900)
    ensure_cmd.add_argument("--poll-seconds", type=int, default=15)

    args = parser.parse_args()

    try:
        if args.cmd == "freshness":
            report = evaluate_status(mcp_call("kommo_sync_status"), args.max_age_hours)
            print_json(report)
            return 0 if report["ok"] else 2

        if args.cmd == "sync":
            started = mcp_call("kommo_sync_start", {"full": bool(args.full)})
            if not args.wait:
                print_json({"started": started})
                return 0
            report = wait_for_fresh(args.max_age_hours, args.timeout_seconds, args.poll_seconds)
            print_json({"started": started, "freshness": report})
            return 0 if report["ok"] else 2

        if args.cmd == "ensure-fresh":
            report = evaluate_status(mcp_call("kommo_sync_status"), args.max_age_hours)
            if report["ok"] or not args.sync_if_stale:
                print_json(report)
                return 0 if report["ok"] else 2
            started = mcp_call("kommo_sync_start", {"full": False})
            fresh = wait_for_fresh(args.max_age_hours, args.timeout_seconds, args.poll_seconds)
            print_json({"before": report, "started": started, "after": fresh})
            return 0 if fresh["ok"] else 2

        return args.func(args)
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False, indent=2), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
