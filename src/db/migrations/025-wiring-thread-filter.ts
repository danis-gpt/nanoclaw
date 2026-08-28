import type { Migration } from './index.js';

/**
 * Optional exact platform thread/topic boundary for one wiring.
 *
 * NULL preserves legacy fanout across every thread. A non-NULL value is
 * compared as an exact string by the router before engagement or accumulation.
 */
export const migration025: Migration = {
  version: 25,
  name: 'wiring-thread-filter',
  async up(db) {
    await db.exec(`
      ALTER TABLE messaging_group_agents ADD COLUMN thread_filter TEXT;
      CREATE INDEX idx_mga_messaging_group_thread_filter
        ON messaging_group_agents(messaging_group_id, thread_filter);
    `);
  },
};
