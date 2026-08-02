export interface IdleTracker {
  markActivity(): void;
  shouldExit(): boolean;
}

/**
 * Tracks completed work, not merely container uptime. This prevents a newly
 * started container from exiting before its first trigger arrives.
 */
export function createIdleTracker(idleTimeoutMs: number, now: () => number = Date.now): IdleTracker {
  let lastActivityAt = now();
  let hasProcessedAtLeastOneBatch = false;

  return {
    markActivity(): void {
      lastActivityAt = now();
      hasProcessedAtLeastOneBatch = true;
    },
    shouldExit(): boolean {
      return idleTimeoutMs > 0 && hasProcessedAtLeastOneBatch && now() - lastActivityAt > idleTimeoutMs;
    },
  };
}
