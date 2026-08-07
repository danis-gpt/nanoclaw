# NanoClaw production audit and update — 2026-08-07

## Result

Production code is running from local commit `e65d8cdc`, which contains the
previously deployed `d0431379` fixes plus the completed ESLint debt
remediation. Its upstream base remains `main` at `743e32df`. The published
NanoClaw version remains `2.1.54`; this checkout additionally contains 23
upstream commits made after that release.

## Deployed architecture

```text
Telegram (Brama, Aura, Radar, Vektor) / local CLI socket
                         |
                         v
        nanoclaw-itl host container (rootless Podman)
        channel adapters -> router -> scheduler -> delivery
                         |
              central data/v2.db (configuration)
                         |
            one isolated system/chat session
                         |
        inbound.db <-> per-session agent container <-> outbound.db
                         |
        native Codex CLI (gpt-5.5) + shared Codex auth home
```

- The user systemd unit owns the host and Codex-broker containers. Agents use
  `CODEX_PROVIDER_MODE=native`; the broker remains available but is not on the
  normal agent completion path.
- The central SQLite database stores groups, routes, sessions, container
  configuration, and scheduling metadata. Each session has separate inbound
  and outbound SQLite files, preserving the single-writer boundary.
- Agent containers are created per active session. The group workspace is
  mounted at `/workspace/agent`; the shared runner is mounted read-only at
  `/app/src`.
- Aura, Radar, and Vektor use derived agent images with Python 3.11.2 for their
  operational scripts. Brama uses the base agent image.
- Each recurring task series now has its own `system:tasks:<series-id>` session.
  Pre-task scripts may return `wakeAgent=false`; such runs are acknowledged
  without spending a model call and now arm the normal clean idle exit.
- OneCLI runs locally on `127.0.0.1:10254` for credential/config handling.

## Changes applied

- Merged upstream `main` while preserving the local multi-Telegram channels,
  native Codex provider, and local release-workflow policy.
- Resolved migration number collision by retaining local migration 021 and
  moving the upstream approval-question migration to 022.
- Updated runtime tools to Codex 0.147.0, Claude Code 2.1.224, and
  agent-browser 0.33.2; rebuilt and promoted host/base/group images.
- Migrated 30 live recurring series from ordinary chat sessions to isolated
  system task sessions (28 pending, 2 intentionally paused), preserving series
  IDs, schedules, origin-session references, and history.
- Fixed pre-task scripts to execute from `/workspace/agent`.
- Fixed containers that stayed alive forever after every task in a batch was
  gated by `wakeAgent=false`.

## Verification evidence

- systemd: active/running, `NRestarts=0`, `ExecMainStatus=0`.
- Telegram `getMe`: all four configured bots returned `ok=true`.
- OneCLI: `/api/health` and `/v1/health` returned `status=ok`.
- Native provider: Codex 0.147.0 called `gpt-5.5` from the promoted agent image
  and returned `NANOCLAW_UPDATE_OK`.
- Live task: Aura source preflight returned `wakeAgent=false`, made no model
  call, and a five-second verification container exited cleanly with code 0.
- Databases: central `integrity_check=ok`; 86 session databases passed
  `quick_check` with zero failures.
- Host suite: 1,417 passed, 3 skipped, 0 failed. Agent runner: 171 passed,
  1 skipped, 0 failed. Both TypeScript checks passed.
- Legacy ESLint debt is resolved: `pnpm lint` reports zero errors and zero
  warnings. All 16 explicit `any` sites were typed, blocking error-handling
  violations were corrected, and 194 intentional resilience catches now carry
  local rationale. The catch-all rule is promoted from warning to error so new
  undocumented catches fail CI.

## Versions

| Component | Deployed | Assessment |
| --- | --- | --- |
| NanoClaw package | 2.1.54 + 23 post-release upstream commits | Current release plus newer source |
| Codex CLI | 0.147.0 | Current npm latest at audit time |
| Claude Code | 2.1.224 | Current npm latest at audit time |
| agent-browser | 0.33.2 | Current npm latest at audit time |
| Bun / Node | 1.3.12 / 22.23.1 | Working image runtime |
| OneCLI gateway / CLI | 1.36.0 / 2.2.5 | Current upstream NanoClaw pins |
| Podman | 4.3.1 | Older distro package, operational; update with the OS lifecycle |

## Backup and rollback

The restricted backup is at
`/home/ubuntu/backups/nanoclaw-repair-20260807T122206Z` (551 MB). It contains
the environment, user units, git bundle/status, group archive, central and
session SQLite backups, and task-migration manifests.

Rollback image tags:

- `localhost/nanoclaw-host-a69a3d76:rollback-preupdate-20260807`
- `localhost/nanoclaw-agent-v2-a69a3d76:rollback-preupdate-20260807`

Before rollback, stop only `nanoclaw-v2-a69a3d76.service`, restore the central
and session databases from `final-precutover`, retag the two rollback images as
`latest`, restore the saved environment/unit if required, then start the unit
and repeat the layered health checks above.
