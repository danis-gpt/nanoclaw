import { spawn as nodeSpawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import readline from 'readline';

import { memoryContextForSessionStart, type MemorySessionHookRegistration } from '../memory/session-hook.js';
import { codexAppFeatureArgs } from './codex-app-policy.js';
import { registerProvider } from './provider-registry.js';
import type {
  AgentProvider,
  AgentQuery,
  McpServerConfig,
  ProviderEvent,
  ProviderFile,
  ProviderOptions,
  QueryInput,
} from './types.js';

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

export function buildPrompt(
  input: QueryInput,
  assistantName?: string,
  agentDir = '/workspace/agent',
  includeMemory = false,
): string {
  const parts: string[] = [];
  const shared = readIfExists(path.join(agentDir, 'CLAUDE.md'));
  const local = readIfExists(path.join(agentDir, 'CLAUDE.local.md'));

  parts.push('You are running as a NanoClaw agent through Codex CLI.');
  if (assistantName) parts.push(`Assistant name: ${assistantName}.`);
  parts.push(
    'Return the user-facing answer as your final message. NanoClaw will deliver that final message to the user.',
  );

  if (input.systemContext?.instructions) {
    parts.push('Runtime context:', input.systemContext.instructions);
  }
  if (shared) {
    parts.push('Project instructions from CLAUDE.md:', shared);
  }
  if (local) {
    parts.push('Persistent local memory from CLAUDE.local.md:', local);
  }
  if (includeMemory) {
    parts.push('Provider-neutral persistent memory:', memoryContextForSessionStart('startup', agentDir) ?? '');
  }
  parts.push('Incoming message batch:', input.prompt);
  return parts.join('\n\n');
}

interface BrokerResponse {
  threadId?: string;
  text: string | null;
  model: string;
  fallbackFrom?: string;
  fallbackReason?: string;
  files?: ProviderFile[];
}

export interface NativeCodexRequest {
  prompt: string;
  continuation?: string;
  cwd: string;
  modelHint?: 'default' | 'escalation';
  mcpServers?: Record<string, McpServerConfig>;
}

export interface CodexChild {
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  once(event: 'error', listener: (err: Error) => void): unknown;
  once(event: 'close', listener: (code: number | null) => void): unknown;
}

export type SpawnCodex = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; stdio: ['pipe', 'pipe', 'pipe'] },
) => CodexChild;

interface RunNativeCodexDeps {
  spawn?: SpawnCodex;
  collectReferencedGeneratedFiles?: (text: string) => ProviderFile[];
}

interface ModelDecision {
  model: string;
  reason: string;
}

const STABLE_CODEX_FALLBACK_MODEL = 'gpt-5.3-codex';
const AUTO_FRONTIER_ALIAS = 'auto-frontier';
const MAX_GENERATED_FILE_BYTES = 20 * 1024 * 1024;

