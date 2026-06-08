import fs from 'fs';
import http from 'http';

import { registerProvider } from './provider-registry.js';
import type { AgentProvider, AgentQuery, ProviderEvent, ProviderFile, ProviderOptions, QueryInput } from './types.js';

function log(msg: string): void {
  console.error(`[codex-provider] ${msg}`);
}

function readIfExists(file: string): string {
  try {
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : '';
  } catch {
    return '';
  }
}

function modelHintForPrompt(prompt: string): 'default' | 'escalation' {
  return /\/escalate\b|\/model\s+gpt-5\.5\b|#gpt-5\.5\b|модель\s*:\s*gpt-5\.5\b/i.test(prompt)
    ? 'escalation'
    : 'default';
}

function buildPrompt(input: QueryInput, assistantName?: string): string {
  const parts: string[] = [];
  const shared = readIfExists('/workspace/agent/CLAUDE.md');
  const local = readIfExists('/workspace/agent/CLAUDE.local.md');

  parts.push('You are running as a NanoClaw agent through Codex CLI.');
  if (assistantName) parts.push(`Assistant name: ${assistantName}.`);
  parts.push('Return the user-facing answer as your final message. NanoClaw will deliver that final message to the user.');

  if (input.systemContext?.instructions) {
    parts.push('Runtime context:', input.systemContext.instructions);
  }
  if (shared) {
    parts.push('Project instructions from CLAUDE.md:', shared);
  }
  if (local) {
    parts.push('Persistent local memory from CLAUDE.local.md:', local);
  }
  parts.push('Incoming message batch:', input.prompt);
  return parts.join('\n\n');
}

interface BrokerResponse {
  threadId?: string;
  text: string | null;
  model: string;
  files?: ProviderFile[];
}

export class CodexProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;

  private assistantName?: string;
  private brokerSocket: string;
  private brokerToken: string;

  constructor(options: ProviderOptions = {}) {
    this.assistantName = options.assistantName;
    this.brokerSocket = options.env?.CODEX_BROKER_SOCKET || process.env.CODEX_BROKER_SOCKET || '/run/nanoclaw-codex-broker.sock';
    this.brokerToken = options.env?.CODEX_BROKER_TOKEN || process.env.CODEX_BROKER_TOKEN || '';
  }

  isSessionInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return /no rollout found|thread\/resume failed|no conversation found|session.*not found/i.test(msg);
  }

  query(input: QueryInput): AgentQuery {
    let aborted = false;
    let ended = false;
    let wakeFollowUp: (() => void) | null = null;
    const queuedFollowUps: string[] = [];

    async function* eventsFor(provider: CodexProvider): AsyncGenerator<ProviderEvent> {
      if (!provider.brokerToken) {
        throw new Error('CODEX_BROKER_TOKEN is not set');
      }

      let continuation = input.continuation;
      let prompt = buildPrompt(input, provider.assistantName);
      let modelHint = modelHintForPrompt(input.prompt);

      while (!aborted) {
        yield { type: 'activity' };
        const result = await queryBroker(provider.brokerSocket, {
          token: provider.brokerToken,
          prompt,
          continuation,
          cwd: input.cwd,
          modelHint,
        });
        if (aborted) return;
        if (result.threadId) {
          continuation = result.threadId;
          yield { type: 'init', continuation: result.threadId };
        }
        yield { type: 'result', text: result.text, files: result.files };

        const followUp = await nextFollowUp();
        if (!followUp) return;
        prompt = buildPrompt({ ...input, prompt: followUp, continuation }, provider.assistantName);
        modelHint = modelHintForPrompt(followUp);
      }
    }

    async function nextFollowUp(): Promise<string | null> {
      while (!aborted && !ended) {
        const followUp = queuedFollowUps.shift();
        if (followUp) return followUp;
        await new Promise<void>((resolve) => {
          wakeFollowUp = resolve;
        });
        wakeFollowUp = null;
      }
      return queuedFollowUps.shift() ?? null;
    }

    return {
      push: (message) => {
        queuedFollowUps.push(message);
        wakeFollowUp?.();
      },
      end: () => {
        ended = true;
        wakeFollowUp?.();
      },
      events: eventsFor(this),
      abort: () => {
        aborted = true;
        wakeFollowUp?.();
      },
    };
  }
}

function queryBroker(socketPath: string, body: unknown): Promise<BrokerResponse> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        path: '/v1/query',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed: { error?: string } & Partial<BrokerResponse>;
          try {
            parsed = JSON.parse(text) as typeof parsed;
          } catch {
            reject(new Error(`Codex broker returned invalid JSON: ${text.slice(0, 500)}`));
            return;
          }
          if (!res.statusCode || res.statusCode >= 400) {
            reject(new Error(parsed.error || `Codex broker failed with status ${res.statusCode}`));
            return;
          }
          resolve({
            threadId: parsed.threadId,
            text: parsed.text ?? null,
            model: parsed.model || 'unknown',
            files: Array.isArray(parsed.files) ? parsed.files : undefined,
          });
        });
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

registerProvider('codex', (opts) => new CodexProvider(opts));
