import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

import {
  CODEX_AGENT_HOME,
  CODEX_AUTO_ESCALATION,
  CODEX_AUTO_ESCALATION_LONG_PROMPT_CHARS,
  CODEX_AUTO_ESCALATION_MIN_SCORE,
  CODEX_BROKER_GRANTS_DIR,
  CODEX_BROKER_SOCKET,
  CODEX_DEFAULT_MODEL,
  CODEX_ESCALATION_MODEL,
  CODEX_HOME,
  CODEX_PROVIDER_MODE,
  GROUPS_DIR,
  type CodexProviderMode,
} from '../config.js';
import { getAgentGroup } from '../db/agent-groups.js';
import {
  registerProviderContainerConfig,
  type ProviderContainerContext,
  type ProviderContainerContribution,
} from './provider-container-registry.js';

const CONTAINER_BROKER_SOCKET = '/run/nanoclaw-codex-broker.sock';
const CONTAINER_CODEX_HOME = '/home/ubuntu/.codex';
const CONTAINER_CODEX_HOME_DIR = '/home/ubuntu';
const MINIMAL_CODEX_HOME_FILES = ['auth.json', 'models_cache.json'] as const;

interface CodexBrokerGrant {
  token: string;
  agentGroupId: string;
  sessionId: string;
  sessionHostPath: string;
  groupHostPath: string;
  defaultModel: string;
  escalationModel: string;
  createdAt: string;
}

function writeGrantFile(grantsDir: string, grant: CodexBrokerGrant): void {
  fs.mkdirSync(grantsDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(grantsDir, 0o700);
  fs.writeFileSync(path.join(grantsDir, `${grant.token}.json`), JSON.stringify(grant, null, 2) + '\n', {
    mode: 0o600,
  });
}

function shouldCopyFile(source: string, target: string): boolean {
  if (!fs.existsSync(source)) return false;
  if (!fs.existsSync(target)) return true;
  return fs.statSync(source).mtimeMs > fs.statSync(target).mtimeMs;
}

export function prepareAgentCodexHome(sourceHome: string, agentHome: string): void {
  fs.mkdirSync(agentHome, { recursive: true, mode: 0o700 });
  fs.chmodSync(agentHome, 0o700);

  for (const file of MINIMAL_CODEX_HOME_FILES) {
    const source = path.join(sourceHome, file);
    const target = path.join(agentHome, file);
    if (path.resolve(source) === path.resolve(target) || !shouldCopyFile(source, target)) continue;

    fs.copyFileSync(source, target);
    fs.chmodSync(target, 0o600);
  }
}

export interface CodexProviderContributionDeps {
  mode: CodexProviderMode;
  brokerSocket: string;
  brokerGrantsDir: string;
  codexHome: string;
  agentCodexHome: string;
  defaultModel: string;
  escalationModel: string;
  autoEscalation: boolean;
  autoEscalationMinScore: number;
  autoEscalationLongPromptChars: number;
  socketExists: (socketPath: string) => boolean;
  getAgentGroup: (
    agentGroupId: string,
  ) => Promise<{ id: string; folder: string } | undefined> | { id: string; folder: string } | undefined;
  writeGrant: (grantsDir: string, grant: CodexBrokerGrant) => void;
  prepareAgentCodexHome: (sourceHome: string, agentHome: string) => void;
  randomToken: () => string;
  now: () => Date;
}

function realDeps(): CodexProviderContributionDeps {
  return {
    mode: CODEX_PROVIDER_MODE,
    brokerSocket: CODEX_BROKER_SOCKET,
    brokerGrantsDir: CODEX_BROKER_GRANTS_DIR,
    codexHome: CODEX_HOME,
    agentCodexHome: CODEX_AGENT_HOME,
    defaultModel: CODEX_DEFAULT_MODEL,
    escalationModel: CODEX_ESCALATION_MODEL,
    autoEscalation: CODEX_AUTO_ESCALATION,
    autoEscalationMinScore: CODEX_AUTO_ESCALATION_MIN_SCORE,
    autoEscalationLongPromptChars: CODEX_AUTO_ESCALATION_LONG_PROMPT_CHARS,
    socketExists: fs.existsSync,
    getAgentGroup,
    writeGrant: writeGrantFile,
    prepareAgentCodexHome,
    randomToken: () => crypto.randomBytes(32).toString('hex'),
    now: () => new Date(),
  };
}

export async function buildCodexProviderContribution(
  { sessionDir, agentGroupId }: ProviderContainerContext,
  deps: CodexProviderContributionDeps = realDeps(),
): Promise<ProviderContainerContribution> {
  if (deps.mode === 'native') {
    deps.prepareAgentCodexHome(deps.codexHome, deps.agentCodexHome);

    return {
      mounts: [
        { hostPath: deps.agentCodexHome, containerPath: CONTAINER_CODEX_HOME, readonly: false },
        { hostPath: deps.agentCodexHome, containerPath: '/home/node/.codex', readonly: false },
      ],
      env: {
        CODEX_PROVIDER_MODE: 'native',
        CODEX_HOME: CONTAINER_CODEX_HOME,
        HOME: CONTAINER_CODEX_HOME_DIR,
        CODEX_DEFAULT_MODEL: deps.defaultModel,
        CODEX_ESCALATION_MODEL: deps.escalationModel,
        CODEX_AUTO_ESCALATION: String(deps.autoEscalation),
        CODEX_AUTO_ESCALATION_MIN_SCORE: String(deps.autoEscalationMinScore),
        CODEX_AUTO_ESCALATION_LONG_PROMPT_CHARS: String(deps.autoEscalationLongPromptChars),
      },
    };
  }

  if (!deps.socketExists(deps.brokerSocket)) {
    throw new Error(`Codex broker socket does not exist: ${deps.brokerSocket}`);
  }

  const agentGroup = await deps.getAgentGroup(agentGroupId);
  if (!agentGroup) {
    throw new Error(`Codex broker grant failed: unknown agent group ${agentGroupId}`);
  }

  const token = deps.randomToken();
  const grant: CodexBrokerGrant = {
    token,
    agentGroupId,
    sessionId: path.basename(sessionDir),
    sessionHostPath: sessionDir,
    groupHostPath: path.resolve(GROUPS_DIR, agentGroup.folder),
    defaultModel: deps.defaultModel,
    escalationModel: deps.escalationModel,
    createdAt: deps.now().toISOString(),
  };
  deps.writeGrant(deps.brokerGrantsDir, grant);

  return {
    mounts: [{ hostPath: deps.brokerSocket, containerPath: CONTAINER_BROKER_SOCKET, readonly: false }],
    env: {
      CODEX_PROVIDER_MODE: 'broker',
      CODEX_BROKER_SOCKET: CONTAINER_BROKER_SOCKET,
      CODEX_BROKER_TOKEN: token,
      CODEX_DEFAULT_MODEL: deps.defaultModel,
      CODEX_ESCALATION_MODEL: deps.escalationModel,
      HOME: '/home/node',
    },
  };
}

registerProviderContainerConfig('codex', (ctx) => buildCodexProviderContribution(ctx));
