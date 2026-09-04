import { describe, expect, it } from 'bun:test';

import { createIdleTracker } from './idle-tracker.js';

describe('idle tracker', () => {
  it('does not exit until work has completed and the full idle window elapsed', () => {
    let now = 0;
    const tracker = createIdleTracker(1_000, () => now);

    now = 10_000;
    expect(tracker.shouldExit()).toBe(false);

    tracker.markActivity();
    now = 10_999;
    expect(tracker.shouldExit()).toBe(false);
    now = 11_001;
    expect(tracker.shouldExit()).toBe(true);
  });

  it('re-arms after activity and stays disabled for non-positive timeouts', () => {
    let now = 0;
    const tracker = createIdleTracker(1_000, () => now);
    tracker.markActivity();
    now = 1_001;
    expect(tracker.shouldExit()).toBe(true);
    tracker.markActivity();
    now = 1_500;
    expect(tracker.shouldExit()).toBe(false);

    const disabled = createIdleTracker(0, () => now);
    disabled.markActivity();
    now = 100_000;
    expect(disabled.shouldExit()).toBe(false);
  });
});
