# OpenClaw Migration State

## Progress

- [x] Phase 0: Discovery
- [x] Phase 1: Groups and Architecture
- [x] Phase 2: Settings from Config
- [x] Phase 3: Identity and Memory
- [x] Phase 4: Channel Credentials
- [x] Phase 5: Scheduled Tasks
- [x] Phase 6: MCP Servers and Tools
- [x] Phase 7: Final Verification

## Discovery

STATE_DIR=/home/ubuntu/.openclaw
OPENCLAW_CONTAINER=dockclaw-dd
OPENCLAW_CONTAINER_STATUS=running healthy
CONFIG_FOUND=true
CONFIG_TOP_KEYS=agents,auth,bindings,browser,channels,commands,cron,gateway,hooks,meta,models,plugins,secrets,session,tools,update,wizard
CONFIG_CHANNEL_KEYS=matrix,max,telegram
STATE_DIR_CONTENTS=agents,canvas,completions,credentials,cron,delivery-queue,devices,exec-approvals.json,extensions,flows,identity,lcm-files,lcm.db,lcm.db-shm,lcm.db-wal,locks,logs,matrix,media,memory,monitor,notebooklm,openclaw.json,openclaw.json.bak,openclaw.json.bak-20260417T045034Z,openclaw.json.bak-20260521T050941Z-aura-model-fix,openclaw.json.bak.1,openclaw.json.bak.2,openclaw.json.bak.3,openclaw.json.bak.4,openclaw.json.last-good,plugin-runtime-deps,plugins,qqbot,session-delivery-queue,subagents,tasks,telegram,update-check.json,watchdog-host.sh,watchdog.log,workspace,workspace-ceo,workspace-radar,workspace-vektor
CHANNELS=telegram(has_creds),matrix(has_creds),max(no_creds)
UNSUPPORTED_CHANNELS=matrix,max
WORKSPACE_DIR=/home/ubuntu/.openclaw/workspace
WORKSPACE_FILES=SOUL.md,USER.md,MEMORY.md,IDENTITY.md,TOOLS.md,HEARTBEAT.md,AGENTS.md
IDENTITY_NAME=Аура
AGENT_COUNT=3
AGENT_IDS=main,radar,vektor
AGENTS=main:Аура:/home/node/.openclaw/workspace|radar:Радар:/home/node/.openclaw/workspace-radar|vektor:Вектор:/home/node/.openclaw/workspace-vektor
OPENCLAW_BINDINGS=telegram:aura->main|telegram:radar->radar|telegram:vektor->vektor|telegram:ceo->ceo_missing_from_agents_list|matrix:default->main|matrix:radar->radar
GROUP_COUNT=3
GROUPS=telegram:-1003273789043(telegram)=>tg:-1003273789043|telegram:-1003713770638(telegram)=>tg:-1003713770638|max:*(*)=>max:*
CONFIG_TELEGRAM_AURA_GROUPS=-1003777309478,-1003762184353,-1003767771826,-1003713770638,-1003273789043,-1003706308007,-1003753318969,-1003652843703
CURRENT_NANOCLAW_GROUPS=Брама:dm-with-danis:telegram:telegram:121776087
DAILY_MEMORY_FILES=78 date-stamped top-level aura files; plus non-daily and nested memory files
SKILL_COUNT=13
SKILLS=agent-doctor,agentic-business-analysis,buildin-publish,customer-journey-mapper,employee-onboarding,financial-forecast,nbp-skill,negotiation-chris-voss,notebooklm,sales-pitch-generator,skill-architect,update-openai-token,youtube-transcribe
CONFIG_PLUGINS=telegram,matrix,lossless-claw,max,browser,openai,google,zai
CONFIG_PLUGIN_COUNT=8
CRON_JOBS=124
MCP_SERVERS=none

## Decisions

