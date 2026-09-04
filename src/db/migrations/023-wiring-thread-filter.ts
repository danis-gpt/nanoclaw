import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

/**
 * Optional exact platform thread/topic boundary for one wiring.
 *
 * NULL preserves legacy fanout across every thread. A non-NULL value is
 * compared as an exact string by the router before engagement or accumulation.
 */
export const migration023: Migration = {
  version: 23,
  name: 'wiring-thread-filter',
  up(db: Database.Database) {
    db.exec(`
      ALTER TABLE messaging_group_agents ADD COLUMN thread_filter TEXT;
      CREATE INDEX idx_mga_messaging_group_thread_filter
        ON messaging_group_agents(messaging_group_id, thread_filter);
    `);
  },
};
