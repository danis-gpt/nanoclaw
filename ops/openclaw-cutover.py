#!/usr/bin/env python3
"""
Cut OpenClaw runtime dependencies over to NanoClaw.

This script is intentionally local-host oriented:
- never prints Telegram tokens;
- writes backups before changing NanoClaw state;
- keeps OpenClaw files intact for rollback;
- migrates enabled OpenClaw cron jobs into NanoClaw per-session inbound.db
  task rows using NanoClaw's native recurrence shape.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
from pathlib import Path
from typing import Any


REPO = Path(__file__).resolve().parents[1]
DATA_DIR = REPO / "data"
CENTRAL_DB = DATA_DIR / "v2.db"
SESSIONS_DIR = DATA_DIR / "v2-sessions"
ENV_FILE = REPO / ".env"
OPENCLAW_ROOT = Path("/home/ubuntu/.openclaw")
OPENCLAW_JOBS = OPENCLAW_ROOT / "cron/jobs.json"
OPENCLAW_JOBS_STATE = OPENCLAW_ROOT / "cron/jobs-state.json"
DOCKER_CONTAINER = "dockclaw-dd"

AGENT_FOLDER_BY_OPENCLAW_ID = {
    "main": "aura",
    "radar": "radar",
    "vektor": "vektor",
}

AGENT_DESTINATION_NAMES = {
    "aura": "aura",
    "radar": "radar",
    "vektor": "vektor",
}

OPENCLAW_OPS_PATTERNS = (
    re.compile(r"\bopenclaw\b", re.IGNORECASE),
    re.compile(r"/home/node/\.openclaw"),
    re.compile(r"\bsessions_send\b"),
)

MIGRATION_PREFIX = """[NanoClaw cutover context, 2026-07-04]
This task was migrated from OpenClaw to NanoClaw.
- Do not use the OpenClaw CLI, /home/node/.openclaw paths, or sessions_send.
- Work from the current NanoClaw workspace.
- For Kommo/amocrm data use scripts/kommo-cli.py and check sync freshness before reporting.
- If old text says target=2057822644/accountId=vektor, use Vektor destination "aydar" or the current Aydar Telegram session.
- If old text asks to check OpenClaw updates, treat OpenClaw as retired and check NanoClaw instead.
"""

INBOUND_SCHEMA = """
CREATE TABLE IF NOT EXISTS messages_in (
  id             TEXT PRIMARY KEY,
  seq            INTEGER UNIQUE,
  kind           TEXT NOT NULL,
  timestamp      TEXT NOT NULL,
  status         TEXT DEFAULT 'pending',
  process_after  TEXT,
  recurrence     TEXT,
  series_id      TEXT,
  tries          INTEGER DEFAULT 0,
  trigger        INTEGER NOT NULL DEFAULT 1,
  platform_id    TEXT,
  channel_type   TEXT,
  thread_id      TEXT,
  content        TEXT NOT NULL,
  source_session_id TEXT,
  on_wake INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_messages_in_series ON messages_in(series_id);
CREATE TABLE IF NOT EXISTS delivered (
  message_out_id      TEXT PRIMARY KEY,
  platform_message_id TEXT,
  status              TEXT NOT NULL DEFAULT 'delivered',
  delivered_at        TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS destinations (
  name            TEXT PRIMARY KEY,
  display_name    TEXT,
  type            TEXT NOT NULL,
  channel_type    TEXT,
  platform_id     TEXT,
  agent_group_id  TEXT
);
CREATE TABLE IF NOT EXISTS session_routing (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  channel_type TEXT,
  platform_id  TEXT,
  thread_id    TEXT
);
"""

OUTBOUND_SCHEMA = """
CREATE TABLE IF NOT EXISTS messages_out (
  id             TEXT PRIMARY KEY,
  seq            INTEGER UNIQUE,
  in_reply_to    TEXT,
  timestamp      TEXT NOT NULL,
  deliver_after  TEXT,
  recurrence     TEXT,
  kind           TEXT NOT NULL,
  platform_id    TEXT,
  channel_type   TEXT,
  thread_id      TEXT,
  content        TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS processing_ack (
  message_id     TEXT PRIMARY KEY,
  status         TEXT NOT NULL,
  status_changed TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS session_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS container_state (
  id                       INTEGER PRIMARY KEY CHECK (id = 1),
  current_tool             TEXT,
  tool_declared_timeout_ms INTEGER,
  tool_started_at          TEXT,
  updated_at               TEXT NOT NULL
);
"""


def utc_now() -> dt.datetime:
    return dt.datetime.now(dt.UTC)


def iso_now() -> str:
    return utc_now().isoformat().replace("+00:00", "Z")


def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def save_json(path: Path, data: Any) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def connect(path: Path = CENTRAL_DB) -> sqlite3.Connection:
    con = sqlite3.connect(path)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA busy_timeout = 5000")
    return con


def generate_id(prefix: str) -> str:
    ts = int(utc_now().timestamp() * 1000)
    suffix = os.urandom(3).hex()
    return f"{prefix}-{ts}-{suffix}"


def read_env(path: Path) -> tuple[list[str], dict[str, str]]:
    lines = path.read_text(encoding="utf-8").splitlines()
    values: dict[str, str] = {}
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            values[key] = unquote_env(value)
    return lines, values


def unquote_env(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        return value[1:-1]
    return value


def quote_env(value: str) -> str:
    if re.fullmatch(r"[A-Za-z0-9_:@./+=-]+", value):
        return value
    return "'" + value.replace("'", "'\"'\"'") + "'"


def update_env_values(path: Path, updates: dict[str, str]) -> list[str]:
    lines, _ = read_env(path)
    seen: set[str] = set()
    out: list[str] = []
    changed: list[str] = []
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            out.append(line)
            continue
        key, _ = stripped.split("=", 1)
        if key in updates and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            out.append(f"{key}={quote_env(updates[key])}")
            seen.add(key)
            changed.append(key)
        else:
            out.append(line)
    for key, value in updates.items():
        if key not in seen:
            out.append(f"{key}={quote_env(value)}")
            changed.append(key)
    path.write_text("\n".join(out) + "\n", encoding="utf-8")
    return changed


def docker_env(container: str) -> dict[str, str]:
    result = subprocess.run(
        ["docker", "inspect", "--format", "{{json .Config.Env}}", container],
        check=True,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    env_list = json.loads(result.stdout)
    parsed: dict[str, str] = {}
    for item in env_list:
        if "=" in item:
            key, value = item.split("=", 1)
            parsed[key] = value
    return parsed


def token_fingerprint(token: str | None) -> str | None:
    if not token:
        return None
    import hashlib

    return hashlib.sha256(token.encode("utf-8")).hexdigest()[:12]


def backup_state(run_dir: Path) -> dict[str, Any]:
    run_dir.mkdir(parents=True, exist_ok=True)
    files = {
        "nanoclaw.env": ENV_FILE,
        "nanoclaw.v2.db": CENTRAL_DB,
        "openclaw.jobs.json": OPENCLAW_JOBS,
        "openclaw.jobs-state.json": OPENCLAW_JOBS_STATE,
        "openclaw.openclaw.json": OPENCLAW_ROOT / "openclaw.json",
    }
    copied: dict[str, str] = {}
    for name, src in files.items():
        if src.exists():
            dst = run_dir / name
            shutil.copy2(src, dst)
            copied[name] = str(dst)

    try:
        env = docker_env(DOCKER_CONTAINER)
        redacted = {
            k: ("SET:" + str(token_fingerprint(v)) if "TOKEN" in k or "KEY" in k or "SECRET" in k else v)
            for k, v in sorted(env.items())
        }
        save_json(run_dir / "openclaw-docker-env.redacted.json", redacted)
        copied["openclaw-docker-env.redacted.json"] = str(run_dir / "openclaw-docker-env.redacted.json")
    except Exception as exc:  # noqa: BLE001 - backup should remain best effort for env snapshot
        copied["openclaw-docker-env.redacted.error"] = str(exc)
    return copied


def agent_ids(con: sqlite3.Connection) -> dict[str, str]:
    rows = con.execute("SELECT id, folder FROM agent_groups").fetchall()
    by_folder = {row["folder"]: row["id"] for row in rows}
    missing = [folder for folder in AGENT_FOLDER_BY_OPENCLAW_ID.values() if folder not in by_folder]
    if missing:
        raise RuntimeError(f"missing NanoClaw agent group folders: {', '.join(missing)}")
    return {oc_id: by_folder[folder] for oc_id, folder in AGENT_FOLDER_BY_OPENCLAW_ID.items()}


def ensure_user(con: sqlite3.Connection, user_id: str, kind: str, display_name: str, now: str) -> None:
    con.execute(
        """
        INSERT INTO users (id, kind, display_name, created_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          display_name = CASE
            WHEN users.display_name IS NULL OR users.display_name = '' THEN excluded.display_name
            ELSE users.display_name
          END
        """,
        (user_id, kind, display_name, now),
    )


def get_or_create_messaging_group(
    con: sqlite3.Connection,
    *,
    platform_id: str,
    name: str,
    is_group: int,
    now: str,
) -> str:
    row = con.execute(
        "SELECT id FROM messaging_groups WHERE channel_type = 'telegram' AND platform_id = ? AND instance = 'telegram'",
        (platform_id,),
    ).fetchone()
    if row:
        return row["id"]
    mg_id = generate_id("mg")
    con.execute(
        """
        INSERT INTO messaging_groups
          (id, channel_type, platform_id, instance, name, is_group, unknown_sender_policy, created_at)
        VALUES (?, 'telegram', ?, 'telegram', ?, ?, 'strict', ?)
        """,
        (mg_id, platform_id, name, is_group, now),
    )
    return mg_id


def ensure_wiring(
    con: sqlite3.Connection,
    *,
    messaging_group_id: str,
    agent_group_id: str,
    local_name: str,
    now: str,
) -> None:
    row = con.execute(
        "SELECT id FROM messaging_group_agents WHERE messaging_group_id = ? AND agent_group_id = ?",
        (messaging_group_id, agent_group_id),
    ).fetchone()
    if not row:
        con.execute(
            """
            INSERT INTO messaging_group_agents
              (id, messaging_group_id, agent_group_id, engage_mode, engage_pattern,
               sender_scope, ignored_message_policy, session_mode, priority, created_at)
            VALUES (?, ?, ?, 'pattern', '.', 'all', 'drop', 'shared', 0, ?)
            """,
            (generate_id("mga"), messaging_group_id, agent_group_id, now),
        )
    ensure_destination(
        con,
        agent_group_id=agent_group_id,
        local_name=local_name,
        target_type="channel",
        target_id=messaging_group_id,
        now=now,
    )


def ensure_destination(
    con: sqlite3.Connection,
    *,
    agent_group_id: str,
    local_name: str,
    target_type: str,
    target_id: str,
    now: str,
) -> None:
    existing_target = con.execute(
        """
        SELECT local_name FROM agent_destinations
        WHERE agent_group_id = ? AND target_type = ? AND target_id = ?
        """,
        (agent_group_id, target_type, target_id),
    ).fetchone()
    if existing_target:
        return
    local = local_name
    suffix = 2
    while con.execute(
        "SELECT 1 FROM agent_destinations WHERE agent_group_id = ? AND local_name = ?",
        (agent_group_id, local),
    ).fetchone():
        local = f"{local_name}-{suffix}"
        suffix += 1
    con.execute(
        """
        INSERT INTO agent_destinations (agent_group_id, local_name, target_type, target_id, created_at)
        VALUES (?, ?, ?, ?, ?)
        """,
        (agent_group_id, local, target_type, target_id, now),
    )


def ensure_session(con: sqlite3.Connection, *, agent_group_id: str, messaging_group_id: str, now: str) -> str:
    row = con.execute(
        """
        SELECT id FROM sessions
        WHERE agent_group_id = ? AND messaging_group_id = ? AND thread_id IS NULL AND status = 'active'
        """,
        (agent_group_id, messaging_group_id),
    ).fetchone()
    if row:
        session_id = row["id"]
    else:
        session_id = generate_id("sess")
        con.execute(
            """
            INSERT INTO sessions
              (id, agent_group_id, messaging_group_id, thread_id, agent_provider,
               status, container_status, last_active, created_at)
            VALUES (?, ?, ?, NULL, NULL, 'active', 'stopped', NULL, ?)
            """,
            (session_id, agent_group_id, messaging_group_id, now),
        )

    init_session_folder(agent_group_id, session_id)
    return session_id


def init_session_folder(agent_group_id: str, session_id: str) -> None:
    base = SESSIONS_DIR / agent_group_id / session_id
    (base / "outbox").mkdir(parents=True, exist_ok=True)
    for filename, schema in (("inbound.db", INBOUND_SCHEMA), ("outbound.db", OUTBOUND_SCHEMA)):
        db_path = base / filename
        db = sqlite3.connect(db_path)
        try:
            db.execute("PRAGMA journal_mode = DELETE")
            db.executescript(schema)
            db.commit()
        finally:
            db.close()


def write_session_routing(con: sqlite3.Connection, agent_group_id: str, session_id: str) -> None:
    row = con.execute(
        """
        SELECT mg.channel_type, mg.platform_id, s.thread_id
        FROM sessions s
        LEFT JOIN messaging_groups mg ON mg.id = s.messaging_group_id
        WHERE s.id = ?
        """,
        (session_id,),
    ).fetchone()
    if not row:
        return
    db_path = SESSIONS_DIR / agent_group_id / session_id / "inbound.db"
    if not db_path.exists():
        init_session_folder(agent_group_id, session_id)
    db = sqlite3.connect(db_path)
    try:
        db.execute("PRAGMA journal_mode = DELETE")
        db.executescript(INBOUND_SCHEMA)
        db.execute(
            """
            INSERT INTO session_routing (id, channel_type, platform_id, thread_id)
            VALUES (1, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              channel_type = excluded.channel_type,
              platform_id = excluded.platform_id,
              thread_id = excluded.thread_id
            """,
            (row["channel_type"], row["platform_id"], row["thread_id"]),
        )
        db.commit()
    finally:
        db.close()


def refresh_destinations(con: sqlite3.Connection, agent_group_id: str, session_id: str) -> None:
    rows = con.execute(
        """
        SELECT ad.local_name, ad.target_type, ad.target_id,
               mg.name AS mg_name, mg.channel_type, mg.platform_id,
               ag.name AS ag_name, ag.id AS target_agent_id
        FROM agent_destinations ad
        LEFT JOIN messaging_groups mg ON ad.target_type = 'channel' AND mg.id = ad.target_id
        LEFT JOIN agent_groups ag ON ad.target_type = 'agent' AND ag.id = ad.target_id
        WHERE ad.agent_group_id = ?
        ORDER BY ad.local_name
        """,
        (agent_group_id,),
    ).fetchall()
    db_path = SESSIONS_DIR / agent_group_id / session_id / "inbound.db"
    if not db_path.exists():
        init_session_folder(agent_group_id, session_id)
    db = sqlite3.connect(db_path)
    try:
        db.execute("PRAGMA journal_mode = DELETE")
        db.executescript(INBOUND_SCHEMA)
        db.execute("DELETE FROM destinations")
        for row in rows:
            if row["target_type"] == "channel" and row["channel_type"] and row["platform_id"]:
                db.execute(
                    """
                    INSERT INTO destinations
                      (name, display_name, type, channel_type, platform_id, agent_group_id)
                    VALUES (?, ?, 'channel', ?, ?, NULL)
                    """,
                    (row["local_name"], row["mg_name"] or row["local_name"], row["channel_type"], row["platform_id"]),
                )
            elif row["target_type"] == "agent" and row["target_agent_id"]:
                db.execute(
                    """
                    INSERT INTO destinations
                      (name, display_name, type, channel_type, platform_id, agent_group_id)
                    VALUES (?, ?, 'agent', NULL, NULL, ?)
                    """,
                    (row["local_name"], row["ag_name"] or row["local_name"], row["target_agent_id"]),
                )
        db.commit()
    finally:
        db.close()


def ensure_routes(execute: bool) -> dict[str, Any]:
    now = iso_now()
    summary: dict[str, Any] = {"created_or_verified": [], "sessions_refreshed": 0}
    with connect() as con:
        ids = agent_ids(con)
        if not execute:
            summary["created_or_verified"].extend(
                [
                    "telegram:vektor:2057822644 messaging group",
                    "Aydar user + Vektor membership",
                    "Vektor destination aydar",
                    "Radar destination vektor",
                ]
            )
            return summary

        ensure_user(con, "telegram:2057822644", "telegram", "Aydar", now)
        con.execute(
            """
            INSERT OR IGNORE INTO agent_group_members (user_id, agent_group_id, added_by, added_at)
            VALUES ('telegram:2057822644', ?, 'telegram:121776087', ?)
            """,
            (ids["vektor"], now),
        )
        mg_id = get_or_create_messaging_group(
            con,
            platform_id="telegram:vektor:2057822644",
            name="Aydar - Vektor",
            is_group=0,
            now=now,
        )
        ensure_wiring(con, messaging_group_id=mg_id, agent_group_id=ids["vektor"], local_name="aydar", now=now)
        session_id = ensure_session(con, agent_group_id=ids["vektor"], messaging_group_id=mg_id, now=now)
        summary["created_or_verified"].append(f"Aydar Vektor DM: {mg_id} / {session_id}")

        # Agent-to-agent names used by migrated prompts that previously called sessions_send.
        ensure_destination(
            con,
            agent_group_id=ids["radar"],
            local_name="vektor",
            target_type="agent",
            target_id=ids["vektor"],
            now=now,
        )
        ensure_destination(
            con,
            agent_group_id=ids["main"],
            local_name="radar",
            target_type="agent",
            target_id=ids["radar"],
            now=now,
        )
        ensure_destination(
            con,
            agent_group_id=ids["main"],
            local_name="vektor",
            target_type="agent",
            target_id=ids["vektor"],
            now=now,
        )
        con.commit()

        sessions = con.execute(
            "SELECT id, agent_group_id FROM sessions WHERE status = 'active'"
        ).fetchall()
        for sess in sessions:
            init_session_folder(sess["agent_group_id"], sess["id"])
            write_session_routing(con, sess["agent_group_id"], sess["id"])
            refresh_destinations(con, sess["agent_group_id"], sess["id"])
            summary["sessions_refreshed"] += 1
    return summary


def normalize_delivery_to(agent_id: str, delivery_to: str | None) -> str:
    if not delivery_to:
        return "121776087"
    return str(delivery_to).strip().removeprefix("telegram:")


def platform_id_for_job(agent_id: str, delivery_to: str | None, mode: str | None) -> str:
    to = normalize_delivery_to(agent_id, delivery_to)
    if to.startswith("-100"):
        return f"telegram:{to}"
    if agent_id == "main":
        return f"telegram:aura:{to}"
    return f"telegram:{agent_id}:{to}"


def find_session_for_platform(con: sqlite3.Connection, agent_group_id: str, platform_id: str) -> sqlite3.Row | None:
    return con.execute(
        """
        SELECT s.id AS session_id, mg.id AS messaging_group_id, mg.channel_type, mg.platform_id
        FROM messaging_groups mg
        JOIN sessions s ON s.messaging_group_id = mg.id
        WHERE s.agent_group_id = ?
          AND mg.channel_type = 'telegram'
          AND mg.platform_id = ?
          AND s.status = 'active'
        ORDER BY s.created_at DESC
        LIMIT 1
        """,
        (agent_group_id, platform_id),
    ).fetchone()


def session_for_job(con: sqlite3.Connection, ids: dict[str, str], job: dict[str, Any], allow_planned: bool) -> sqlite3.Row | dict[str, str]:
    agent_id = job.get("agentId")
    if agent_id not in ids:
        raise RuntimeError(f"unsupported OpenClaw agentId={agent_id!r} for job {job.get('id')}")
    agent_group_id = ids[agent_id]
    delivery = job.get("delivery") or {}
    platform_id = platform_id_for_job(agent_id, delivery.get("to"), delivery.get("mode"))
    row = find_session_for_platform(con, agent_group_id, platform_id)
    if row:
        return row

    if allow_planned and platform_id == "telegram:vektor:2057822644":
        return {
            "session_id": "planned-aydar-vektor-session",
            "messaging_group_id": "planned-aydar-vektor-mg",
            "channel_type": "telegram",
            "platform_id": platform_id,
        }

    # If delivery is disabled, use the existing Danis DM for that agent.
    if delivery.get("mode") == "none":
        fallback = platform_id_for_job(agent_id, "121776087", "announce")
        row = find_session_for_platform(con, agent_group_id, fallback)
        if row:
            return row

    # Last chance for main/Aura jobs that deliver to Danis' default historical DM.
    if agent_id == "main" and normalize_delivery_to(agent_id, delivery.get("to")) == "121776087":
        row = find_session_for_platform(con, agent_group_id, "telegram:aura:121776087")
        if row:
            return row

    raise RuntimeError(f"no NanoClaw session for job {job.get('id')} platform_id={platform_id}")


def cron_shift_dow(expr: str, delta_days: int) -> str:
    if delta_days == 0:
        return expr
    parts = expr.split()
    if len(parts) != 5:
        return expr
    dow = parts[4]
    if dow == "*":
        return expr

    def shift_one(token: str) -> str:
        if token == "*":
            return token
        if "-" in token and "/" not in token:
            start_s, end_s = token.split("-", 1)
            if start_s.isdigit() and end_s.isdigit():
                start = (int(start_s) + delta_days) % 7
                end = (int(end_s) + delta_days) % 7
                return f"{start}-{end}"
        if token.isdigit():
            return str((int(token) + delta_days) % 7)
        return token

    parts[4] = ",".join(shift_one(t) for t in dow.split(","))
    return " ".join(parts)


def cron_shift_dom(expr: str, delta_days: int) -> str:
    if delta_days == 0:
        return expr
    parts = expr.split()
    if len(parts) != 5:
        return expr
    dom = parts[2]
    if not dom.isdigit():
        return expr
    shifted = int(dom) + delta_days
    if shifted < 1:
        return expr
    parts[2] = str(shifted)
    return " ".join(parts)


def convert_cron_to_utc(expr: str, source_tz: str | None) -> tuple[str, list[str]]:
    notes: list[str] = []
    if source_tz in (None, "", "UTC", "Etc/UTC"):
        return expr, notes
    if source_tz != "Asia/Yekaterinburg":
        notes.append(f"unconverted timezone {source_tz}; using original cron")
        return expr, notes

    parts = expr.split()
    if len(parts) != 5 or not parts[1].isdigit():
        notes.append("complex cron timezone conversion skipped")
        return expr, notes

    hour = int(parts[1])
    shifted = hour - 5
    delta_days = 0
    if shifted < 0:
        shifted += 24
        delta_days = -1
    elif shifted > 23:
        shifted -= 24
        delta_days = 1
    parts[1] = str(shifted)
    converted = " ".join(parts)
    converted = cron_shift_dow(converted, delta_days)
    converted = cron_shift_dom(converted, delta_days)
    if converted != expr:
        notes.append(f"cron {source_tz}->UTC: {expr} -> {converted}")
    return converted, notes


def process_after_from_state(job: dict[str, Any], state: dict[str, Any]) -> str:
    state_jobs = state.get("jobs", {})
    job_state = state_jobs.get(job["id"], {}).get("state", {}) if isinstance(state_jobs, dict) else {}
    next_ms = job_state.get("nextRunAtMs")
    if isinstance(next_ms, (int, float)):
        return dt.datetime.fromtimestamp(next_ms / 1000, tz=dt.UTC).isoformat().replace("+00:00", "Z")

    schedule = job.get("schedule") or {}
    if schedule.get("kind") == "at" and schedule.get("at"):
        return schedule["at"]

    return (utc_now() + dt.timedelta(minutes=10)).isoformat().replace("+00:00", "Z")


def recurrence_for_job(job: dict[str, Any], process_after: str) -> tuple[str | None, list[str]]:
    schedule = job.get("schedule") or {}
    kind = schedule.get("kind")
    if kind == "cron":
        return convert_cron_to_utc(schedule.get("expr", ""), schedule.get("tz"))
    if kind == "at":
        return None, []
    if kind == "every":
        every_ms = int(schedule.get("everyMs") or 0)
        if every_ms <= 0:
            return None, ["invalid everyMs; migrated as one-shot"]
        if every_ms >= 45 * 24 * 3600 * 1000:
            first = dt.datetime.fromisoformat(process_after.replace("Z", "+00:00"))
            recurrence = f"{first.minute} {first.hour} {first.day} 1-12/2 *"
            return recurrence, [f"everyMs={every_ms} approximated as cron {recurrence}"]
        if every_ms % (24 * 3600 * 1000) == 0:
            days = every_ms // (24 * 3600 * 1000)
            first = dt.datetime.fromisoformat(process_after.replace("Z", "+00:00"))
            recurrence = f"{first.minute} {first.hour} */{days} * *"
            return recurrence, [f"everyMs={every_ms} approximated as cron {recurrence}"]
        return None, [f"everyMs={every_ms} unsupported by NanoClaw cron recurrence; migrated as one-shot"]
    return None, [f"unsupported schedule kind={kind}; migrated as one-shot"]


def payload_text(job: dict[str, Any]) -> str:
    payload = job.get("payload") or {}
    text = payload.get("message") or payload.get("text") or payload.get("prompt")
    if not text:
        text = json.dumps(payload, ensure_ascii=False)
    text = str(text)
    title = job.get("name") or job.get("title") or job.get("id")
    prefix = MIGRATION_PREFIX
    return f"{prefix}\n[OpenClaw job: {title} / {job.get('id')}]\n\n{text}"


def next_even_seq(db: sqlite3.Connection) -> int:
    row = db.execute("SELECT COALESCE(MAX(seq), 0) AS m FROM messages_in").fetchone()
    max_seq = int(row[0] or 0)
    if max_seq < 2:
        return 2
    return max_seq + 2 - (max_seq % 2)


def insert_or_update_task(
    db: sqlite3.Connection,
    *,
    task_id: str,
    process_after: str,
    recurrence: str | None,
    platform_id: str | None,
    channel_type: str | None,
    prompt: str,
) -> str:
    existing = db.execute(
        "SELECT id FROM messages_in WHERE (id = ? OR series_id = ?) AND kind = 'task' AND status IN ('pending', 'paused')",
        (task_id, task_id),
    ).fetchone()
    content = json.dumps({"prompt": prompt, "script": None}, ensure_ascii=False)
    if existing:
        db.execute(
            """
            UPDATE messages_in
            SET process_after = ?, recurrence = ?, platform_id = ?, channel_type = ?, thread_id = NULL, content = ?
            WHERE id = ?
            """,
            (process_after, recurrence, platform_id, channel_type, content, existing[0]),
        )
        return "updated"
    db.execute(
        """
        INSERT INTO messages_in
          (id, seq, kind, timestamp, status, process_after, recurrence, series_id, tries,
           trigger, platform_id, channel_type, thread_id, content)
        VALUES (?, ?, 'task', datetime('now'), 'pending', ?, ?, ?, 0, 1, ?, ?, NULL, ?)
        """,
        (task_id, next_even_seq(db), process_after, recurrence, task_id, platform_id, channel_type, content),
    )
    return "inserted"


def migrate_tasks(execute: bool) -> dict[str, Any]:
    jobs_root = load_json(OPENCLAW_JOBS)
    state = load_json(OPENCLAW_JOBS_STATE) if OPENCLAW_JOBS_STATE.exists() else {"jobs": {}}
    jobs = [job for job in jobs_root.get("jobs", []) if job.get("enabled") is True]
    migrated: list[dict[str, Any]] = []
    errors: list[str] = []
    notes: list[str] = []
    by_session: dict[str, int] = {}
    by_action = {"inserted": 0, "updated": 0, "dry-run": 0}

    with connect() as con:
        ids = agent_ids(con)
        for job in jobs:
            try:
                session_row = session_for_job(con, ids, job, allow_planned=not execute)
                process_after = process_after_from_state(job, state)
                recurrence, rec_notes = recurrence_for_job(job, process_after)
                notes.extend([f"{job['id']}: {note}" for note in rec_notes])
                task_id = f"openclaw-{job['id']}"
                prompt = payload_text(job)
                session_id = session_row["session_id"]
                agent_group_id = ids[job["agentId"]]
                by_session[session_id] = by_session.get(session_id, 0) + 1

                if execute:
                    init_session_folder(agent_group_id, session_id)
                    write_session_routing(con, agent_group_id, session_id)
                    refresh_destinations(con, agent_group_id, session_id)
                    db_path = SESSIONS_DIR / agent_group_id / session_id / "inbound.db"
                    db = sqlite3.connect(db_path)
                    try:
                        db.execute("PRAGMA journal_mode = DELETE")
                        db.executescript(INBOUND_SCHEMA)
                        action = insert_or_update_task(
                            db,
                            task_id=task_id,
                            process_after=process_after,
                            recurrence=recurrence,
                            platform_id=session_row["platform_id"],
                            channel_type=session_row["channel_type"],
                            prompt=prompt,
                        )
                        db.commit()
                    finally:
                        db.close()
                    by_action[action] = by_action.get(action, 0) + 1
                else:
                    action = "dry-run"
                    by_action[action] = by_action.get(action, 0) + 1

                migrated.append(
                    {
                        "id": job["id"],
                        "name": job.get("name"),
                        "agentId": job.get("agentId"),
                        "session_id": session_id,
                        "process_after": process_after,
                        "recurrence": recurrence,
                        "action": action,
                    }
                )
            except Exception as exc:  # noqa: BLE001 - collect all migration errors
                errors.append(f"{job.get('id')}: {exc}")

    return {
        "enabled_jobs": len(jobs),
        "migrated": len(migrated),
        "actions": by_action,
        "by_session": by_session,
        "errors": errors,
        "notes": notes,
        "jobs": migrated,
    }


def transfer_tokens(execute: bool) -> dict[str, Any]:
    source_keys = {
        "TELEGRAM_BOT_TOKEN_AURA": "TG_BOT_TOKEN_AURA",
        "TELEGRAM_BOT_TOKEN_RADAR": "TG_BOT_TOKEN_RADAR",
        "TELEGRAM_BOT_TOKEN_VEKTOR": "TG_BOT_TOKEN_VEKTOR",
    }
    env = docker_env(DOCKER_CONTAINER)
    updates = {dst: env[src] for dst, src in source_keys.items() if env.get(src)}
    if len(updates) != len(source_keys):
        missing = sorted(set(source_keys) - set(updates))
        raise RuntimeError(f"missing source tokens in {DOCKER_CONTAINER}: {', '.join(missing)}")

    _, current = read_env(ENV_FILE)
    changed = [k for k, v in updates.items() if current.get(k) != v]
    result = {
        "source_container": DOCKER_CONTAINER,
        "keys_considered": sorted(source_keys),
        "keys_changed": sorted(changed),
        "fingerprints": {k: token_fingerprint(v) for k, v in updates.items()},
        "ceo_touched": False,
    }
    if execute and changed:
        update_env_values(ENV_FILE, updates)
    return result


def run_cutover(execute: bool) -> int:
    started = iso_now()
    run_dir = DATA_DIR / "cutover" / f"openclaw-cutover-{started.replace(':', '').replace('Z', 'Z')}"
    manifest: dict[str, Any] = {
        "started_at": started,
        "execute": execute,
        "repo": str(REPO),
        "openclaw_root": str(OPENCLAW_ROOT),
    }

    if execute:
        manifest["backups"] = backup_state(run_dir)
    else:
        run_dir.mkdir(parents=True, exist_ok=True)

    manifest["routes"] = ensure_routes(execute)
    manifest["tokens"] = transfer_tokens(execute)
    manifest["tasks"] = migrate_tasks(execute)
    manifest["finished_at"] = iso_now()
    save_json(run_dir / "manifest.json", manifest)

    print(json.dumps({
        "execute": execute,
        "manifest": str(run_dir / "manifest.json"),
        "routes": manifest["routes"],
        "tokens": {
            "keys_changed": manifest["tokens"]["keys_changed"],
            "ceo_touched": manifest["tokens"]["ceo_touched"],
        },
        "tasks": {
            "enabled_jobs": manifest["tasks"]["enabled_jobs"],
            "migrated": manifest["tasks"]["migrated"],
            "actions": manifest["tasks"]["actions"],
            "errors": manifest["tasks"]["errors"],
            "notes_count": len(manifest["tasks"]["notes"]),
        },
    }, ensure_ascii=False, indent=2))

    return 1 if manifest["tasks"]["errors"] else 0


def main() -> int:
    parser = argparse.ArgumentParser(description="OpenClaw -> NanoClaw cutover helper")
    parser.add_argument("--execute", action="store_true", help="apply changes; default is dry-run")
    args = parser.parse_args()
    return run_cutover(args.execute)


if __name__ == "__main__":
    sys.exit(main())
