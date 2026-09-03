import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable, Writable } from 'stream';

import { afterEach, describe, expect, it } from 'bun:test';

import { MEMORY_SESSION_HOOK } from '../memory/session-hook.js';
import { buildNativeCodexLaunch, buildPrompt, CodexProvider, runNativeCodex, type SpawnCodex } from './codex.js';

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
  it('keeps HTTP MCP header values out of argv', () => {
    const launch = buildNativeCodexLaunch(
      {
        prompt: 'hello',
        cwd: '/workspace/agent',
        mcpServers: {
          docs: {
            type: 'http',
            url: 'http://127.0.0.1:18080/mcp',
            headers: { Authorization: 'Bearer docs-secret', 'X-Workspace': 'internal-secret' },
          },
          nanoclaw: {
            command: 'bun',
            args: ['run', '/app/src/mcp-tools/index.ts'],
          },
        },
      },
      '/tmp/last-message.txt',
      'gpt-5.3-codex',
      { PATH: '/usr/bin' },
    );

    expect(launch.args.join(' ')).toContain('mcp_servers.docs.bearer_token_env_var=');
    expect(launch.args.join(' ')).toContain('mcp_servers.docs.env_http_headers=');
    expect(launch.args).toContain('--ignore-user-config');
    expect(launch.args.join(' ')).not.toContain('docs-secret');
    expect(launch.args.join(' ')).not.toContain('internal-secret');
    expect(Object.values(launch.env)).toContain('docs-secret');
    expect(Object.values(launch.env)).toContain('internal-secret');
  });

  it('rejects stdio environment values', () => {
    expect(() =>
      buildNativeCodexLaunch(
        {
          prompt: 'hello',
          cwd: '/workspace/agent',
          mcpServers: { local: { command: '/local', env: { API_TOKEN: 'local-secret' } } },
        },
        '/tmp/last-message.txt',
        'gpt-5.3-codex',
        {},
      ),
    ).toThrow('declares stdio environment values');
  });

  it('rejects credentialed HTTP mixed with an untrusted stdio MCP server', () => {
    expect(() =>
      buildNativeCodexLaunch(
        {
          prompt: 'hello',
          cwd: '/workspace/agent',
          mcpServers: {
            docs: {
              type: 'http',
              url: 'http://127.0.0.1:18080/mcp',
              headers: { Authorization: 'Bearer docs-secret' },
            },
            local: { command: '/local' },
          },
        },
        '/tmp/last-message.txt',
        'gpt-5.3-codex',
        {},
      ),
    ).toThrow('cannot mix credentialed HTTP MCP with untrusted stdio MCP servers');
  });

  it('rejects custom stdio arguments', () => {
    expect(() =>
      buildNativeCodexLaunch(
        {
          prompt: 'hello',
          cwd: '/workspace/agent',
          mcpServers: { local: { command: '/local', args: ['--api-token', 'opaque-secret'] } },
        },
        '/tmp/last-message.txt',
        'gpt-5.3-codex',
        {},
      ),
    ).toThrow('declares custom stdio arguments');
  });

  it('rejects a spoofed built-in NanoClaw server beside credentialed HTTP', () => {
    expect(() =>
      buildNativeCodexLaunch(
        {
          prompt: 'hello',
          cwd: '/workspace/agent',
          mcpServers: {
            docs: {
              type: 'http',
              url: 'http://127.0.0.1:18080/mcp',
              headers: { Authorization: 'Bearer docs-secret' },
            },
            nanoclaw: {
              command: 'bun',
              args: ['run', '/workspace/agent/evil/mcp-tools/index.ts'],
              cwd: '/workspace/agent/evil',
            },
          },
        },
        '/tmp/last-message.txt',
        'gpt-5.3-codex',
        {},
      ),
    ).toThrow('cannot mix credentialed HTTP MCP with untrusted stdio MCP servers');
  });

  it('keeps HTTP header environment names distinct', () => {
    const launch = buildNativeCodexLaunch(
      {
        prompt: 'hello',
        cwd: '/workspace/agent',
        mcpServers: {
          'a-b': { type: 'http', url: 'http://127.0.0.1:18080/mcp', headers: { Authorization: 'Bearer first' } },
          a_b: { type: 'http', url: 'http://127.0.0.1:18081/mcp', headers: { Authorization: 'Bearer second' } },
        },
      },
      '/tmp/last-message.txt',
      'gpt-5.3-codex',
      {},
    );

    const bearerVariables = launch.args
      .filter((arg) => arg.includes('.bearer_token_env_var='))
      .map((arg) => arg.split('=', 2)[1]);
    expect(new Set(bearerVariables).size).toBe(2);
  });

  it('passes the built-in NanoClaw MCP server to native Codex', async () => {
    process.env.CODEX_DEFAULT_MODEL = 'gpt-5.3-codex';
    const { spawn, calls } = fakeSpawn([
      {
        code: 0,
        stdout: [{ type: 'item.completed', item: { type: 'agent_message', text: 'sent' } }],
      },
    ]);
    const request = {
      prompt: 'send the report as a file',
      cwd: '/workspace/agent',
      modelHint: 'default' as const,
      mcpServers: {
        nanoclaw: {
          command: 'bun',
          args: ['run', '/app/src/mcp-tools/index.ts'],
        },
      },
    };

    await runNativeCodex(request, { spawn, collectReferencedGeneratedFiles: () => [] });

    expect(calls[0].args.join(' ')).toContain('mcp_servers.nanoclaw.command=\"bun\"');
    expect(calls[0].args.join(' ')).toContain('/app/src/mcp-tools/index.ts');
  });

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
