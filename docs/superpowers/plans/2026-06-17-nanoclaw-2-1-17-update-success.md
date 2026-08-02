# NanoClaw 2.1.17 Update Success Reference

Date: 2026-06-17

## Scope

Updated the local rootless Podman NanoClaw install from `2.1.1` to upstream `2.1.17`.

Rollback points:
- branch: `backup/pre-update-e055aa6-20260617-062946`
- tag: `pre-update-e055aa6-20260617-062946`
- dirty-work backup: `/tmp/nanoclaw-update-20260617-062841`

Merge commit:
- `cd59a0e` (`Merge remote-tracking branch 'upstream/main' into channels`)

## Key Resolutions

- Preserved local rootless Podman/systemd update notes in `.claude/skills/update-nanoclaw/SKILL.md`.
- Accepted upstream OneCLI pin flow and upgraded `@onecli-sh/sdk` to `2.2.1`.
- Kept channel dependencies from the `channels` branch.
- Moved global agent CLIs to `container/cli-tools.json` and added `@openai/codex@0.137.0`.
- Preserved local Codex native/minimal-home path:
  - `CODEX_PROVIDER_MODE=native`
  - agent Codex home: `data/codex-agent-home`
  - verified minimal files: `auth.json`, `models_cache.json`
- Rebuilt the base agent image and all custom Python-enabled group images.

## Validation

Passed:
- `pnpm run build`
- `pnpm test` -> 81 files, 660 tests
- `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit`
- `cd container/agent-runner && bun test` -> 114 tests
- `CONTAINER_RUNTIME=podman ./container/build.sh`

Image smoke checks:
- base image: `codex-cli 0.137.0`, `Claude Code 2.1.170`, `agent-browser 0.27.1`, `Vercel CLI 52.2.1`
- custom group image: `codex-cli 0.137.0`, `Python 3.11.2`

Upgrade marker:
- `data/upgrade-state.json` -> `version=2.1.17`, `via=update-nanoclaw`

Runtime:
- `nanoclaw-codex-broker-a69a3d76.service`: active
- `nanoclaw-v2-a69a3d76.service`: active
- Podman containers `nanoclaw-codex-broker-a69a3d76` and `nanoclaw-itl`: running
- Logs showed Telegram bridges for `default`, `aura`, `radar`, `vektor`, then `NanoClaw running`.

## OneCLI

Pins introduced by `versions.json`:
- gateway: `1.36.0`
- CLI: `2.2.5`

Actions:
- upgraded host `onecli` CLI to `2.2.5`
- updated `~/.onecli/docker-compose.yml` gateway image to `ghcr.io/onecli/onecli:1.36.0`
- corrected `.env` and `onecli config api-host` to `http://127.0.0.1:10254` for this rootless Podman host

Verification:
- `curl http://127.0.0.1:10254/v1/health` returned 200
- `onecli version` returned `version=2.2.5`, `server_status=ok`

## Worktree State After Update

Committed:
- upstream merge commit `cd59a0e`

Left as local working-tree changes intentionally:
- `src/config.ts`
- `src/providers/codex.ts`
- `container/agent-runner/src/providers/codex.ts`
- `src/providers/codex.test.ts`
- `container/agent-runner/src/providers/codex.test.ts`
- `.nanoclaw-update-backups/`

Reason: these were local Codex native/minimal-home changes preserved across the upstream update rather than silently squashed.

## Rollback

Repo rollback:

```bash
systemctl --user stop nanoclaw-v2-a69a3d76.service nanoclaw-codex-broker-a69a3d76.service
git reset --hard pre-update-e055aa6-20260617-062946
pnpm install --frozen-lockfile
pnpm run build
CONTAINER_RUNTIME=podman ./container/build.sh
systemctl --user restart nanoclaw-codex-broker-a69a3d76.service
systemctl --user restart nanoclaw-v2-a69a3d76.service
```

OneCLI rollback:

```bash
cd ~/.onecli
# restore the previous image digest in docker-compose.yml if needed
docker compose up -d onecli
# restore /tmp/onecli-pre-upgrade-* over $(command -v onecli) if CLI rollback is needed
```

