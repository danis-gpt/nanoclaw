import { expect, test } from 'bun:test';

import './index.js';
import '../provider-contracts/index.js';
import { createProvider } from './factory.js';
import { CodexProvider } from './codex.js';

for (const mode of ['native', 'broker']) {
  test(`the stock Codex factory ignores the retired ${mode} routing override`, () => {
    const provider = createProvider('codex', { env: { CODEX_PROVIDER_MODE: mode } });
    expect(provider).toBeInstanceOf(CodexProvider);
  });
}
