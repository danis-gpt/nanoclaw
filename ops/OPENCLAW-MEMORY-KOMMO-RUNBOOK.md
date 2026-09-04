# OpenClaw Memory + Kommo Automation Runbook

## Active Scope

- Active agents: `aura`, `radar`, `vektor`.
- CEO is intentionally out of scope.
- Kommo access stays read-only for agents. The sync job updates the local KommoMCP database only.

## Cutover State

Applied on `2026-07-04T16:12:08Z`.

- Cutover manifest: `data/cutover/openclaw-cutover-2026-07-04T161208.485794Z/manifest.json`
- OpenClaw container: `dockclaw-dd` is stopped and has `restart=no`.
- NanoClaw service: `nanoclaw-v2-a69a3d76.service` is active.
- Telegram named aliases `aura`, `radar`, and `vektor` now use the former OpenClaw bot tokens. CEO was not copied.
- NanoClaw scheduled tasks: 47 enabled OpenClaw jobs were migrated as pending `openclaw-*` task series across 6 NanoClaw sessions.
- Aydar Vektor route: `telegram:vektor:2057822644` -> `groups/vektor`.
- OpenClaw memory refresh timer is disabled after final apply refresh; Kommo timers remain enabled.

Rollback OpenClaw runtime:

```bash
cd /home/ubuntu/pr/nanoclaw1/nanoclaw-v2
cp data/cutover/openclaw-cutover-2026-07-04T161208.485794Z/nanoclaw.env .env
cp data/cutover/openclaw-cutover-2026-07-04T161208.485794Z/nanoclaw.v2.db data/v2.db
docker update --restart unless-stopped dockclaw-dd
docker start dockclaw-dd
systemctl --user restart nanoclaw-v2-a69a3d76.service
```

Keep Kommo on NanoClaw after rollback only if the rollback is Telegram-runtime-only.

## Memory Refresh

Run a dry run:

```bash
python3 ops/openclaw-memory-refresh.py --agent all
```

Apply refresh:

```bash
python3 ops/openclaw-memory-refresh.py --agent all --apply
```

Outputs per agent:

- `groups/<agent>/openclaw-import/.sync-manifest.json`
- `groups/<agent>/daily-memory-index.md`

Installed user timer:

```bash
systemctl --user list-timers 'nanoclaw-openclaw-memory-refresh*' --all --no-pager
systemctl --user status nanoclaw-openclaw-memory-refresh.service --no-pager
```

Disable after cutover when OpenClaw is no longer the source of truth:

```bash
systemctl --user disable --now nanoclaw-openclaw-memory-refresh.timer
```

## Kommo Freshness

Check freshness:

```bash
KOMMO_MCP_URL=http://172.21.0.2:8001/mcp python3 ops/kommo-sync-health.py freshness --max-age-hours 6
```

Trigger incremental sync and wait:

```bash
KOMMO_MCP_URL=http://172.21.0.2:8001/mcp python3 ops/kommo-sync-health.py sync --wait --max-age-hours 6
```

Agent CLI smoke test:

```bash
KOMMO_MCP_URL=http://172.21.0.2:8001/mcp python3 groups/radar/scripts/kommo-cli.py sql 'SELECT count(*) AS leads_count FROM leads;'
```

Installed user timers:

```bash
systemctl --user list-timers 'nanoclaw-kommo-*' --all --no-pager
systemctl --user status nanoclaw-kommo-incremental-sync.service --no-pager
```

## Notes

- `kommo-cli.py sql` strips a trailing semicolon before sending SQL to KommoMCP.
- Agent-facing Kommo commands should run `freshness --max-age-hours 6` before sales reports or recommendations.
- `openclaw-memory-refresh.py` never deletes target files; it updates the filtered memory subset and preserves legacy imports unless they are removed intentionally.
