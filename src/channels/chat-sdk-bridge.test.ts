import { describe, expect, it } from 'vitest';

import type { Adapter } from 'chat';

import { createChatSdkBridge, splitForLimit } from './chat-sdk-bridge.js';
import type { OutboundFile } from './adapter.js';

function stubAdapter(partial: Partial<Adapter>): Adapter {
  return { name: 'stub', ...partial } as unknown as Adapter;
}

type PostedPayload = {
  markdown?: string;
  files?: Array<{ filename: string; data: Buffer }>;
};

function file(filename: string): OutboundFile {
  return { filename, data: Buffer.from(filename) };
}

describe('splitForLimit', () => {
  it('returns a single chunk when text fits', () => {
    expect(splitForLimit('short text', 100)).toEqual(['short text']);
  });

  it('splits on paragraph boundaries when available', () => {
    const text = 'para one line one\npara one line two\n\npara two line one\npara two line two';
    const chunks = splitForLimit(text, 40);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(40);
  });

  it('falls back to line boundaries when no paragraph fits', () => {
    const text = 'alpha\nbravo\ncharlie\ndelta\necho\nfoxtrot';
    const chunks = splitForLimit(text, 15);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(15);
  });

  it('hard-cuts when no whitespace is available', () => {
    const text = 'a'.repeat(100);
    const chunks = splitForLimit(text, 30);
    expect(chunks.length).toBe(Math.ceil(100 / 30));
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(30);
    expect(chunks.join('')).toBe(text);
  });
});

describe('createChatSdkBridge', () => {
  // The bridge is now transport-only: forward inbound events, relay outbound
  // ops. All per-wiring engage / accumulate / drop / subscribe decisions live
  // in the router (src/router.ts routeInbound / evaluateEngage) and are
  // exercised by host-core.test.ts end-to-end. These tests only cover the
  // bridge's narrow, platform-adjacent surface.

  it('omits openDM when the underlying Chat SDK adapter has none', () => {
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({}),
      supportsThreads: false,
    });
    expect(bridge.openDM).toBeUndefined();
  });

  it('exposes openDM when the underlying adapter has one, and delegates directly', async () => {
    const openDMCalls: string[] = [];
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({
        openDM: async (userId: string) => {
          openDMCalls.push(userId);
          return `thread::${userId}`;
        },
        channelIdFromThreadId: (threadId: string) => `stub:${threadId.replace(/^thread::/, '')}`,
      }),
      supportsThreads: false,
    });
    expect(bridge.openDM).toBeDefined();
    const platformId = await bridge.openDM!('user-42');
    // Delegation: adapter.openDM → adapter.channelIdFromThreadId, no chat.openDM in between.
    expect(openDMCalls).toEqual(['user-42']);
    expect(platformId).toBe('stub:user-42');
  });

  it('exposes subscribe (lets the router initiate thread subscription on mention-sticky engage)', () => {
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({}),
      supportsThreads: true,
    });
    expect(typeof bridge.subscribe).toBe('function');
  });

  it('splits multiple outbound files into one Chat SDK post per file when text is present', async () => {
    const posts: Array<{ tid: string; payload: PostedPayload }> = [];
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({
        postMessage: (async (tid: string, payload: PostedPayload) => {
          posts.push({ tid, payload });
          return { id: `msg-${posts.length}` };
        }) as Adapter['postMessage'],
      }),
      supportsThreads: false,
    });

    const firstId = await bridge.deliver('stub:chat-1', null, {
      kind: 'message',
      content: { text: 'Here are the files' },
      files: [file('one.png'), file('two.png'), file('three.png')],
    });

    expect(firstId).toBe('msg-1');
    expect(posts).toHaveLength(3);
    expect(posts.map((post) => post.tid)).toEqual(['stub:chat-1', 'stub:chat-1', 'stub:chat-1']);
    expect(posts.map((post) => post.payload.markdown)).toEqual(['Here are the files', '', '']);
    expect(posts.map((post) => post.payload.files?.map((f) => f.filename))).toEqual([
      ['one.png'],
      ['two.png'],
      ['three.png'],
    ]);
    expect(posts.every((post) => (post.payload.files?.length ?? 0) <= 1)).toBe(true);
  });

  it('splits multiple file-only outbound messages into one Chat SDK post per file', async () => {
    const posts: PostedPayload[] = [];
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({
        postMessage: (async (_tid: string, payload: PostedPayload) => {
          posts.push(payload);
          return { id: `file-${posts.length}` };
        }) as Adapter['postMessage'],
      }),
      supportsThreads: false,
    });

    const firstId = await bridge.deliver('stub:chat-1', null, {
      kind: 'message',
      content: {},
      files: [file('first.pdf'), file('second.pdf')],
    });

    expect(firstId).toBe('file-1');
    expect(posts).toHaveLength(2);
    expect(posts.map((post) => post.markdown)).toEqual(['', '']);
    expect(posts.map((post) => post.files?.map((f) => f.filename))).toEqual([['first.pdf'], ['second.pdf']]);
    expect(posts.every((post) => (post.files?.length ?? 0) === 1)).toBe(true);
  });
});