group_model=separate
assistant_name=Аура
main_group=aura
rename=2026-05-23 user requested Аура-2 -> Аура and folder aura-2 -> aura; DB, filesystem, env key, Telegram alias, and local instructions updated.

## Registered Groups

| folder | agent | jid | channel | is_main |
|---|---|---|---|---|
| aura | Аура | telegram:-1003777309478 | telegram | false |
| aura | Аура | telegram:-1003762184353 | telegram | false |
| aura | Аура | telegram:-1003767771826 | telegram | false |
| aura | Аура | telegram:-1003713770638 | telegram | false |
| aura | Аура | telegram:-1003273789043 | telegram | false |
| aura | Аура | telegram:-1003706308007 | telegram | false |
| aura | Аура | telegram:-1003753318969 | telegram | false |
| aura | Аура | telegram:-1003652843703 | telegram | false |

Agent groups created without channel wiring yet:

| folder | agent | source |
|---|---|---|
| radar | Радар | OpenClaw agent radar |
| vektor | Вектор | OpenClaw agent vektor |

## Settings Migrated

Phase 2 inspected and Telegram sender/access settings migrated.
timezone=OpenClaw not set; NanoClaw .env currently TZ=UTC
container_timeout=OpenClaw not set; NanoClaw default remains 1800000ms
anthropic_credential=OpenClaw auth-profiles contain anthropic token; not copied
codex_credentials=OpenClaw auth-profiles contain multiple openai-codex oauth access tokens; not copied
zai_credential=OpenClaw auth-profiles contain zai api_key; not copied
sender_allowlist=created /home/ubuntu/.config/nanoclaw/sender-allowlist.json for Telegram only
telegram_allowlists=aura allowFrom 121776087, aura group -1003273789043 allowFrom *, radar allowFrom 121776087, vektor allowFrom 2057822644+121776087
telegram_group_policy=8 aura Telegram groups set unknown_sender_policy=public to match OpenClaw allowed group behavior with requireMention=false
members_added=telegram:121776087 to aura/radar/vektor; telegram:2057822644 to vektor
unsupported_channel_allowlists=matrix allowFrom @danis/@aura/@radar, max allowFrom 7097342

## Identity & Memory

Created:
- groups/aura/CLAUDE.local.md
- groups/aura/identity.md
- groups/aura/soul.md
- groups/aura/user-context.md
- groups/aura/memories.md
- groups/aura/daily-memory-index.md
- groups/radar/CLAUDE.local.md
- groups/radar/identity.md
- groups/radar/soul.md
- groups/radar/user-context.md
- groups/radar/daily-memory-index.md
- groups/vektor/CLAUDE.local.md
- groups/vektor/identity.md
- groups/vektor/soul.md
- groups/vektor/user-context.md
- groups/vektor/daily-memory-index.md

Approach: summarized core OpenClaw identity/memory into NanoClaw group files, then copied raw OpenClaw workspace context into per-agent `openclaw-import/` directories.
Raw imports:
- aura source /home/ubuntu/.openclaw/workspace -> groups/aura/openclaw-import, size about 1024M, files 1984; includes memory/vault/projects/buildin/research/references/scripts/skills/tg-export032026/veda-company
- radar source /home/ubuntu/.openclaw/workspace-radar -> groups/radar/openclaw-import, size about 59M, files 186; includes memory/vault/projects/reports/docs/references/scripts/skills/data
- vektor source /home/ubuntu/.openclaw/workspace-vektor -> groups/vektor/openclaw-import, size about 812K, files 160; includes memory/vault/templates
Import exclusions: .git, node_modules, .venv*, .openclaw, .pi, tmp, cache, __pycache__, .env, .buildin_config, *.pyc.
Secret hygiene: post-copy scan found token-like strings in three aura import files; imported copies were redacted to `[REDACTED_*]` values. Source OpenClaw files were not modified.
Raw session logs were not imported as memory unless they were already present inside the copied workspace exports.

