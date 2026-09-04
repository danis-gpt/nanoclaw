# Codex Broker Model Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent Brama from going silent when an experimental or fast Codex model fails by retrying once on the stable Codex model.

**Architecture:** Move the broker's Codex execution path into a small testable runner module. The HTTP broker keeps token validation and response writing; the runner selects a model, invokes `codex exec`, and if the selected model fails and is not the stable fallback model, retries once with `gpt-5.3-codex`. Logs and responses expose the final model and fallback metadata.

**Tech Stack:** TypeScript, Node child process spawning, Vitest.

---

### Task 1: Regression Test

**Files:**
- Create: `src/codex-broker-runner.test.ts`

- [ ] **Step 1: Write the failing test**

Create tests that call a future `runCodex` helper with an injected fake spawn function:

```typescript
it('falls back to stable codex when the selected default model fails', async () => {
  const result = await runCodex({ prompt: 'reply', continuation: 'thread-1' }, grantWithDefault('gpt-5.3-codex-spark'), {
    spawn: fakeSpawn([
      { code: 1, stderr: 'codex exec exited with code 1' },
      { code: 0, stdout: [{ type: 'thread.started', thread_id: 'thread-2' }, { type: 'item.completed', item: { type: 'agent_message', text: 'fallback answer' } }] },
    ]),
  });

  expect(result.model).toBe('gpt-5.3-codex');
  expect(result.fallbackFrom).toBe('gpt-5.3-codex-spark');
  expect(result.text).toBe('fallback answer');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/codex-broker-runner.test.ts`

Expected: fail because `src/codex-broker-runner.ts` does not exist yet.

### Task 2: Runner Module and Fallback

**Files:**
- Create: `src/codex-broker-runner.ts`
- Modify: `src/codex-broker.ts`

- [ ] **Step 1: Extract runner**

Move model selection, codex args, generated-file collection, and Codex process execution into `src/codex-broker-runner.ts`.

- [ ] **Step 2: Implement fallback**

When the primary selected model fails and the model is not `gpt-5.3-codex`, retry once with:

```typescript
{
  model: 'gpt-5.3-codex',
  reason: `${primary.reason}->fallback:codex-exec-failed`,
}
```

Include response metadata:

```typescript
fallbackFrom?: string;
fallbackReason?: string;
```

- [ ] **Step 3: Keep stable failures visible**

If `gpt-5.3-codex` itself fails, do not retry again. Return the original error through the broker's existing HTTP 500 path.

### Task 3: Verification and Deployment

**Files:**
- Test: `src/codex-broker-runner.test.ts`
- Runtime: user systemd services

- [ ] **Step 1: Run targeted test**

Run: `pnpm test src/codex-broker-runner.test.ts`

Expected: fallback and no-retry tests pass.

- [ ] **Step 2: Run build and full tests**

Run:

```bash
pnpm run build
pnpm test
```

Expected: TypeScript build passes and all Vitest tests pass.

- [ ] **Step 3: Restart runtime**

Run:

```bash
systemctl --user restart nanoclaw-codex-broker-a69a3d76.service
systemctl --user restart nanoclaw-v2-a69a3d76.service
```

- [ ] **Step 4: Verify runtime**

Run:

```bash
systemctl --user is-active nanoclaw-codex-broker-a69a3d76.service nanoclaw-v2-a69a3d76.service
podman ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
journalctl --user -u nanoclaw-codex-broker-a69a3d76.service -n 80 --no-pager
journalctl --user -u nanoclaw-v2-a69a3d76.service -n 120 --no-pager
systemctl --failed --no-pager
```

Expected: both services active, containers running, broker listening, NanoClaw running, failed units 0.
