import type { Migration } from './index.js';
export const migration021: Migration = {
  version: 21,
  name: 'container-idle-timeout',
  async up(db) {
    await db.exec('ALTER TABLE container_configs ADD COLUMN idle_timeout_ms INTEGER');
  },
};
