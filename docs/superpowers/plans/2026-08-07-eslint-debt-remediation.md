# ESLint Debt Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `pnpm lint` complete with zero errors and zero warnings without weakening the repository's configured rules or changing runtime behavior.

**Architecture:** Preserve the current ESLint policy. Fix concrete type and error-propagation violations directly; for deliberate process, transport, and cleanup resilience boundaries, document the intentional catch-all locally with a narrow ESLint directive instead of disabling the rule globally.

**Tech Stack:** TypeScript 5.9, ESLint 9 flat config, Vitest 4, Prettier 3.

---

### Task 1: Remove blocking lint errors

**Files:**
- Modify: `src/channels/cli.ts`
- Modify: `src/channels/signal.ts`
- Modify: `src/channels/signal.test.ts`
- Modify: `src/circuit-breaker.ts`
- Modify: `src/circuit-breaker.test.ts`
- Modify: `src/cli/crud.ts`
- Modify: `src/cli/delivery-action.ts`
- Modify: `src/config.ts`
- Modify: `src/delivery.test.ts`

- [x] Rename deliberately unused callback parameters with an underscore and remove genuinely unused imports/functions.
- [x] Replace CommonJS test imports with static ESM imports.
- [x] Replace empty cleanup catches with `ENOENT`-aware handling or an explicitly documented best-effort boundary.
- [x] Preserve JSON parse causes using `catch (err)` and `new Error(message, { cause: err })`.
- [x] Run `pnpm exec eslint src --quiet` and expect zero errors.
- [x] Run targeted tests for CLI, Signal, circuit breaker, and delivery.
- [x] Commit the remediation as an atomic change after full verification.

### Task 2: Replace explicit `any`

**Files:**
- Modify only files reported by `@typescript-eslint/no-explicit-any` in the fresh ESLint JSON output.

- [x] Replace external unvalidated values with `unknown` and narrow them before use.
- [x] Replace mock/test values with the smallest SDK or structural interface required by the call site.
- [x] Run `pnpm typecheck` and `pnpm exec eslint src --format json`; expect zero `no-explicit-any` warnings.
- [x] Run tests covering every changed production module.
- [x] Include the typed boundaries in the atomic remediation commit.

### Task 3: Audit catch-all boundaries

**Files:**
- Modify the source files reported by `no-catch-all/no-catch-all`.

- [x] For parsing and filesystem catches, identify expected error classes/codes and rethrow unexpected errors.
- [x] For top-level channel, polling, webhook, delivery, and shutdown boundaries that must remain alive after arbitrary adapter failures, keep the catch-all and add a local directive explaining the resilience boundary.
- [x] Do not disable `no-catch-all/no-catch-all` globally or by file override.
- [x] Promote `no-catch-all/no-catch-all` from warning to error after the baseline is clean so new debt fails CI.
- [x] Run `pnpm lint`; expect zero errors and zero warnings.
- [x] Run `pnpm typecheck`, the full host suite, and the full serial agent-runner suite.
- [x] Include documented catch boundaries in the atomic remediation commit.

### Task 4: Integrate and verify production

**Files:**
- Modify: `docs/NANOCLAW-UPDATE-2026-08-07.md`

- [ ] Record the zero-lint result and final verification counts.
- [ ] Fast-forward `channels` only after the isolated branch is clean and all tests pass.
- [ ] Restart only `nanoclaw-v2-a69a3d76.service` if changed host source is used by the running service.
- [ ] Verify systemd status, fresh logs, Telegram `getMe`, OneCLI health, central DB integrity, and all session DB quick checks.
- [ ] Preserve the worktree until post-deployment verification succeeds, then remove it and delete the merged branch.
