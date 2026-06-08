import { EventEmitter } from 'events';
import { PassThrough, Readable, Writable } from 'stream';

import { describe, expect, it } from 'vitest';

import { runCodex, type CodexBrokerGrant, type SpawnCodex } from './codex-broker-runner.js';

function grantWithDefault(defaultModel: string): CodexBrokerGrant {
  return {
    token: 'a'.repeat(64),
    agentGroupId: 'ag-brama',
    sessionId: 'sess-brama',
    sessionHostPath: '/tmp/session',
    groupHostPath: '/tmp/group',
    defaultModel,
    escalationModel: 'auto-frontier',
    createdAt: '2026-05-28T00:00:00.000Z',
  };
}

interface FakeRun {
  code: number;
  stderr?: string;
  stdout?: unknown[];
}

function fakeSpawn(runs: FakeRun[]): { spawn: SpawnCodex; models: string[] } {
  const models: string[] = [];
  const spawn: SpawnCodex = (_command, args) => {
    const run = runs.shift();
    if (!run) throw new Error('unexpected spawn');
    const modelIndex = args.indexOf('-m');
    models.push(modelIndex >= 0 ? args[modelIndex + 1] : '');

    const child = new EventEmitter() as EventEmitter & ReturnType<SpawnCodex>;
    child.stdin = new Writable({
      write(_chunk, _encoding, cb) {
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
  return { spawn, models };
}

function fakeSpawnError(err: Error): { spawn: SpawnCodex; models: string[] } {
  const models: string[] = [];
  const spawn: SpawnCodex = (_command, args) => {
    const modelIndex = args.indexOf('-m');
    models.push(modelIndex >= 0 ? args[modelIndex + 1] : '');

    const child = new EventEmitter() as EventEmitter & ReturnType<SpawnCodex>;
    child.stdin = new Writable({
      write(_chunk, _encoding, cb) {
        cb();
      },
    }) as ReturnType<SpawnCodex>['stdin'];
    const stdout = new PassThrough();
    child.stdout = stdout as ReturnType<SpawnCodex>['stdout'];
    child.stderr = Readable.from([]) as ReturnType<SpawnCodex>['stderr'];

    setImmediate(() => {
      child.emit('error', err);
      stdout.end();
    });
    return child;
  };
  return { spawn, models };
}

describe('runCodex fallback', () => {
  it('falls back to stable codex when the selected default model fails', async () => {
    const { spawn, models } = fakeSpawn([
      { code: 1, stderr: 'codex exec exited with code 1' },
      {
        code: 0,
        stdout: [
          { type: 'thread.started', thread_id: 'thread-2' },
          { type: 'item.completed', item: { type: 'agent_message', text: 'fallback answer' } },
        ],
      },
    ]);

    const result = await runCodex(
      { prompt: 'reply', continuation: 'thread-1' },
      grantWithDefault('gpt-5.3-codex-spark'),
      { spawn, collectReferencedGeneratedFiles: () => [] },
    );

    expect(models).toEqual(['gpt-5.3-codex-spark', 'gpt-5.3-codex']);
    expect(result.model).toBe('gpt-5.3-codex');
    expect(result.modelReason).toBe('default->fallback:codex-exec-failed');
    expect(result.fallbackFrom).toBe('gpt-5.3-codex-spark');
    expect(result.fallbackReason).toBe('codex exec exited with code 1');
    expect(result.text).toBe('fallback answer');
  });

  it('does not retry when the stable codex fallback model fails', async () => {
    const { spawn, models } = fakeSpawn([{ code: 1, stderr: 'stable failed' }]);

    await expect(
      runCodex({ prompt: 'reply', continuation: 'thread-1' }, grantWithDefault('gpt-5.3-codex'), {
        spawn,
        collectReferencedGeneratedFiles: () => [],
      }),
    ).rejects.toThrow('stable failed');

    expect(models).toEqual(['gpt-5.3-codex']);
  });

  it('turns child process spawn errors into broker errors without crashing the process', async () => {
    const { spawn, models } = fakeSpawnError(Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }));

    await expect(
      runCodex({ prompt: 'reply' }, grantWithDefault('gpt-5.3-codex'), {
        spawn,
        collectReferencedGeneratedFiles: () => [],
      }),
    ).rejects.toThrow('spawn codex ENOENT');

    expect(models).toEqual(['gpt-5.3-codex']);
  });
});
