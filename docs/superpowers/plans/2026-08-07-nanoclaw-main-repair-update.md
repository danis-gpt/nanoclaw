# NanoClaw Main Repair and Production Update Plan

> **For Codex:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Bring the customized NanoClaw deployment onto current `upstream/main`, restore reliable scheduled tasks, and prove the live Telegram-to-provider-to-delivery path without losing local channel, provider, or operational customizations.

**Architecture:** Keep the production `channels` checkout and services untouched while preparing a merge candidate in an isolated worktree. Merge upstream core changes into the customized branch, retain the fork's channel/provider modules and disabled release publishing, validate host and agent layers separately, then deploy with database and image rollback points. Scheduled-task repair uses NanoClaw's system task-session boundary so task logs and delivery are no longer mixed into ordinary chat sessions.

**Tech Stack:** TypeScript, Node.js/pnpm, Bun, SQLite, rootless Podman, systemd user services, Telegram adapters, native Codex provider.

---

### Task 1: Establish rollback and an isolated candidate

**Files:**
- Preserve: production `.env`, systemd units, `data/v2.db`, `data/v2-sessions/**`, `groups/**`
- Create: `/home/ubuntu/backups/nanoclaw-repair-20260807T122206Z/**`

1. Record production Git state, service definitions, image IDs, and configuration.
2. Take SQLite online backups of the central and session databases and verify each with `integrity_check` or `quick_check`.
3. Archive group workspaces and configuration with restricted permissions.
4. Tag the running host and agent images with dated rollback tags.
5. Create branch `repair/update-20260807` in `.worktrees/repair-update-20260807` from the production commit.

### Task 2: Merge current upstream core while preserving fork boundaries

**Files:**
- Modify: files changed by `upstream/main` since the current fork base
- Preserve deletion: `.github/workflows/release.yml`
- Modify: `scripts/release.test.ts`

1. Merge `upstream/main` into the candidate without committing immediately.
2. Resolve conflicts by retaining customized channels, native Codex integration, deployment tooling, and the deliberate absence of upstream publishing workflows.
3. Make workflow-specific release assertions conditional when the fork intentionally has no release workflow, while keeping pure version/release metadata tests active.
4. Install dependencies from the committed lockfile and run type checking plus the root test suite.
5. Inspect the resulting diff for unexpected removal of local modules or secrets.

### Task 3: Repair Aura scheduled-task runtime

**Files:**
- Inspect/modify if required: `groups/aura/container.json`
- Inspect/modify if required: `groups/aura/scripts/aura-morning-context.py`
- Test: the closest existing script or container configuration tests

1. Reproduce the Aura preflight inside the currently configured group image and capture the precise failure.
2. Compare the image contents with the DB-backed package configuration; rebuild the Aura group image if Python is configured but absent from the old image.
3. If the merged runtime still fails, add the smallest failing regression test before changing implementation.
4. Run both `--preflight` and the normal script path in the candidate image without emitting an external report.

### Task 4: Move live legacy schedules into task sessions

**Files:**
- Create: a dated migration manifest under the protected production backup directory
- Modify: live task rows through `ncl tasks` and verified SQLite transactions only

1. Enumerate every live pending or paused recurring series still stored in a chat-session database, including schedule, prompt, destination, next run, and current status.
2. Produce and review a dry-run mapping before changing rows.
3. Recreate each live series through NanoClaw's task creation path so it receives `system:tasks:<series>` isolation and an explicit delivery destination.
4. Cancel only the replaced legacy live rows; retain completed and failed history for audit.
5. Verify one live row per series, no duplicate due occurrence, and correct central/session linkage.

### Task 5: Verify agent lifecycle and idle-exit behavior

**Files:**
- Test/modify if required: `container/agent-runner/src/poll-loop.test.ts`
- Modify if required: `container/agent-runner/src/poll-loop.ts`

1. Run the full agent-runner suite after the upstream merge, including the previously flaky second-task test.
2. Reproduce any remaining timeout under controlled repeated runs.
3. Only if reproducible, add a deterministic failing regression and make the narrowest lifecycle correction.
4. Prove that a task container exits after its configured idle window with no pending work.

### Task 6: Build and stage the candidate

**Files:**
- Modify: local Podman images and deployment metadata only

1. Build candidate host and agent images from the merged worktree using distinct dated tags.
2. Inspect embedded package/tool versions and verify the container entrypoints.
3. Run database migration/readback and smoke checks against disposable copies of production databases.
4. Commit the reviewed candidate so the deployment target is immutable and auditable.

### Task 7: Controlled production cutover

**Files:**
- Modify: production Git checkout, image tags/configuration, and live SQLite state

1. Stop only the NanoClaw host and broker user services and confirm containers have exited.
2. Take a final online/offline-consistent database snapshot and record image IDs.
3. Fast-forward or merge the reviewed candidate into the production `channels` branch without touching unrelated untracked backup material.
4. Promote the candidate image tags, apply migrations, rebuild the Aura group image if required, and restart only the approved services.
5. If any cutover gate fails, restore the recorded commit, databases, and rollback image tags before restarting.

### Task 8: Layered live verification

**Files:**
- Record: command output and the migration manifest in the dated backup/report artifacts

1. Verify systemd state, rootless Podman containers, restart counts, and fresh error logs.
2. Verify central and session DB integrity, schema version, pending/processing queues, and task-session invariants.
3. Verify OneCLI health, Kommo freshness, all configured Telegram bridges, inbound routing, native Codex completion, and outbound delivery.
4. Execute a controlled scheduled-task preflight and prove task logs are accepted in its isolated system session.
5. Observe idle exit after completion and confirm there are no new warnings, duplicate schedules, or stuck containers.
6. Report deployed Git/package/tool versions, tests, live evidence, rollback location, and any remaining non-blocking caveats.
