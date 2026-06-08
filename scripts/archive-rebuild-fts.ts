#!/usr/bin/env tsx
/**
 * CLI: rebuild the FTS5 index from the content table.
 * Useful after manual edits, schema upgrades, or corruption.
 */
import { ArchiveDatabase } from '../src/archive/db.js';

async function main() {
  const db = new ArchiveDatabase();
  try {
    db.rebuildFts();
    console.log('FTS index rebuilt.');
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error('archive-rebuild-fts failed:', err);
  process.exit(1);
});