## Channel Credentials

Phase 4 inspected and new Telegram credentials written.
Current NanoClaw active TELEGRAM_BOT_TOKEN=brama_agentdd_bot (Брама).
NanoClaw telegram adapter now supports multiple active Telegram bot tokens behind one logical `telegram` channel.
OpenClaw Telegram credentials are present in dockclaw-dd env:
- TG_BOT_TOKEN_AURA -> aura_agentdd_bot (АУРА)
- TG_BOT_TOKEN_RADAR -> radar_agentdd_bot (Радар)
- TG_BOT_TOKEN_VEKTOR -> vector_agentdd_bot (Вектор / помощник Айдара)
- TG_BOT_TOKEN_CEO -> ceo_clinicdd_bot (Бот Даниса / Клиника Реабилитации)
Multi-bot implementation details:
- Existing TELEGRAM_BOT_TOKEN remains the default/Брама bot.
- New supported env keys: TELEGRAM_BOT_TOKEN_AURA, TELEGRAM_BOT_TOKEN_RADAR, TELEGRAM_BOT_TOKEN_VEKTOR.
- Outbound Telegram delivery picks the bot by the destination messaging group's wired agent folder.
- For aura/radar/vektor destinations, delivery refuses to fall back to the default bot when the specific token is absent.
- Non-default bot DMs are scoped as telegram:<bot-alias>:<chatId> to avoid colliding with Брама DMs.
- Project built after code change; Podman services not restarted yet because new tokens are still pending.
New NanoClaw Telegram tokens:
- TELEGRAM_BOT_TOKEN_AURA written and verified by getMe as @aura_nanodd_bot
- TELEGRAM_BOT_TOKEN_RADAR written and verified by getMe as @radar_nanodd_bot
- TELEGRAM_BOT_TOKEN_VEKTOR written and verified by getMe as @vector_nanodd_bot
Service restart: nanoclaw-v2-a69a3d76.service restarted after writing tokens.
Runtime verification: Telegram bot bridges started for default, aura, radar, vektor; NanoClaw running.
Aura DM verification: @aura_nanodd_bot received DM from telegram:121776087, auto-created scoped messaging group telegram:aura:121776087, registration was approved, session sess-1779489105901-jr6gav started for Аура, and reply delivered successfully.
Aura group access check: @aura_nanodd_bot has access to -1003713770638 (Автоматизация - Аура); the other 7 migrated Aura groups still returned "chat not found" at last check.
Next credential step: add @aura_nanodd_bot to the remaining Aura Telegram groups, then re-check group access and Telegram delivery. Radar/Vektor group or DM wiring still needs to be registered after deciding target chats.

Radar/Vektor DM wiring:
- Created scoped DM messaging group telegram:radar:121776087 -> Радар, is_group=0, engage pattern '.', shared session.
- Created scoped DM messaging group telegram:vektor:121776087 -> Вектор, is_group=0, engage pattern '.', shared session.
- Agent destinations were created for both DM targets.
- Direct Telegram API sendMessage to telegram:121776087 succeeded for @radar_nanodd_bot and @vector_nanodd_bot.
- Vektor DM verification: user sent new DM to @vector_nanodd_bot, session sess-1779489477293-d3kmlj started for Вектор, reply delivered successfully.
- Radar DM verification: user sent new DM to @radar_nanodd_bot after wiring/test prompt, Radar replied successfully.

## Scheduled Tasks

