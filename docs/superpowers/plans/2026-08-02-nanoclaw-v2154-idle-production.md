# NanoClaw v2.1.54 and Clean Idle Exit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the customized OVH1 NanoClaw deployment from v2.1.17 to the pinned v2.1.54 release, preserve native Codex/Podman/Telegram/Kommo behavior, and make completed ephemeral agent containers exit cleanly instead of being killed at the 30-minute safety ceiling.

**Architecture:** Build and validate in an isolated worktree while production continues on the original checkout. Import the existing local customizations as an explicit baseline commit, merge the pinned release with narrow conflict resolution, then add a configurable idle-exit seam and startup reconciliation for stale database projections using test-first changes. Only after offline tests and candidate images pass will production be stopped briefly for a consistent data backup, required migrations, fast-forward checkout update, image activation, and layered live verification.

**Tech Stack:** TypeScript, Node.js 22, Bun, Vitest, SQLite, pnpm, rootless Podman, user-level systemd, Telegram Chat SDK, native Codex broker.

---

### Task 1: Capture the deployed customization baseline

**Files:**
- Modify: `container/agent-runner/src/providers/codex.ts`
- Modify: `src/providers/codex.ts`
- Modify: `src/config.ts`
- Modify: `ops/nanoclaw-kommo-cli.py`
- Create: `container/agent-runner/src/providers/codex-app-policy.ts`
- Create: `container/agent-runner/src/providers/codex-app-policy.test.ts`
- Create: `container/agent-runner/src/providers/codex.test.ts`
- Create: `src/providers/codex.test.ts`
- Create: `ops/kommo-sync-health.py`
- Create: `ops/test_kommo_sync_health.py`
- Create: `ops/openclaw-cutover.py`
- Create: `ops/openclaw-memory-refresh.py`
- Create: `ops/systemd/*`

- [ ] **Step 1: Apply the saved tracked patch in the isolated worktree**

Run:

```bash
git apply /home/ubuntu/backups/nanoclaw-v2154-20260802T123237Z/working-tree.patch
```

Expected: the four tracked local customizations appear as modified with no rejected hunks.

- [ ] **Step 2: Restore relevant untracked source, tests, docs, and operations files**

Extract the saved archive, excluding `ops/__pycache__` and the prior `.nanoclaw-update-backups` directory:

```bash
tar -xzf /home/ubuntu/backups/nanoclaw-v2154-20260802T123237Z/untracked-files.tar.gz \
  --exclude='ops/__pycache__' --exclude='.nanoclaw-update-backups'
```

Expected: only human-authored source, tests, plans, runbooks, and systemd files are restored.

- [ ] **Step 3: Verify the imported baseline**

Run:

```bash
pnpm run build
pnpm test
python3 -m unittest ops/test_kommo_sync_health.py
```

Expected: build exit 0, all Vitest files pass, and Kommo health tests pass.

- [ ] **Step 4: Commit the preserved baseline**

```bash
git add container src ops docs/superpowers/plans/2026-06-17-nanoclaw-2-1-17-update-success.md
git commit -m "chore: preserve deployed OVH1 customizations"
```

### Task 2: Integrate pinned NanoClaw v2.1.54

**Files:**
- Merge: `v2.1.54`
- Resolve: `.claude/skills/update-nanoclaw/SKILL.md`
- Resolve: `container/agent-runner/src/poll-loop.ts`
- Resolve: `container/agent-runner/src/providers/index.ts`
- Resolve: `container/cli-tools.json`
- Resolve: `package.json`
- Resolve: `pnpm-lock.yaml`
- Resolve: `src/config.ts`
- Resolve: `src/container-runner.ts`
- Resolve: `src/index.ts`
- Remove or replace: obsolete `setup/install-*.sh` channel installers

- [ ] **Step 1: Merge the pinned release without committing**

```bash
git merge --no-commit --no-ff v2.1.54
```

Expected: known conflicts only; the merge remains isolated from production.

- [ ] **Step 2: Resolve release/config conflicts narrowly**

