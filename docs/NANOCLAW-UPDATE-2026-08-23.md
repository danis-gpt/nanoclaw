# Customized NanoClaw production architecture and v2.2.0 update — 2026-08-23

## Result

Production runs NanoClaw package `2.2.0`, the newest tagged stable release at
deployment time. The deployed source contains the upstream v2.2.0 merge
(`fbbf0643`) plus a deterministic fix for an older timing-sensitive runner test
(`80d5c958`). The live services, channel identities, databases, queues, Kommo
freshness, and native Codex provider were verified after restart.

Upstream `main` was 272 commits ahead of v2.2.0 during the audit, but it had no
newer release tag. Those unreleased commits were deliberately not deployed.

## Deployed architecture

```text
Telegram: Brama / Aura / Radar / Vektor
                    |
                    v
      NanoClaw host container (rootless Podman)
      adapters -> router -> scheduler -> delivery
                    |
          central configuration database
                    |
       agent group + messaging group + thread
                    |
        one isolated session and DB pair
                    |
     inbound.db -> agent container -> outbound.db
                    |
          native Codex CLI (gpt-5.5)
```

Two user-level systemd services supervise the deployment. One runs the host;
the other keeps the Codex broker socket available. Both use the same small host
image, while the compiled application is mounted from the production checkout.
The normal agent path is native Codex, so the broker is an independently
available fallback surface rather than a mandatory hop.

The host owns routing and delivery. Its central SQLite database stores users,
agent groups, messaging groups, wiring, container configuration, permissions,
schedules, and session metadata. Forty-three live sessions each have an
`inbound.db` written by the host and an `outbound.db` written by the agent
container. This single-writer split is the only message transport between the
host and agents.

Agent containers are created per active session. They receive only approved
mounts, the relevant group workspace, the session databases, shared runner
source, and a minimal Codex home. Aura, Radar, and Vektor retain their derived
images and operational scripts. Kommo remains a separate read-only integration;
NanoClaw checks its MCP freshness without copying Kommo credentials into the
repository.

The CLI adapter listens locally but has no messaging-group wiring in this
installation. A CLI client can connect, but it cannot route a chat until an
operator explicitly wires it. This is configuration state, not a runtime error.

## Update contents

- Merged the upstream v2.2.0 release while retaining the native Codex
  provider, rootless Podman deployment, four Telegram aliases, scheduling
  extensions, idle-timeout behavior, and Kommo tools.
- Reconciled the new host lifecycle API, shared task-content parser, and remote
  MCP server types with the local implementation.
- Added upstream plugin-template support, remote Streamable HTTP MCP support,
  migration and question registries, scheduled-occurrence time handling, and
  the v2.2.0 security fixes.
- Replaced a fixed two-second wait in an old local task-run integration test
  with event-driven synchronization. This removes suite-load flakiness without
  changing production behavior.
- Stamped the required upgrade marker as `2.2.0` via `update-nanoclaw` before
  restarting services.

## Post-deployment evidence

- systemd: host and broker are `active/running`, `NRestarts=0`, and
  `ExecMainStatus=0`.
- Startup: central DB, credential proxy, CLI socket, all four Telegram bridges,
  delivery polling, host sweep, and the ncl socket reached ready state.
- Telegram Bot API: Brama, Aura, Radar, and Vektor all returned `ok=true` with
  their expected identities.
- OneCLI: both health endpoints returned `status=ok`.
- Queues: 43 sessions, zero due inbound messages, zero undelivered outbound
  messages, and zero processing acknowledgements left in flight.
- Databases: 98 detected SQLite files passed `PRAGMA quick_check`; the central
  DB passed its foreign-key check.
- Kommo: freshness was `ok=true`; the oldest entity sync was about 0.65 hours
  old at validation time.
- Native provider: a real `gpt-5.5` turn inside the promoted agent image returned
  `NANOCLAW_V220_NATIVE_OK` with exit code 0.
- Host tests: 1,596 passed, 3 skipped, 0 failed across 515 suites.
- Agent runner: 184 passed, 1 skipped, 0 failed; host and runner TypeScript
  checks and ESLint all passed.
- Logs: no new fatal, authentication, conflict, OOM, migration, or SQLite errors
  appeared after restart. Warnings for channel adapters without configured
  credentials are expected because those adapters are intentionally unused.

## Versions and update policy

| Component                  | Deployed               | Assessment                                                                  |
| -------------------------- | ---------------------- | --------------------------------------------------------------------------- |
| NanoClaw                   | 2.2.0                  | Newest tagged stable release; upstream `main` is newer but unreleased       |
| Node.js                    | 22.23.1                | Supported LTS runtime                                                       |
| Bun                        | 1.3.12                 | Agent-image pin; build and tests pass                                       |
| pnpm                       | 10.33.0                | Agent-image build pin                                                       |
| Codex CLI                  | 0.147.0                | Stable deployment pin; registry showed 0.149.0                              |
| Claude Code                | 2.1.224                | Stable deployment pin; registry showed 2.1.241                              |
| agent-browser              | 0.33.2                 | Stable deployment pin; registry showed 0.34.0                               |
| OneCLI SDK / gateway / CLI | 2.2.1 / 1.36.0 / 2.2.5 | v2.2.0-compatible pins                                                      |
| Podman                     | 4.3.1                  | Operational but old; update with the host OS lifecycle, not inside NanoClaw |

The three CLI tools are slightly behind their registry versions. They remain
on the tested deployment pins instead of being hot-updated beyond the stable
NanoClaw release. Upgrade them in a separate candidate image with provider and
browser smoke tests. OneCLI gateway is likewise left on the release-compatible
pin; unreleased upstream code has already moved to a newer gateway.

## Rollback

The pre-update rollback set is
`.nanoclaw-update-backups/pre-v2.2.0-20260823T165443Z/` (about 2.2 GB). It
contains a verified Git bundle, configuration and service metadata, the prior
upgrade marker, and consistent backups of all 98 detected SQLite files.

Rollback coordinates:

- branch: `backup/pre-v2.2.0-20260823T165443Z`
- tag: `pre-v2.2.0-20260823T165443Z`
- host image: `localhost/nanoclaw-host-a69a3d76:pre-v2.2.0-20260823T165443Z`
- previous source commit: `5562c557`

To roll back, stop only the NanoClaw host and broker services, restore the
saved source, marker, and databases, retag the saved host image as `latest`,
then start broker first and host second. Repeat the database, queue, Telegram,
health, log, and native-provider checks before declaring recovery complete.
