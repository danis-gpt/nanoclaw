#!/usr/bin/env python3
"""Refresh filtered OpenClaw memory into NanoClaw agent imports.

Default mode is a dry run. Use --apply to copy files and rewrite manifests and
daily-memory indexes. The copier is intentionally additive: it updates files it
owns, but it never deletes target files.
"""

from __future__ import annotations

import argparse
import fnmatch
import hashlib
import json
import os
import re
import shutil
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable


REPO_ROOT = Path(__file__).resolve().parents[1]

TOP_LEVEL_FILES = {
    "AGENTS.md",
    "HEARTBEAT.md",
    "HONESTY-RULES.md",
    "IDENTITY.md",
    "MEMORY.md",
    "SECURITY-RULES.md",
    "SOUL.md",
    "TOOLS.md",
    "USER.md",
}

EXCLUDE_DIRS = {
    ".git",
    ".openclaw",
    ".pi",
    ".venv",
    ".venv_pdf",
    "__pycache__",
    "artifacts",
    "cache",
    "node_modules",
    "pdf_extract",
    "tmp",
}

EXCLUDE_FILE_GLOBS = [
    ".*",
    ".env",
    "*.db",
    "*.db-*",
    "*.log",
    "*.pyc",
    "*.sqlite",
    "*.sqlite3",
    ".buildin_config",
    ".tmp_*",
    "tmp_*",
    "q*.json",
]

TEXT_SUFFIXES = {
    ".csv",
    ".json",
    ".js",
    ".md",
    ".py",
    ".sh",
    ".sql",
    ".toml",
    ".ts",
    ".txt",
    ".yaml",
    ".yml",
}

MAX_TEXT_BYTES = 5 * 1024 * 1024

SECRET_PATTERNS = [
    re.compile(r"\b\d{7,12}:[A-Za-z0-9_-]{25,}\b"),
    re.compile(r"\bsk-[A-Za-z0-9_-]{20,}\b"),
    re.compile(r"\bgh[pousr]_[A-Za-z0-9_]{20,}\b"),
    re.compile(
        r"(?i)\b(access[_-]?token|api[_-]?key|bot[_-]?token|password|refresh[_-]?token|secret)\b"
        r"(\s*[:=]\s*)([\"']?)[^\s\"']{8,}([\"']?)"
    ),
]

DATE_FILE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}\.md$")


@dataclass(frozen=True)
class AgentSource:
    folder: str
    title: str
    source: Path
    include_dirs: tuple[str, ...]


AGENTS: dict[str, AgentSource] = {
    "aura": AgentSource(
        folder="aura",
        title="Аура",
        source=Path("/home/ubuntu/.openclaw/workspace"),
        include_dirs=("memory", "vault", "projects/analytics", "projects/itlsmart", "references", "research"),
    ),
    "radar": AgentSource(
        folder="radar",
        title="Радар",
        source=Path("/home/ubuntu/.openclaw/workspace-radar"),
        include_dirs=("memory", "vault", "docs", "reports", "data", "projects", "references"),
    ),
    "vektor": AgentSource(
        folder="vektor",
        title="Вектор",
        source=Path("/home/ubuntu/.openclaw/workspace-vektor"),
        include_dirs=("memory", "vault", "templates"),
    ),
}


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def rel_posix(path: Path) -> str:
    return path.as_posix()


def is_inside(rel: Path, include_dir: str) -> bool:
    rel_parts = rel.parts
    include_parts = Path(include_dir).parts
    return rel_parts[: len(include_parts)] == include_parts


def excluded(path: Path, rel: Path) -> str | None:
    for part in rel.parts:
        if part in EXCLUDE_DIRS or part.startswith(".venv"):
            return f"excluded dir: {part}"
    name = path.name
    for pattern in EXCLUDE_FILE_GLOBS:
        if fnmatch.fnmatch(name, pattern):
            return f"excluded file: {pattern}"
    return None