Keep v2.1.54 version and dependency pins, retain `CODEX_PROVIDER_MODE=native`, rootless Podman runtime paths, Codex broker contribution, and the current Telegram adapter behavior. Accept upstream deletion of obsolete channel installer scripts because v2.1.54 uses skill-directed channel installation.

For `container/cli-tools.json`, retain the exact current Codex CLI pin in addition to the release tools:

```json
{ "name": "@openai/codex", "version": "0.137.0" }
```

Expected: `git diff --name-only --diff-filter=U` prints nothing and no conflict markers remain.

- [ ] **Step 3: Install the merged dependency graph**

```bash
pnpm install
```

Expected: lockfile is regenerated consistently and installation exits 0.

- [ ] **Step 4: Run the release migration checks on disposable data**

Copy the backed-up central database into a temporary data directory, run the compiled startup/migration path against the copy, and verify:

```sql
PRAGMA integrity_check;
PRAGMA foreign_key_check;
```

Expected: both return clean results; the production database is untouched.

- [ ] **Step 5: Commit the resolved release integration**

```bash
git add -A
git commit -m "merge: update NanoClaw to v2.1.54"
```

### Task 3: Add clean idle exit with TDD

**Files:**
- Create: `container/agent-runner/src/idle-tracker.ts`
- Create: `container/agent-runner/src/idle-tracker.test.ts`
- Modify: `container/agent-runner/src/config.ts`
- Modify: `container/agent-runner/src/poll-loop.ts`
- Modify: `src/container-config.ts`
- Modify: `src/db/container-configs.ts`
- Create: `src/db/migrations/0xx-container-idle-timeout.ts`
- Modify: `src/db/migrations/index.ts`
- Modify: `src/types.ts`
- Modify: `src/cli/resources/groups.ts`

- [ ] **Step 1: Write failing idle tracker and configuration tests**

Tests must prove that timeout `0` disables exit, activity resets the deadline, an elapsed configured timeout requests exit, and invalid negative values are rejected.

Desired interface:

```ts
const idle = createIdleTracker(timeoutMs, nowFn);
idle.markActivity();
idle.shouldExit();
```

- [ ] **Step 2: Run the focused tests and confirm RED**

```bash
pnpm vitest run container/agent-runner/src/idle-tracker.test.ts src/container-config.test.ts
```

Expected: failures specifically report the missing idle tracker/config field.

- [ ] **Step 3: Implement the minimal tracker, DB field, CLI surface, and poll-loop exit**

The poll loop must end the provider stream after a completed wrapped result when idle timeout is enabled, mark activity after a completed batch, and exit code `0` only when no messages are pending and the configured deadline elapsed. The host 30-minute safety ceiling remains unchanged.

- [ ] **Step 4: Run focused tests and confirm GREEN**

```bash
pnpm vitest run container/agent-runner/src/idle-tracker.test.ts src/container-config.test.ts container/agent-runner/src/poll-loop.test.ts
```

Expected: all focused tests pass.

- [ ] **Step 5: Commit the lifecycle change**

```bash
git add container/agent-runner/src src/container-config.ts src/db src/types.ts src/cli/resources/groups.ts
git commit -m "fix(container): exit cleanly after configurable idle window"
```

### Task 4: Reconcile stale container status projections with TDD

**Files:**
- Modify: `src/db/sessions.ts`
- Modify: `src/index.ts`
- Test: `src/db/db-v2.test.ts`

- [ ] **Step 1: Write a failing reconciliation test**

Create running, idle, and stopped session rows, call the desired startup reconciliation function, and assert that running/idle become stopped while an already stopped row remains stopped.

- [ ] **Step 2: Run the focused test and confirm RED**

```bash
pnpm vitest run src/db/db-v2.test.ts
```

Expected: failure because the reconciliation function does not exist.

- [ ] **Step 3: Implement one startup database update**

```sql
UPDATE sessions
SET container_status = 'stopped'
WHERE container_status IN ('running', 'idle');
```

