import { expect, test } from 'bun:test';

import './index.js';
import '../provider-contracts/index.js';
import { createProvider } from './factory.js';
import { CodexProvider as NativeCodexProvider } from './codex-native.js';

for (const mode of ['native', 'broker']) {
  test(`the installed Codex factory preserves the explicitly configured ${mode} lane`, () => {
    const provider = createProvider('codex', { env: { CODEX_PROVIDER_MODE: mode } });
    expect(provider).toBeInstanceOf(NativeCodexProvider);
  });
}
