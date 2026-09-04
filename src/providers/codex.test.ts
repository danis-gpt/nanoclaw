import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it, vi } from 'vitest';

import { buildCodexProviderContribution, prepareAgentCodexHome, type CodexProviderContributionDeps } from './codex.js';

const baseDeps = {
  mode: 'broker',
  brokerSocket: '/run/codex.sock',
  brokerGrantsDir: '/tmp/codex-grants',
  codexHome: '/home/ubuntu/.codex',
  agentCodexHome: '/var/lib/nanoclaw/codex-home',
  defaultModel: 'gpt-5.3-codex',
  escalationModel: 'auto-frontier',
  autoEscalation: true,
  autoEscalationMinScore: 3,
  autoEscalationLongPromptChars: 20000,
  socketExists: () => true,
  getAgentGroup: () => ({ id: 'ag-1', folder: 'aura' }),
  writeGrant: vi.fn(),
  prepareAgentCodexHome: vi.fn(),
  randomToken: () => 'token-1',
  now: () => new Date('2026-06-09T00:00:00.000Z'),
} satisfies CodexProviderContributionDeps;

const baseContext = {
  sessionDir: '/sessions/s1',
  agentGroupId: 'ag-1',
  groupDir: '/groups/aura',
  selectedSkills: [],
  hostEnv: {},
};

describe('buildCodexProviderContribution', () => {
  it('native mode mounts isolated agent Codex home and does not require broker socket or grant', () => {
    const writeGrant = vi.fn();
    const prepareAgentCodexHome = vi.fn();
    const contribution = buildCodexProviderContribution(baseContext, {
      ...baseDeps,
      mode: 'native',
      socketExists: () => false,
      writeGrant,
      prepareAgentCodexHome,
    });

    expect(writeGrant).not.toHaveBeenCalled();
    expect(prepareAgentCodexHome).toHaveBeenCalledWith('/home/ubuntu/.codex', '/var/lib/nanoclaw/codex-home');
    expect(contribution.mounts).toEqual([
      { hostPath: '/var/lib/nanoclaw/codex-home', containerPath: '/home/ubuntu/.codex', readonly: false },
      { hostPath: '/var/lib/nanoclaw/codex-home', containerPath: '/home/node/.codex', readonly: false },
    ]);
    expect(contribution.env).toMatchObject({
      CODEX_PROVIDER_MODE: 'native',
      CODEX_HOME: '/home/ubuntu/.codex',
      HOME: '/home/ubuntu',
      CODEX_DEFAULT_MODEL: 'gpt-5.3-codex',
      CODEX_ESCALATION_MODEL: 'auto-frontier',
      CODEX_AUTO_ESCALATION: 'true',
      CODEX_AUTO_ESCALATION_MIN_SCORE: '3',
      CODEX_AUTO_ESCALATION_LONG_PROMPT_CHARS: '20000',
    });
    expect(contribution.env).not.toHaveProperty('CODEX_BROKER_TOKEN');
    expect(contribution.env).not.toHaveProperty('CODEX_BROKER_SOCKET');
  });

  it('broker mode keeps socket mount and writes a scoped grant', () => {
    const writeGrant = vi.fn();
    const contribution = buildCodexProviderContribution(baseContext, {
      ...baseDeps,
      mode: 'broker',
      writeGrant,
    });

    expect(writeGrant).toHaveBeenCalledWith('/tmp/codex-grants', {
      token: 'token-1',
      agentGroupId: 'ag-1',
      sessionId: 's1',
      sessionHostPath: '/sessions/s1',
      groupHostPath: expect.stringContaining('/groups/aura'),
      defaultModel: 'gpt-5.3-codex',
      escalationModel: 'auto-frontier',
      createdAt: '2026-06-09T00:00:00.000Z',
    });
    expect(contribution.mounts).toEqual([
      { hostPath: '/run/codex.sock', containerPath: '/run/nanoclaw-codex-broker.sock', readonly: false },
    ]);
    expect(contribution.env).toMatchObject({
      CODEX_PROVIDER_MODE: 'broker',
      CODEX_BROKER_SOCKET: '/run/nanoclaw-codex-broker.sock',
      CODEX_BROKER_TOKEN: 'token-1',
    });
  });
});

describe('prepareAgentCodexHome', () => {
  it('seeds only minimal Codex state and leaves user skills behind', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-codex-home-test-'));
    try {
      const sourceHome = path.join(tmp, 'source');
      const agentHome = path.join(tmp, 'agent');
      fs.mkdirSync(path.join(sourceHome, 'skills', 'planning'), { recursive: true });
      fs.writeFileSync(path.join(sourceHome, 'auth.json'), '{"ok":true}\n');
      fs.writeFileSync(path.join(sourceHome, 'models_cache.json'), '{"models":[]}\n');
      fs.writeFileSync(path.join(sourceHome, 'config.toml'), 'model = "gpt-5.5"\n');
      fs.writeFileSync(path.join(sourceHome, 'skills', 'planning', 'SKILL.md'), 'large workflow');

      prepareAgentCodexHome(sourceHome, agentHome);

      expect(fs.readFileSync(path.join(agentHome, 'auth.json'), 'utf8')).toBe('{"ok":true}\n');
      expect(fs.readFileSync(path.join(agentHome, 'models_cache.json'), 'utf8')).toBe('{"models":[]}\n');
      expect(fs.existsSync(path.join(agentHome, 'config.toml'))).toBe(false);
      expect(fs.existsSync(path.join(agentHome, 'skills'))).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
