import fs from 'fs';
import path from 'path';
import readline from 'readline';

import { GROUPS_DIR } from '../config.js';
import { ArchiveDatabase } from './db.js';
import { ARCHIVE_RAW_DIR } from './paths.js';
import { ArchivedMessage, ChunkRef } from './types.js';

export interface StagingOptions {
  groupFolder: string;
  limit?: number;
  db: ArchiveDatabase;
  rawDir?: string;
  sampleSize?: number;
}

/**
 * Stage pending archive chunks into the group's `wiki/sources/archive/...`
 * directory so the existing LLM-wiki ingest workflow (add-karpathy-llm-wiki)
 * can process them incrementally, one at a time.
 *
 * Staging is deliberately non-summarizing: we emit a structured Markdown
 * source file per chunk with metadata, participants, and a representative
 * text sample (to let humans sanity-check without opening the NDJSON). The
 * full NDJSON path is linked so the LLM can load more if it wants.
 */
export async function stageChunksForWiki(opts: StagingOptions): Promise<{ staged: ChunkRef[]; dir: string }> {
  const groupDir = path.join(GROUPS_DIR, opts.groupFolder);
  if (!fs.existsSync(groupDir)) {
    throw new Error(`group folder not found: ${groupDir}`);
  }
  const wikiSourcesDir = path.join(groupDir, 'wiki', 'sources', 'archive');
  fs.mkdirSync(wikiSourcesDir, { recursive: true });

  const pending = opts.db.listChunks({
    wikiPending: true,
    limit: opts.limit ?? 5,
  });
  const staged: ChunkRef[] = [];

  for (const chunk of pending) {
    const abs = path.join(opts.rawDir ?? ARCHIVE_RAW_DIR, chunk.path);
    if (!fs.existsSync(abs)) continue;
    const summary = await summarizeChunk(abs, opts.sampleSize ?? 20);
    const outDir = path.join(wikiSourcesDir, chunk.platform, sanitize(chunk.chat_jid));
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, `${chunk.month}.md`);
    fs.writeFileSync(outPath, renderMarkdown(chunk, abs, summary));
    opts.db.markChunkIngested(chunk.id);
    staged.push(chunk);
  }

  return { staged, dir: wikiSourcesDir };
}

interface ChunkSummary {
  count: number;
  participants: Array<{ name: string; messages: number }>;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  sample: ArchivedMessage[];
  mediaCount: number;
}

async function summarizeChunk(absPath: string, sampleSize: number): Promise<ChunkSummary> {
  const rl = readline.createInterface({
    input: fs.createReadStream(absPath),
    crlfDelay: Infinity,
  });
  const participants = new Map<string, number>();
  let count = 0;
  let firstTimestamp: string | null = null;
  let lastTimestamp: string | null = null;
  let mediaCount = 0;
  const sample: ArchivedMessage[] = [];

  for await (const line of rl) {
    if (!line.trim()) continue;
    let msg: ArchivedMessage;
    try {
      msg = JSON.parse(line);
      // eslint-disable-next-line no-catch-all/no-catch-all -- this boundary has an explicit fallback for the failure
    } catch {
      continue;
    }
    count += 1;
    if (!firstTimestamp || msg.timestamp < firstTimestamp) {
      firstTimestamp = msg.timestamp;
    }
    if (!lastTimestamp || msg.timestamp > lastTimestamp) {
      lastTimestamp = msg.timestamp;
    }
    const who = msg.sender_name || msg.sender_id || '(unknown)';
    participants.set(who, (participants.get(who) ?? 0) + 1);
    if (msg.media_type) mediaCount += 1;
    // Reservoir sampling: first `sampleSize` items always kept, later items
    // replace a random earlier one with probability sampleSize/count. Works
    // uniformly whether the chunk has 5 or 500 000 messages.
    if (msg.text) {
      if (sample.length < sampleSize) {
        sample.push(msg);
      } else {
        const j = Math.floor(Math.random() * count);
        if (j < sampleSize) sample[j] = msg;
      }
    }
  }
  sample.sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));
  const top = [...participants.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([name, messages]) => ({ name, messages }));
  return {
    count,
    participants: top,
    firstTimestamp,
    lastTimestamp,
    sample,
    mediaCount,
  };
}

function renderMarkdown(chunk: ChunkRef, absPath: string, s: ChunkSummary): string {
  const lines: string[] = [];
  lines.push(`# Archive chunk: ${chunk.chat_title ?? chunk.chat_jid}`);
  lines.push('');
  lines.push(`- platform: \`${chunk.platform}\``);
  lines.push(`- chat_jid: \`${chunk.chat_jid}\``);
  lines.push(`- month: \`${chunk.month}\``);
  lines.push(`- messages: ${s.count}`);
  lines.push(`- media: ${s.mediaCount}`);
  lines.push(`- range: ${s.firstTimestamp ?? '?'} → ${s.lastTimestamp ?? '?'}`);
  lines.push(`- ndjson: \`${absPath}\``);
  lines.push('');
  lines.push('## Top participants');
  lines.push('');
  for (const p of s.participants) {
    lines.push(`- ${p.name} — ${p.messages}`);
  }
  lines.push('');
  lines.push('## Sample messages');
  lines.push('');
  for (const m of s.sample) {
    const who = m.sender_name ?? m.sender_id ?? '(unknown)';
    const text = m.text.replace(/\n/g, ' ').trim().slice(0, 400);
    lines.push(`- **${m.timestamp} — ${who}:** ${text}`);
  }
  lines.push('');
  lines.push(
    '> Ingest instructions: load this summary first, then read the linked NDJSON in bounded windows. Do NOT dump the raw corpus into CLAUDE.md.',
  );
  lines.push('');
  return lines.join('\n');
}

function sanitize(s: string): string {
  return s.replace(/[^a-z0-9._-]+/gi, '_').slice(0, 120);
}
