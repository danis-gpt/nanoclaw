import { describe, expect, it } from 'bun:test';

import { codexAppFeatureArgs } from './codex-app-policy.js';

describe('codexAppFeatureArgs', () => {
  it('disables connected Codex apps when the workspace policy marker exists', () => {
    const args = codexAppFeatureArgs('/workspace/agent', (path) => path === '/workspace/agent/.codex-apps-disabled');

    expect(args).toEqual(['--disable', 'apps', '--disable', 'plugins']);
  });

  it('leaves connected Codex apps enabled without the workspace policy marker', () => {
    expect(codexAppFeatureArgs('/workspace/agent', () => false)).toEqual([]);
  });
});