Phase 5 audit started; no tasks inserted yet.
OpenClaw cron source=/home/ubuntu/.openclaw/cron/jobs.json
OpenClaw jobs total=124 enabled=77 disabled=47
enabled_by_agent=main:12,radar:9,vektor:56
enabled_schedule_kinds=cron:25,at:50,every:2
enabled_delivery_modes=announce:72,none:5
enabled_future_once=50 past_once=0
current_nanoclaw_scheduling_model=tasks are session messages_in rows, not central scheduled_tasks table
requires_adaptation=openclaw_api_or_message_tool:28,scripts:17,external_data:12,aydar_target:53,no_delivery:5
likely_simple_or_lightly_adaptable=41
not_migrated_reason=needs user decision to avoid silently activating OpenClaw-specific jobs or sending scheduled messages to Айдар/Danis unexpectedly
vektor_getChat_2057822644=chat_not_found; @vector_nanodd_bot cannot DM Айдар yet
vektor_getChat_121776087=ok; @vector_nanodd_bot can DM Danis
notable_safe_candidates=Vektor one-off follow-up reminders; some recurring Vektor sales tips; selected Main digests after group targets are verified
notable_deferred=OpenClaw update checks, UserBot inbound watch, Buildin backup, Kommo/Buildin KPI reports, Radar scripts, tasks using sessions_send/message tool/accountId
decision=2026-05-23 Danis explicitly said not to migrate cron tasks
final_status=skipped_by_user_decision; no OpenClaw cron jobs inserted into NanoClaw

## Kommo / amoCRM Access Study

OpenClaw does not query Kommo directly from the agent. It uses Docker service `kommo-mcp`.
Containers:
- kommo-mcp image `kommo-mcp-kommo-mcp`, command `python -m kommo_mcp.mcp_http`, READONLY_MODE=true
- kommo-db image `postgres:15-alpine`, DB `kommo_mcp`, volume `kommo-mcp_kommo_db_data`
Networks:
- kommo-mcp is on `openclaw_default` as 172.19.0.4 and `kommo_net` as 172.21.0.2
- dockclaw-dd resolves `kommo-mcp` through `openclaw_default`
- NanoClaw Podman host container does not resolve `kommo-mcp`, but can reach http://172.19.0.4:8001 and http://172.21.0.2:8001
Credentials/env are in kommo-mcp container; sensitive values not copied.
KommoMCP env keys observed: KOMMO_SUBDOMAIN=itlsmart2, KOMMO_ACCESS_TOKEN, DATABASE_URL, GROQ_API_KEY, MEGAPBX_PROXY_TOKEN, READONLY_MODE=true.
OpenClaw CLI:
- `/home/ubuntu/.openclaw/workspace/scripts/kommo-cli.py`
- MCP_URL hardcoded to `http://kommo-mcp:8001/mcp`
- calls JSON-RPC `tools/call` with tool name and arguments
Primary agent guidance:
- Radar TOOLS.md says Kommo is read-only and should use `python3 scripts/kommo-cli.py <cmd>`
- For SQL, use `python3 scripts/kommo-cli.py sql "SELECT ..."` or stdin; do not use `raw kommo_sql '{"query":"..."}'` because escaping breaks
- `kommo_sql` allows SELECT/WITH/EXPLAIN only, auto LIMIT 100, max 1000
Kommo local PostgreSQL tables: users, pipelines, stages, leads, contacts, companies, tasks, notes, events, sync_status, plus relation tables/custom_fields.
Current counts checked: leads=6700, notes=65860, events=55855.
sync_status last completed at 2026-05-22 13:30 UTC for users/pipelines/leads/contacts/companies/tasks/notes/events.
Radar learned rules:
- calls may have created_by=0 because Asterisk integration; do not identify caller by created_by
- "Касания" = task_completed events by Aydar
- "Диалоги" is manual and not reliably automatable
NanoClaw migration implication:
- Current NanoClaw agent containers for aura/radar/vektor have python3 and `scripts/kommo-cli.py`.
- Kommo CLI defaults to OpenClaw Docker DNS first, then Docker bridge URLs `http://172.21.0.2:8001/mcp` and `http://172.19.0.4:8001/mcp`; can be overridden with `KOMMO_MCP_URL`.
- The CLI keeps the OpenClaw-compatible commands: ping, leads, lead, contacts, pipelines, users, analytics, search, report, insights, deals, tasks, alerts, events, entity, sql, raw.
- SQL guidance is written into aura/radar/vektor `CLAUDE.local.md`: use `python3 scripts/kommo-cli.py sql ...`, not `raw kommo_sql`.
- Verified from host and from all three per-agent Podman images; `SELECT count(*) AS leads_count FROM leads` returned 6700.

