import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

import {
  CODEX_BROKER_GRANTS_DIR,
  CODEX_BROKER_SOCKET,
  CODEX_DEFAULT_MODEL,
  CODEX_ESCALATION_MODEL,
  GROUPS_DIR,
} from '../config.js';
import { getAgentGroup } from '../db/agent-groups.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

const CONTAINER_BROKER_SOCKET = '/run/nanoclaw-codex-broker.sock';

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

function writeGrant(grant: CodexBrokerGrant): void {
  fs.mkdirSync(CODEX_BROKER_GRANTS_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(CODEX_BROKER_GRANTS_DIR, 0o700);
  fs.writeFileSync(path.join(CODEX_BROKER_GRANTS_DIR, `${grant.token}.json`), JSON.stringify(grant, null, 2) + '\n', {
    mode: 0o600,
  });
}

registerProviderContainerConfig('codex', ({ sessionDir, agentGroupId }) => {
  if (!fs.existsSync(CODEX_BROKER_SOCKET)) {
    throw new Error(`Codex broker socket does not exist: ${CODEX_BROKER_SOCKET}`);
  }

  const agentGroup = getAgentGroup(agentGroupId);
  if (!agentGroup) {
    throw new Error(`Codex broker grant failed: unknown agent group ${agentGroupId}`);
  }

  const token = crypto.randomBytes(32).toString('hex');
  const grant: CodexBrokerGrant = {
    token,
    agentGroupId,
    sessionId: path.basename(sessionDir),
    sessionHostPath: sessionDir,
    groupHostPath: path.resolve(GROUPS_DIR, agentGroup.folder),
    defaultModel: CODEX_DEFAULT_MODEL,
    escalationModel: CODEX_ESCALATION_MODEL,
    createdAt: new Date().toISOString(),
  };
  writeGrant(grant);

  return {
    mounts: [{ hostPath: CODEX_BROKER_SOCKET, containerPath: CONTAINER_BROKER_SOCKET, readonly: false }],
    env: {
      CODEX_BROKER_SOCKET: CONTAINER_BROKER_SOCKET,
      CODEX_BROKER_TOKEN: token,
      CODEX_DEFAULT_MODEL,
      CODEX_ESCALATION_MODEL,
      HOME: '/home/node',
    },
  };
});