Call it once after central DB initialization and before host sweep starts. Log the affected row count without exposing session contents.

- [ ] **Step 4: Run the focused test and confirm GREEN**

```bash
pnpm vitest run src/db/db-v2.test.ts
```

Expected: test passes and the operation is idempotent.

- [ ] **Step 5: Commit reconciliation**

```bash
git add src/db/sessions.ts src/db/db-v2.test.ts src/index.ts
git commit -m "fix(sessions): reconcile stale container status on startup"
```

### Task 5: Validate code and candidate images

**Files:**
- Verify: all changed files
- Build: `localhost/nanoclaw-host-a69a3d76:candidate-v2154`
- Build: candidate agent image

- [ ] **Step 1: Run formatting, build, and full host tests**

```bash
pnpm exec prettier --check .
pnpm run build
pnpm test
```

Expected: exit 0 and zero failed tests.

- [ ] **Step 2: Run container typecheck and tests**

```bash
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
cd container/agent-runner && bun test
```

Expected: exit 0 and zero failed tests.

- [ ] **Step 3: Build candidate images without replacing production tags**

Build the host image with a candidate tag and the agent image through the Podman build path. Inspect image IDs, creation times, and CLI pins before activation.

- [ ] **Step 4: Run disposable lifecycle acceptance**

Using temporary session databases and a candidate container, submit a deterministic test message, observe successful completion, then verify the agent container exits with code `0` after the configured short idle timeout and leaves no processing claims.

### Task 6: Migrate data and cut over production

**Files:**
- Update: `data/v2.db` through sanctioned migrations
- Update: `data/upgrade-state.json`
- Preserve: `.env`, `groups/`, `data/v2-sessions/`, `data/codex-agent-home/`

- [ ] **Step 1: Enter a bounded maintenance window**

Stop the main NanoClaw service first, wait for agent containers to exit, then stop the broker. Record the exact pre-cutover service and container state.

- [ ] **Step 2: Create a consistent stopped-state backup**

Copy `.env`, `groups`, central and session databases, Codex agent home, systemd units, and current image metadata into the existing protected backup directory. Run SQLite integrity checks on the copies.

- [ ] **Step 3: Move the original checkout to the verified feature tip**

Stash the original dirty state as an additional recovery object, fast-forward the original `channels` branch to the verified feature branch, and do not reapply the stash because the same customizations are committed in the feature history.

- [ ] **Step 4: Run sanctioned release data migrations**

Run the v2.1.54 scheduled-task and provider-memory migration paths against production data exactly once, stamp upgrade state `2.1.54`, and verify task counts, series uniqueness, destination mappings, memory files, SQLite integrity, and foreign keys before service start.

- [ ] **Step 5: Activate candidate images and idle timeouts**

Tag the verified candidate images as the production image names. Set idle timeout to `120000` ms for Aura, Radar, and Vektor and `300000` ms for Brama through the `ncl groups config update` path.

- [ ] **Step 6: Start broker then main service**

Start `nanoclaw-codex-broker-a69a3d76.service`, verify its socket, then start `nanoclaw-v2-a69a3d76.service`.

- [ ] **Step 7: Run layered live acceptance**

Verify active/enabled units, main/broker containers, `/api/health`, four Telegram bridges, absence of 401/409/conflict errors, a real native Codex completion, a scheduled-task run, clean idle exit code `0`, no due/failed/processing backlog, and corrected central session statuses.

### Task 7: Publish and close

**Files:**
- Create: `docs/superpowers/plans/2026-08-02-nanoclaw-v2154-idle-production.md`

- [ ] **Step 1: Run final fresh verification**

Repeat the full build/test commands and live acceptance checks after the production restart.

- [ ] **Step 2: Push the NanoClaw branch**

```bash
git push origin channels
git status --short --branch
```

Expected: the branch is published and the original checkout is clean/up to date except ignored runtime state.

- [ ] **Step 3: Close and sync the Beads issue**

```bash
bd close ovh1-dev-zn0h
bd dolt push
```

Expected: Beads records completion and pushes successfully.
