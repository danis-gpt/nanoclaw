import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';
import { getContainerImageBase, getInstallSlug } from './install-slug.js';
import { isValidTimezone } from './timezone.js';

// Read config values from .env (falls back to process.env).
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'CONTAINER_IMAGE',
  'CONTAINER_IMAGE_BASE',
  'ONECLI_URL',
  'ONECLI_API_KEY',
  'CREDENTIAL_PROXY_PORT',
  'TZ',
  'CODEX_DEFAULT_MODEL',
  'CODEX_ESCALATION_MODEL',
  'CODEX_PROVIDER_MODE',
  'CODEX_HOME',
  'CODEX_AGENT_HOME',
  'CODEX_AUTO_ESCALATION',
  'CODEX_AUTO_ESCALATION_MIN_SCORE',
  'CODEX_AUTO_ESCALATION_LONG_PROMPT_CHARS',
]);

export const ASSISTANT_NAME = process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER || envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(HOME_DIR, '.config', 'nanoclaw', 'mount-allowlist.json');
export const SENDER_ALLOWLIST_PATH = path.join(HOME_DIR, '.config', 'nanoclaw', 'sender-allowlist.json');
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

// Per-checkout image tag so two installs on the same host don't share
// `nanoclaw-agent:latest` and clobber each other on rebuild.
export const CONTAINER_IMAGE_BASE =
  process.env.CONTAINER_IMAGE_BASE || envConfig.CONTAINER_IMAGE_BASE || getContainerImageBase(PROJECT_ROOT);
export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || envConfig.CONTAINER_IMAGE || `${CONTAINER_IMAGE_BASE}:latest`;
// Install slug — stamped onto every spawned container via --label so
// cleanupOrphans only reaps containers from this install, not peers.
export const INSTALL_SLUG = getInstallSlug(PROJECT_ROOT);
export const CONTAINER_INSTALL_LABEL = `nanoclaw-install=${INSTALL_SLUG}`;
export const CONTAINER_TIMEOUT = parseInt(process.env.CONTAINER_TIMEOUT || '1800000', 10);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760', 10); // 10MB default
export const ONECLI_URL = process.env.ONECLI_URL || envConfig.ONECLI_URL;
export const ONECLI_API_KEY = process.env.ONECLI_API_KEY || envConfig.ONECLI_API_KEY;
export const CREDENTIAL_PROXY_PORT = parseInt(
  process.env.CREDENTIAL_PROXY_PORT || envConfig.CREDENTIAL_PROXY_PORT || '3001',
  10,
);
export const CODEX_DEFAULT_MODEL = process.env.CODEX_DEFAULT_MODEL || envConfig.CODEX_DEFAULT_MODEL || 'gpt-5.3-codex';
export const CODEX_ESCALATION_MODEL =
  process.env.CODEX_ESCALATION_MODEL || envConfig.CODEX_ESCALATION_MODEL || 'auto-frontier';
export type CodexProviderMode = 'broker' | 'native';
export const CODEX_PROVIDER_MODE: CodexProviderMode =
  (process.env.CODEX_PROVIDER_MODE || envConfig.CODEX_PROVIDER_MODE || '').toLowerCase() === 'native'
    ? 'native'
    : 'broker';
export const CODEX_HOME = process.env.CODEX_HOME || envConfig.CODEX_HOME || path.join(HOME_DIR, '.codex');
export const CODEX_AGENT_HOME =
  process.env.CODEX_AGENT_HOME || envConfig.CODEX_AGENT_HOME || path.join(DATA_DIR, 'codex-agent-home');
export const CODEX_AUTO_ESCALATION =
  (process.env.CODEX_AUTO_ESCALATION || envConfig.CODEX_AUTO_ESCALATION || 'true') !== 'false';
export const CODEX_AUTO_ESCALATION_MIN_SCORE = Math.max(
  1,
  parseInt(process.env.CODEX_AUTO_ESCALATION_MIN_SCORE || envConfig.CODEX_AUTO_ESCALATION_MIN_SCORE || '3', 10) || 3,
);
export const CODEX_AUTO_ESCALATION_LONG_PROMPT_CHARS = Math.max(
  1000,
  parseInt(
    process.env.CODEX_AUTO_ESCALATION_LONG_PROMPT_CHARS || envConfig.CODEX_AUTO_ESCALATION_LONG_PROMPT_CHARS || '20000',
    10,
  ) || 20000,
);
export const CODEX_BROKER_SOCKET =
  process.env.CODEX_BROKER_SOCKET ||
  path.join(
    process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 1000}`,
    `nanoclaw-codex-broker-${INSTALL_SLUG}.sock`,
  );
export const CODEX_BROKER_GRANTS_DIR = path.join(DATA_DIR, 'codex-broker', 'grants');
export const MAX_MESSAGES_PER_PROMPT = Math.max(1, parseInt(process.env.MAX_MESSAGES_PER_PROMPT || '10', 10) || 10);
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(1, parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildTriggerPattern(trigger: string): RegExp {
  return new RegExp(`^${escapeRegex(trigger.trim())}\\b`, 'i');
}

export const DEFAULT_TRIGGER = `@${ASSISTANT_NAME}`;

export function getTriggerPattern(trigger?: string): RegExp {
  const normalizedTrigger = trigger?.trim();
  return buildTriggerPattern(normalizedTrigger || DEFAULT_TRIGGER);
}

export const TRIGGER_PATTERN = buildTriggerPattern(DEFAULT_TRIGGER);

// Timezone for scheduled tasks, message formatting, etc.
// Validates each candidate is a real IANA identifier before accepting.
function resolveConfigTimezone(): string {
  const candidates = [process.env.TZ, envConfig.TZ, Intl.DateTimeFormat().resolvedOptions().timeZone];
  for (const tz of candidates) {
    if (tz && isValidTimezone(tz)) return tz;
  }
  return 'UTC';
}
export const TIMEZONE = resolveConfigTimezone();