## MCP Servers and Tools

OpenClaw `MCP_SERVERS=none`; there was no external MCP server config to migrate into NanoClaw.
Installed NanoClaw Kommo CLI:
- source template: `ops/nanoclaw-kommo-cli.py`
- agent copies: `groups/aura/scripts/kommo-cli.py`, `groups/radar/scripts/kommo-cli.py`, `groups/vektor/scripts/kommo-cli.py`
Verified:
- `python3 -m py_compile` passed for all Kommo CLI copies.
- Host `python3 groups/radar/scripts/kommo-cli.py ping` returned account `itlsmart-2`.
- Host `python3 groups/radar/scripts/kommo-cli.py users` returned 4 Kommo users.
- Podman aura image SQL check returned leads_count=6700.
- Podman radar image ping returned status ok.
- Podman vektor image users returned 4 users.

## Per-Agent Python Toolchain

Requested for Аура, Радар, and later Вектор:
- python3
- python3-venv
- python3-pip
- python-is-python3
- build-essential
- python3-dev

Applied via per-agent `groups/<folder>/container.json` packages, not base image.
Built images:
- aura imageTag `nanoclaw-agent-v2-a69a3d76:ag-1779487162003-n7rpic`
- radar imageTag `nanoclaw-agent-v2-a69a3d76:ag-1779487212871-cz50ia`
- vektor imageTag `nanoclaw-agent-v2-a69a3d76:ag-1779487212872-yii7cy`
Verification:
- all three images have Python 3.11.2
- `python` resolves to Python 3.11.2
- `python3 -m pip` works
- `python3 -m venv /tmp/ncvenv` works
- gcc/build-essential available
Runtime:
- no aura/radar/vektor podman agent containers were running after build; next wake should use the new per-agent imageTag.

## Final Verification

Checked 2026-05-23:
- `nanoclaw-v2-a69a3d76.service` active
- `nanoclaw-codex-broker-a69a3d76.service` active
- Podman host containers `nanoclaw-v2-a69a3d76` and `nanoclaw-codex-broker-a69a3d76` running
- aura/radar/vektor exist in NanoClaw DB and use `provider: codex` via `container.json`
- Telegram DMs already verified for @aura_nanodd_bot, @radar_nanodd_bot, @vector_nanodd_bot
- Project `pnpm build` passed

## Update Policy

Default upstream update mechanism is `/update-nanoclaw`: clean worktree preflight, upstream fetch, backup branch/tag, preview, merge/cherry-pick/rebase, conflict resolution, `pnpm run build`, `pnpm test`, breaking-change check, optional skill update check.
Local adaptation added 2026-05-23:
- `.claude/skills/update-nanoclaw/SKILL.md` now includes rootless Podman/systemd deployment steps for this server.
- Rebuild host image `localhost/nanoclaw-host-a69a3d76:latest` only when `ops/podman-host/Containerfile` changed.
- Restart order after validated update: `systemctl --user restart nanoclaw-codex-broker-a69a3d76.service`, then `systemctl --user restart nanoclaw-v2-a69a3d76.service`.
- Health-check services, Podman containers, and `logs/nanoclaw.log` for Telegram bridge aliases `aura`, `radar`, `vektor` plus `NanoClaw running`.
- This is not a fully autonomous self-update path; the agent can guide/execute after approval, but must keep git backup/rollback and stop on unsafe dirty worktrees.

## Deferred / Not Applicable

matrix/max allowlists preserved in sender-allowlist.json deferred section but not activated.