def included(agent: AgentSource, rel: Path) -> bool:
    if len(rel.parts) == 1 and rel.name in TOP_LEVEL_FILES:
        return True
    if len(rel.parts) == 1 and rel.suffix.lower() in {".md", ".txt", ".json"}:
        return True
    return any(is_inside(rel, include_dir) for include_dir in agent.include_dirs)


def looks_binary(data: bytes) -> bool:
    return b"\0" in data[:4096]


def redact_text(text: str) -> tuple[str, int]:
    redactions = 0
    for pattern in SECRET_PATTERNS:
        def replace(match: re.Match[str]) -> str:
            nonlocal redactions
            redactions += 1
            if len(match.groups()) >= 4:
                return f"{match.group(1)}{match.group(2)}{match.group(3)}__REDACTED__{match.group(4)}"
            return "__REDACTED_SECRET__"

        text = pattern.sub(replace, text)
    return text, redactions


def hash_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def iter_source_files(agent: AgentSource) -> Iterable[Path]:
    for root, dirs, files in os.walk(agent.source):
        root_path = Path(root)
        rel_root = root_path.relative_to(agent.source)
        dirs[:] = [
            d
            for d in dirs
            if excluded(root_path / d, rel_root / d) is None
        ]
        for file_name in files:
            path = root_path / file_name
            rel = path.relative_to(agent.source)
            if excluded(path, rel):
                continue
            if included(agent, rel):
                yield path


def preview(text: str, max_chars: int = 260) -> str:
    lines = []
    for line in text.splitlines():
        clean = line.strip(" #-\t")
        if not clean or clean.startswith("Источник:") or clean.startswith("Source:"):
            continue
        lines.append(clean)
        if len(" ".join(lines)) >= max_chars:
            break
    joined = " ".join(lines)
    return joined[:max_chars].rstrip()


def daily_index(agent: AgentSource, stats: dict[str, object], manifest_name: str) -> str:
    memory_dir = agent.source / "memory"
    daily_files = sorted(memory_dir.glob("*.md")) if memory_dir.exists() else []
    daily_files = [p for p in daily_files if DATE_FILE_RE.match(p.name)]
    service_files = sorted(
        p.name
        for p in memory_dir.glob("*")
        if p.is_file() and not DATE_FILE_RE.match(p.name)
    ) if memory_dir.exists() else []

    latest = daily_files[-7:]
    lines = [
        f"# Daily Memory Index — {agent.title}",
        "",
        f"Источник: `{memory_dir}`.",
        "",
        (
            f"Найдено {len(daily_files)} датированных top-level daily memory `.md` файлов. "
            f"Последняя дата: `{daily_files[-1].stem if daily_files else 'нет'}`."
        ),
        "",
        (
            "Фильтрованный импорт OpenClaw лежит в `openclaw-import/`. "
            f"Manifest свежести: `openclaw-import/{manifest_name}`."
        ),
        "",
        "Свежий контекст:",
        "",
    ]

    if latest:
        for path in latest:
            try:
                text = path.read_text(encoding="utf-8", errors="replace")
            except OSError:
                text = ""
            summary = preview(text) or "см. исходный daily-файл"
            lines.append(f"- {path.stem}: {summary}")
    else:
        lines.append("- Daily memory files не найдены.")

    if service_files:
        lines.extend(["", "Важные служебные файлы OpenClaw memory:", ""])
        for name in service_files[:20]:
            lines.append(f"- `{name}`")

    lines.extend([
        "",
        "Freshness:",
        "",
        f"- last refresh: `{stats['synced_at']}`",
        f"- copied/updated files: `{stats['copied_files']}`",
        f"- unchanged files: `{stats['unchanged_files']}`",
        f"- skipped files: `{stats['skipped_files']}`",
        f"- redactions: `{stats['redactions']}`",
        "",
        "Для быстрых ответов используй свежую сводку выше. Если нужен точный старый контекст, ищи в `openclaw-import/`.",
        "",
    ])
    return "\n".join(lines)