export class CodexProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;

  private assistantName?: string;
  private mode: 'broker' | 'native';
  private brokerSocket: string;
  private brokerToken: string;
  private mcpServers: Record<string, McpServerConfig>;
  private memorySessionHook?: MemorySessionHookRegistration;

  constructor(options: ProviderOptions = {}) {
    this.assistantName = options.assistantName;
    this.mode =
      (options.env?.CODEX_PROVIDER_MODE || process.env.CODEX_PROVIDER_MODE) === 'native' ? 'native' : 'broker';
    this.brokerSocket =
      options.env?.CODEX_BROKER_SOCKET || process.env.CODEX_BROKER_SOCKET || '/run/nanoclaw-codex-broker.sock';
    this.brokerToken = options.env?.CODEX_BROKER_TOKEN || process.env.CODEX_BROKER_TOKEN || '';
    this.mcpServers = options.mcpServers ?? {};
  }

  registerMemorySessionHook(hook: MemorySessionHookRegistration): void {
    this.memorySessionHook = hook;
  }

  isSessionInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return /no rollout found|thread\/resume failed|no conversation found|session.*not found/i.test(msg);
  }

  query(input: QueryInput): AgentQuery {
    if (!this.memorySessionHook) throw new Error('Codex memory session hook was not registered');
    let aborted = false;
    let ended = false;
    let wakeFollowUp: (() => void) | null = null;
    const queuedFollowUps: string[] = [];

    async function* eventsFor(provider: CodexProvider): AsyncGenerator<ProviderEvent> {
      if (provider.mode === 'broker' && !provider.brokerToken) {
        throw new Error('CODEX_BROKER_TOKEN is not set');
      }

      let continuation = input.continuation;
      let prompt = buildPrompt(input, provider.assistantName, input.cwd, !input.continuation);
      let modelHint = modelHintForPrompt(input.prompt);

      while (!aborted) {
        yield { type: 'activity' };
        const result =
          provider.mode === 'native'
            ? await runNativeCodex({
                prompt,
                continuation,
                cwd: input.cwd,
                modelHint,
                mcpServers: provider.mcpServers,
              })
            : await queryBroker(provider.brokerSocket, {
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
        prompt = buildPrompt({ ...input, prompt: followUp, continuation }, provider.assistantName, input.cwd, false);
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

function codexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

function generatedImagesRoot(): string {
  return path.join(codexHome(), 'generated_images');
}

function readCodexOutput(file: string): string {
  return readIfExists(file);
}

function autoEscalationEnabled(): boolean {
  return (process.env.CODEX_AUTO_ESCALATION || 'true') !== 'false';
}

function autoEscalationMinScore(): number {
  return Math.max(1, parseInt(process.env.CODEX_AUTO_ESCALATION_MIN_SCORE || '3', 10) || 3);
}

function autoEscalationLongPromptChars(): number {
  return Math.max(1000, parseInt(process.env.CODEX_AUTO_ESCALATION_LONG_PROMPT_CHARS || '20000', 10) || 20000);
}

function defaultModel(): string {
  return process.env.CODEX_DEFAULT_MODEL || STABLE_CODEX_FALLBACK_MODEL;
}

function escalationModel(): string {
  return process.env.CODEX_ESCALATION_MODEL || AUTO_FRONTIER_ALIAS;
}

function availableModelSlugs(): string[] {
  const cachePath = path.join(codexHome(), 'models_cache.json');
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as { models?: Array<{ slug?: string }> };
    return (raw.models || []).map((m) => m.slug).filter((slug): slug is string => Boolean(slug));
  } catch {
    return [];
  }
}

function compareVersionDesc(a: string, b: string): number {
  const parse = (s: string): number[] => {
    const match = /^gpt-(\d+(?:\.\d+)*)$/.exec(s);
    return match ? match[1].split('.').map((part) => parseInt(part, 10)) : [];
  };
  const av = parse(a);
  const bv = parse(b);
  for (let i = 0; i < Math.max(av.length, bv.length); i++) {
    const diff = (bv[i] || 0) - (av[i] || 0);
    if (diff !== 0) return diff;
  }
  return a.localeCompare(b);
}

function resolveModelAlias(model: string): string {
  if (model !== AUTO_FRONTIER_ALIAS) return model;
  const frontier = availableModelSlugs()
    .filter((slug) => /^gpt-\d+(?:\.\d+)*$/.test(slug))
    .filter((slug) => !/(mini|codex|spark|review)/i.test(slug))
    .sort(compareVersionDesc)[0];
  return frontier || 'gpt-5.5';
}

function autoEscalationReasons(prompt: string): string[] {
  const checks: Array<[string, RegExp]> = [
    ['architecture', /архитектур|architecture|system design/i],
    ['security', /безопасн|угроз|security|threat|auth|credential|secret/i],
    ['migration', /миграц|migration|upgrade|rollout/i],
    ['strategy', /стратег|strategy|roadmap/i],
    ['deep-analysis', /глубок|тщательн|проанализируй|deep|thorough|comprehensive/i],
    ['tradeoffs', /вариант|trade-?off|сравни|compare/i],
    ['root-cause', /root cause|причин|incident|postmortem|авари/i],
    ['whole-project', /весь проект|whole repo|entire project|codebase/i],
    ['review', /ревью|review|audit/i],
    ['plan', /план|plan/i],
  ];
  const reasons = checks.filter(([, re]) => re.test(prompt)).map(([name]) => name);
  if (prompt.length >= autoEscalationLongPromptChars()) {
    reasons.push('long-prompt');
  }
  return reasons;
}

function selectNativeModel(req: NativeCodexRequest): ModelDecision {
  const escalation = resolveModelAlias(escalationModel());
  if (req.modelHint === 'escalation') {
    return { model: escalation, reason: 'manual:modelHint' };
  }
  if (autoEscalationEnabled()) {
    const reasons = autoEscalationReasons(req.prompt);
    if (reasons.length >= autoEscalationMinScore() || reasons.includes('long-prompt')) {
      return { model: escalation, reason: `auto:${reasons.join('+')}` };
    }
  }
  return { model: defaultModel(), reason: 'default' };
}

function buildNativeCodexArgs(req: NativeCodexRequest, outFile: string, model: string): string[] {
  const common = [
    '--json',
    '--skip-git-repo-check',
    '--ignore-user-config',
    '--dangerously-bypass-approvals-and-sandbox',
    ...codexAppFeatureArgs(req.cwd, fs.existsSync),
    '-m',
    model,
    '--output-last-message',
    outFile,
  ];

  if (req.continuation) {
    return ['exec', 'resume', ...common, req.continuation, '-'];
  }
  return ['exec', ...common, '-C', req.cwd, '-'];
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function mcpEnvName(serverName: string, serverIndex: number, purpose: string, index: number): string {
  const safeServer = serverName.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  const nonce = crypto.randomBytes(8).toString('hex').toUpperCase();
  return `NANOCLAW_MCP_${nonce}_${serverIndex}_${safeServer}_${purpose}_${index}`;
}

function inlineTomlStringMap(entries: Array<[string, string]>): string {
  return `{ ${entries.map(([key, value]) => `${tomlString(key)} = ${tomlString(value)}`).join(', ')} }`;
}

function isTrustedBuiltinStdio(serverName: string, server: McpServerConfig): boolean {
  return (
    serverName === 'nanoclaw' &&
    server.type !== 'http' &&
    server.command === 'bun' &&
    server.args?.length === 2 &&
    server.args?.[0] === 'run' &&
    server.args?.[1] === '/app/src/mcp-tools/index.ts' &&
    server.cwd === undefined &&
    Object.keys(server.env ?? {}).length === 0
  );
}

/**
 * Materialize per-group MCP config as one-shot Codex CLI overrides. Secret
 * HTTP values stay in the child environment; argv contains only environment
 * variable names. Custom stdio env and args are rejected because Codex has no
 * per-server secret boundary for them. This prevents a group's connector
 * credentials from being persisted into the shared native Codex home or
 * exposed to another MCP process.
 */
export function buildNativeCodexLaunch(
  req: NativeCodexRequest,
  outFile: string,
  model: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): { args: string[]; env: NodeJS.ProcessEnv } {
  const args = buildNativeCodexArgs(req, outFile, model);
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  const overrides: string[] = [];
  const servers = Object.entries(req.mcpServers ?? {});

  const hasCredentialedHttp = servers.some(
    ([, server]) => server.type === 'http' && Object.keys(server.headers ?? {}).length > 0,
  );
  if (
    hasCredentialedHttp &&
    servers.some(([serverName, server]) => server.type !== 'http' && !isTrustedBuiltinStdio(serverName, server))
  ) {
    throw new Error('Native Codex cannot mix credentialed HTTP MCP with untrusted stdio MCP servers');
  }

  const addOverride = (key: string, value: string): void => {
    overrides.push('-c', `${key}=${value}`);
  };

  let serverIndex = 0;
  for (const [serverName, server] of servers) {
    const currentServerIndex = serverIndex++;
    const prefix = `mcp_servers.${serverName}`;
    if (server.type === 'http') {
      addOverride(`${prefix}.url`, tomlString(server.url));
      const envHeaders: Array<[string, string]> = [];
      let headerIndex = 0;
      for (const [header, value] of Object.entries(server.headers ?? {})) {
        const bearer = header.toLowerCase() === 'authorization' && /^Bearer\s+\S/i.test(value);
        if (bearer) {
          const variable = mcpEnvName(serverName, currentServerIndex, 'BEARER', headerIndex++);
          env[variable] = value.replace(/^Bearer\s+/i, '');
          addOverride(`${prefix}.bearer_token_env_var`, tomlString(variable));
          continue;
        }
        const variable = mcpEnvName(serverName, currentServerIndex, 'HEADER', headerIndex++);
        env[variable] = value;
        envHeaders.push([header, variable]);
      }
      if (envHeaders.length > 0) {
        addOverride(`${prefix}.env_http_headers`, inlineTomlStringMap(envHeaders));
      }
      continue;
    }

    addOverride(`${prefix}.command`, tomlString(server.command));
    if ((server.args?.length ?? 0) > 0 && !isTrustedBuiltinStdio(serverName, server)) {
      throw new Error(
        `Native Codex MCP server ${serverName} declares custom stdio arguments; use an argument-free wrapper or scoped HTTP connector`,
      );
    }
    if (server.args && server.args.length > 0) addOverride(`${prefix}.args`, JSON.stringify(server.args));
    if (server.cwd) addOverride(`${prefix}.cwd`, tomlString(server.cwd));

    const envKeys = Object.keys(server.env ?? {});
    if (envKeys.length > 0) {
      throw new Error(
        `Native Codex MCP server ${serverName} declares stdio environment values; use a scoped HTTP connector`,
      );
    }
  }

  // Global exec flags are accepted after `exec`/`exec resume`; place MCP
  // overrides immediately before the prompt/model flags for deterministic
  // inspection and to keep resume behavior identical.
  const insertAt = req.continuation ? 2 : 1;
  args.splice(insertAt, 0, ...overrides);
  return { args, env };
}

function tail(text: string, max = 4000): string {
  return text.length > max ? text.slice(text.length - max) : text;
}

export function collectReferencedGeneratedFiles(text: string): ProviderFile[] {
  const root = generatedImagesRoot();
  if (!fs.existsSync(root)) return [];

  let rootReal: string;
  try {
    rootReal = fs.realpathSync(root);
  } catch {
    return [];
  }

  const files: ProviderFile[] = [];
  const seen = new Set<string>();
  const re = /\/[^\s`"'<>]+?\.(?:png|jpe?g|webp|gif)\b/gi;
  for (const match of text.matchAll(re)) {
    const resolved = path.resolve(match[0]);
    let real: string;
    try {
      real = fs.realpathSync(resolved);
    } catch {
      continue;
    }
    if (!real.startsWith(`${rootReal}${path.sep}`) || seen.has(real)) continue;
    const stat = fs.statSync(real);
    if (!stat.isFile() || stat.size > MAX_GENERATED_FILE_BYTES) continue;

    seen.add(real);
    files.push({
      filename: path.basename(real),
      dataBase64: fs.readFileSync(real).toString('base64'),
    });
  }
  return files;
}

async function runNativeCodexAttempt(
  req: NativeCodexRequest,
  modelDecision: ModelDecision,
  deps: RunNativeCodexDeps,
): Promise<BrokerResponse> {
  const spawn = deps.spawn ?? (nodeSpawn as SpawnCodex);
  const collectFiles = deps.collectReferencedGeneratedFiles ?? collectReferencedGeneratedFiles;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-codex-native-'));
  const outFile = path.join(tmpDir, 'last-message.txt');
  const launch = buildNativeCodexLaunch(req, outFile, modelDecision.model);
  let stderr = '';
  let lastAgentText: string | null = null;
  let threadId: string | undefined;

  try {
    log(
      `native query started model=${modelDecision.model} reason=${modelDecision.reason} resume=${Boolean(req.continuation)}`,
    );
    const child = spawn('codex', launch.args, {
      cwd: req.cwd,
      env: launch.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const exitPromise = new Promise<{ code: number | null } | { err: Error }>((resolve) => {
      child.once('error', (err) => resolve({ err }));
      child.once('close', (code) => resolve({ code }));
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.stdin.end(req.prompt);

    const rl = readline.createInterface({ input: child.stdout });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as {
          type?: string;
          thread_id?: string;
          item?: { type?: string; text?: string };
        };
        if (event.type === 'thread.started' && event.thread_id) {
          threadId = event.thread_id;
        } else if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
          lastAgentText = event.item.text ?? null;
        }
      } catch {
        log(`ignoring non-JSON native Codex output: ${line.slice(0, 200)}`);
      }
    }

    const exitResult = await exitPromise;
    if ('err' in exitResult) throw exitResult.err;
    if (exitResult.code !== 0) {
      throw new Error(tail(stderr.trim() || `codex exec exited with code ${exitResult.code}`));
    }

    const text = readCodexOutput(outFile) || lastAgentText;
    const files = text ? collectFiles(text) : [];
    log(`native query completed model=${modelDecision.model} thread=${threadId || 'none'} files=${files.length}`);
    return {
      threadId,
      text: text || null,
      model: modelDecision.model,
      files: files.length > 0 ? files : undefined,
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export async function runNativeCodex(req: NativeCodexRequest, deps: RunNativeCodexDeps = {}): Promise<BrokerResponse> {
  if (!req.prompt || typeof req.prompt !== 'string') throw new Error('prompt is required');

  const primaryDecision = selectNativeModel(req);
  try {
    return await runNativeCodexAttempt(req, primaryDecision, deps);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (primaryDecision.model === STABLE_CODEX_FALLBACK_MODEL) {
      throw err;
    }
    const fallbackDecision: ModelDecision = {
      model: STABLE_CODEX_FALLBACK_MODEL,
      reason: `${primaryDecision.reason}->fallback:codex-exec-failed`,
    };
    log(`native model fallback ${primaryDecision.model} -> ${fallbackDecision.model}: ${message}`);
    const result = await runNativeCodexAttempt(req, fallbackDecision, deps);
    return {
      ...result,
      fallbackFrom: primaryDecision.model,
      fallbackReason: message,
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
