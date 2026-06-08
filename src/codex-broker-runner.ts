import { spawn as nodeSpawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';

import {
  CODEX_AUTO_ESCALATION,
  CODEX_AUTO_ESCALATION_LONG_PROMPT_CHARS,
  CODEX_AUTO_ESCALATION_MIN_SCORE,
} from './config.js';
import { log } from './log.js';

export interface CodexBrokerGrant {
  token: string;
  agentGroupId: string;
  sessionId: string;
  sessionHostPath: string;
  groupHostPath: string;
  defaultModel: string;
  escalationModel: string;
  createdAt: string;
}

export interface BrokerRequest {
  token?: string;
  prompt?: string;
  continuation?: string;
  cwd?: string;
  modelHint?: 'default' | 'escalation';
}

export interface BrokerResponse {
  threadId?: string;
  text: string | null;
  model: string;
  modelAlias?: string;
  modelReason: string;
  fallbackFrom?: string;
  fallbackReason?: string;
  files?: BrokerFile[];
}

export interface BrokerFile {
  filename: string;
  dataBase64: string;
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

interface RunCodexDeps {
  spawn?: SpawnCodex;
  collectReferencedGeneratedFiles?: (text: string) => BrokerFile[];
}

interface ModelDecision {
  model: string;
  modelAlias?: string;
  reason: string;
}

const MAX_GENERATED_FILE_BYTES = 20 * 1024 * 1024;
const AUTO_FRONTIER_ALIAS = 'auto-frontier';
const STABLE_CODEX_FALLBACK_MODEL = 'gpt-5.3-codex';

function readIfExists(file: string): string {
  try {
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : '';
  } catch {
    return '';
  }
}

function generatedImagesRoot(): string {
  return path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'generated_images');
}

function availableModelSlugs(): string[] {
  const cachePath = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'models_cache.json');
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

function resolveModelAlias(model: string): { model: string; alias?: string } {
  if (model !== AUTO_FRONTIER_ALIAS) return { model };
  const slugs = availableModelSlugs();
  const frontier = slugs
    .filter((slug) => /^gpt-\d+(?:\.\d+)*$/.test(slug))
    .filter((slug) => !/(mini|codex|spark|review)/i.test(slug))
    .sort(compareVersionDesc)[0];
  return { model: frontier || 'gpt-5.5', alias: AUTO_FRONTIER_ALIAS };
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
  if (prompt.length >= CODEX_AUTO_ESCALATION_LONG_PROMPT_CHARS) {
    reasons.push('long-prompt');
  }
  return reasons;
}

function selectModel(req: BrokerRequest, grant: CodexBrokerGrant): ModelDecision {
  const escalation = grant.escalationModel || AUTO_FRONTIER_ALIAS;
  const defaultModel = grant.defaultModel || STABLE_CODEX_FALLBACK_MODEL;
  const resolvedEscalation = resolveModelAlias(escalation);
  if (req.modelHint === 'escalation') {
    return {
      model: resolvedEscalation.model,
      modelAlias: resolvedEscalation.alias,
      reason: 'manual:modelHint',
    };
  }
  const prompt = req.prompt || '';
  const marker = /(^|\n)\s*(\/escalate\b|\/model\s+gpt-5\.5\b|#gpt-5\.5\b|модель\s*:\s*gpt-5\.5\b)/i;
  if (marker.test(prompt)) {
    return {
      model: resolvedEscalation.model,
      modelAlias: resolvedEscalation.alias,
      reason: 'manual:prompt-marker',
    };
  }
  if (CODEX_AUTO_ESCALATION) {
    const reasons = autoEscalationReasons(prompt);
    if (reasons.length >= CODEX_AUTO_ESCALATION_MIN_SCORE || reasons.includes('long-prompt')) {
      return {
        model: resolvedEscalation.model,
        modelAlias: resolvedEscalation.alias,
        reason: `auto:${reasons.join('+')}`,
      };
    }
  }
  return { model: defaultModel, reason: 'default' };
}

function resolveCwd(reqCwd: string | undefined, grant: CodexBrokerGrant): string {
  if (!reqCwd || reqCwd === '/workspace/agent') return grant.groupHostPath;
  if (reqCwd === '/workspace') return grant.sessionHostPath;
  throw new Error(`cwd is not allowed: ${reqCwd}`);
}

function buildCodexArgs(req: BrokerRequest, cwd: string, outFile: string, model: string): string[] {
  const common = [
    '--json',
    '--skip-git-repo-check',
    '--dangerously-bypass-approvals-and-sandbox',
    '-m',
    model,
    '--output-last-message',
    outFile,
  ];

  if (req.continuation) {
    return ['exec', 'resume', ...common, req.continuation, '-'];
  }

  return ['exec', ...common, '-C', cwd, '-'];
}

export function collectReferencedGeneratedFiles(text: string): BrokerFile[] {
  const root = generatedImagesRoot();
  if (!fs.existsSync(root)) return [];

  let rootReal: string;
  try {
    rootReal = fs.realpathSync(root);
  } catch {
    return [];
  }

  const files: BrokerFile[] = [];
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

function tail(text: string, max = 4000): string {
  return text.length > max ? text.slice(text.length - max) : text;
}

async function runCodexAttempt(
  req: BrokerRequest,
  grant: CodexBrokerGrant,
  cwd: string,
  modelDecision: ModelDecision,
  deps: RunCodexDeps,
): Promise<BrokerResponse> {
  const spawn = deps.spawn ?? (nodeSpawn as SpawnCodex);
  const collectFiles = deps.collectReferencedGeneratedFiles ?? collectReferencedGeneratedFiles;
  const model = modelDecision.model;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-codex-broker-'));
  const outFile = path.join(tmpDir, 'last-message.txt');
  const args = buildCodexArgs(req, cwd, outFile, model);

  let stderr = '';
  let lastAgentText: string | null = null;
  let threadId: string | undefined;

  try {
    log.info('Codex broker query started', {
      agentGroupId: grant.agentGroupId,
      sessionId: grant.sessionId,
      model,
      modelAlias: modelDecision.modelAlias,
      modelReason: modelDecision.reason,
      resume: Boolean(req.continuation),
    });

    const child = spawn('codex', args, {
      cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const exitPromise = new Promise<{ code: number | null } | { err: Error }>((resolve) => {
      child.once('error', (err) => resolve({ err }));
      child.once('close', (code) => resolve({ code }));
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.stdin.end(req.prompt ?? '');

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
        log.debug('Ignoring non-JSON Codex output', { line: line.slice(0, 200) });
      }
    }

    const exitResult = await exitPromise;
    if ('err' in exitResult) throw exitResult.err;
    const code = exitResult.code;
    if (code !== 0) {
      throw new Error(tail(stderr.trim() || `codex exec exited with code ${code}`));
    }

    const text = readIfExists(outFile) || lastAgentText;
    const files = text ? collectFiles(text) : [];
    log.info('Codex broker query completed', {
      agentGroupId: grant.agentGroupId,
      sessionId: grant.sessionId,
      model,
      modelAlias: modelDecision.modelAlias,
      modelReason: modelDecision.reason,
      threadId,
      hasText: Boolean(text),
      generatedFileCount: files.length,
    });
    return {
      threadId,
      text: text || null,
      model,
      modelAlias: modelDecision.modelAlias,
      modelReason: modelDecision.reason,
      files: files.length > 0 ? files : undefined,
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export async function runCodex(
  req: BrokerRequest,
  grant: CodexBrokerGrant,
  deps: RunCodexDeps = {},
): Promise<BrokerResponse> {
  if (!req.prompt || typeof req.prompt !== 'string') throw new Error('prompt is required');

  const cwd = resolveCwd(req.cwd, grant);
  const primaryDecision = selectModel(req, grant);
  try {
    return await runCodexAttempt(req, grant, cwd, primaryDecision, deps);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (primaryDecision.model === STABLE_CODEX_FALLBACK_MODEL) {
      throw err;
    }

    const fallbackDecision: ModelDecision = {
      model: STABLE_CODEX_FALLBACK_MODEL,
      reason: `${primaryDecision.reason}->fallback:codex-exec-failed`,
    };
    log.warn('Codex broker model fallback triggered', {
      agentGroupId: grant.agentGroupId,
      sessionId: grant.sessionId,
      fallbackFrom: primaryDecision.model,
      fallbackTo: fallbackDecision.model,
      fallbackReason: message,
      resume: Boolean(req.continuation),
    });
    const result = await runCodexAttempt(req, grant, cwd, fallbackDecision, deps);
    return {
      ...result,
      fallbackFrom: primaryDecision.model,
      fallbackReason: message,
    };
  }
}