def refresh_agent(agent: AgentSource, *, apply: bool, verbose: bool) -> dict[str, object]:
    target = REPO_ROOT / "groups" / agent.folder / "openclaw-import"
    index_path = REPO_ROOT / "groups" / agent.folder / "daily-memory-index.md"
    manifest_name = ".sync-manifest.json"

    stats: dict[str, object] = {
        "agent": agent.folder,
        "title": agent.title,
        "source": str(agent.source),
        "target": str(target),
        "synced_at": utc_now(),
        "mode": "apply" if apply else "dry-run",
        "copied_files": 0,
        "unchanged_files": 0,
        "skipped_files": 0,
        "redactions": 0,
        "source_max_mtime": None,
        "latest_daily_memory": None,
        "skipped": [],
    }

    if not agent.source.exists():
        raise FileNotFoundError(f"source does not exist: {agent.source}")

    source_max_mtime = 0.0
    for source_path in iter_source_files(agent):
        rel = source_path.relative_to(agent.source)
        source_max_mtime = max(source_max_mtime, source_path.stat().st_mtime)

        if source_path.stat().st_size > MAX_TEXT_BYTES:
            stats["skipped_files"] = int(stats["skipped_files"]) + 1
            cast_skipped = stats["skipped"]
            assert isinstance(cast_skipped, list)
            cast_skipped.append({"path": rel_posix(rel), "reason": "file too large for memory import"})
            continue

        raw = source_path.read_bytes()
        if source_path.suffix.lower() not in TEXT_SUFFIXES or looks_binary(raw):
            stats["skipped_files"] = int(stats["skipped_files"]) + 1
            cast_skipped = stats["skipped"]
            assert isinstance(cast_skipped, list)
            cast_skipped.append({"path": rel_posix(rel), "reason": "non-text file skipped"})
            continue

        text = raw.decode("utf-8", errors="replace")
        redacted, redactions = redact_text(text)
        stats["redactions"] = int(stats["redactions"]) + redactions

        target_path = target / rel
        existing_hash = None
        if target_path.exists():
            try:
                existing_text = target_path.read_bytes().decode("utf-8", errors="replace")
                existing_hash = hash_text(existing_text)
            except OSError:
                existing_hash = None

        if existing_hash == hash_text(redacted):
            stats["unchanged_files"] = int(stats["unchanged_files"]) + 1
            continue

        stats["copied_files"] = int(stats["copied_files"]) + 1
        if verbose or not apply:
            print(f"{'COPY' if apply else 'WOULD_COPY'} {agent.folder}: {rel_posix(rel)}")
        if apply:
            target_path.parent.mkdir(parents=True, exist_ok=True)
            target_path.write_text(redacted, encoding="utf-8")
            shutil.copystat(source_path, target_path, follow_symlinks=False)

    if source_max_mtime:
        stats["source_max_mtime"] = datetime.fromtimestamp(source_max_mtime, timezone.utc).isoformat()

    memory_dir = agent.source / "memory"
    daily = sorted(p.stem for p in memory_dir.glob("*.md") if DATE_FILE_RE.match(p.name)) if memory_dir.exists() else []
    stats["latest_daily_memory"] = daily[-1] if daily else None

    index_text = daily_index(agent, stats, manifest_name)
    if apply:
        target.mkdir(parents=True, exist_ok=True)
        (target / manifest_name).write_text(json.dumps(stats, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        index_path.write_text(index_text, encoding="utf-8")
    else:
        print(f"WOULD_WRITE {target / manifest_name}")
        print(f"WOULD_WRITE {index_path}")

    return stats


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--agent", choices=[*AGENTS.keys(), "all"], default="all")
    parser.add_argument("--apply", action="store_true", help="copy files and write manifests/indexes")
    parser.add_argument("--verbose", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    selected = AGENTS.values() if args.agent == "all" else [AGENTS[args.agent]]
    all_stats = []
    try:
        for agent in selected:
            all_stats.append(refresh_agent(agent, apply=args.apply, verbose=args.verbose))
    except Exception as exc:
        print(f"openclaw-memory-refresh failed: {exc}", file=sys.stderr)
        return 1

    print(json.dumps(all_stats, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
