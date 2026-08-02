import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable, Writable } from 'stream';

import { afterEach, describe, expect, it } from 'bun:test';

import { MEMORY_SESSION_HOOK } from '../memory/session-hook.js';
import { buildPrompt, CodexProvider, runNativeCodex, type SpawnCodex } from './codex.js';

interface FakeRun {
  code: number;
  stdout?: unknown[];
  stderr?: string;
}

const savedEnv = { ...process.env };

afterEach(() => {
  process.env = { ...savedEnv };
});

function fakeSpawn(runs: FakeRun[]): {
  spawn: SpawnCodex;
  calls: Array<{ command: string; args: string[]; input: string }>;
} {
  const calls: Array<{ command: string; args: string[]; input: string }> = [];
  const spawn: SpawnCodex = (command, args) => {
    const run = runs.shift();
    if (!run) throw new Error('unexpected spawn');

    const child = new EventEmitter() as EventEmitter & ReturnType<SpawnCodex>;
    let input = '';
    child.stdin = new Writable({
      write(chunk, _encoding, cb) {
        input += chunk.toString();
        cb();
      },
      final(cb) {
        calls.push({ command, args, input });
        cb();
      },
    }) as ReturnType<SpawnCodex>['stdin'];
    child.stdout = Readable.from(
      (run.stdout ?? []).map((event) => `${JSON.stringify(event)}\n`),
    ) as ReturnType<SpawnCodex>['stdout'];
    child.stderr = Readable.from(run.stderr ? [run.stderr] : []) as ReturnType<SpawnCodex>['stderr'];

    setImmediate(() => child.emit('close', run.code));
    return child;
  };
  return { spawn, calls };
}

describe('runNativeCodex', () => {
  it('starts codex exec inside the agent container cwd', async () => {
    process.env.CODEX_DEFAULT_MODEL = 'gpt-5.3-codex';
    const { spawn, calls } = fakeSpawn([
      {
        code: 0,
        stdout: [
          { type: 'thread.started', thread_id: 'thread-1' },
          { type: 'item.completed', item: { type: 'agent_message', text: 'native answer' } },
        ],
      },
    ]);

    const result = await runNativeCodex(
      { prompt: 'hello', cwd: '/workspace/agent', modelHint: 'default' },
      { spawn, collectReferencedGeneratedFiles: () => [] },
    );

    expect(result).toMatchObject({ threadId: 'thread-1', text: 'native answer', model: 'gpt-5.3-codex' });
    expect(calls[0].command).toBe('codex');
    expect(calls[0].args).toContain('--json');
    expect(calls[0].args).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(calls[0].args).toContain('-C');
    expect(calls[0].args).toContain('/workspace/agent');
    expect(calls[0].input).toBe('hello');
  });

  it('resumes with codex exec resume and falls back to stable codex on failure', async () => {
    process.env.CODEX_DEFAULT_MODEL = 'gpt-5.3-codex-spark';
    const { spawn, calls } = fakeSpawn([
      { code: 1, stderr: 'spark unavailable' },
      {
        code: 0,
        stdout: [{ type: 'item.completed', item: { type: 'agent_message', text: 'fallback answer' } }],
      },
    ]);

    const result = await runNativeCodex(
      { prompt: 'continue', cwd: '/workspace/agent', continuation: 'thread-1', modelHint: 'default' },
      { spawn, collectReferencedGeneratedFiles: () => [] },
    );

    expect(calls.map((call) => call.args[0])).toEqual(['exec', 'exec']);
    expect(calls.map((call) => call.args[1])).toEqual(['resume', 'resume']);
    expect(calls.map((call) => call.args[call.args.indexOf('-m') + 1])).toEqual([
      'gpt-5.3-codex-spark',
      'gpt-5.3-codex',
    ]);
    expect(result.text).toBe('fallback answer');
    expect(result.fallbackFrom).toBe('gpt-5.3-codex-spark');
  });
});

describe('Codex shared memory', () => {
  it('implements the required memory session hook registration', () => {
    const provider = new CodexProvider({ env: { CODEX_PROVIDER_MODE: 'native' } });
    expect(() => provider.registerMemorySessionHook(MEMORY_SESSION_HOOK)).not.toThrow();
  });

  it('injects the provider-neutral memory files into a fresh Codex prompt', () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-memory-'));
    try {
      fs.mkdirSync(path.join(agentDir, 'memory', 'system'), { recursive: true });
      fs.writeFileSync(path.join(agentDir, 'memory', 'index.md'), '# Core\nDurable fact');
      fs.writeFileSync(path.join(agentDir, 'memory', 'system', 'definition.md'), '# Definition\nKeep it true');

      const prompt = buildPrompt({ prompt: 'hello', cwd: agentDir }, 'Test', agentDir, true);

      expect(prompt).toContain('Durable fact');
      expect(prompt).toContain('Keep it true');
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });
});
