import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration021: Migration = {
  version: 21,
  name: 'container-idle-timeout',
  up(db: Database.Database) {
    db.prepare('ALTER TABLE container_configs ADD COLUMN idle_timeout_ms INTEGER').run();
  },
};
