import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { PendingVerificationError, callPrivateConnector } from './private-client.js';

const servers: net.Server[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function socketServer(handler: (request: Record<string, unknown>, socket: net.Socket) => void): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-feature-private-'));
  tempDirs.push(dir);
  const socketPath = path.join(dir, 'private.sock');
  const server = net.createServer((socket) => {
    let data = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      data += chunk;
      const newline = data.indexOf('\n');
      if (newline < 0) return;
      const request = JSON.parse(data.slice(0, newline)) as Record<string, unknown>;
      handler(request, socket);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => server.listen(socketPath, resolve).once('error', reject));
  return socketPath;
}

function input() {
  return {
    name: 'idea_create' as const,
    grantId: 'appr-1',
    operationKey: 'idea-feature:appr-1',
    actorUserId: 'telegram:119',
    sourceEventId: '-1000000000001:119:ag-product',
    payload: { idea: { title: 'Onboarding' } },
  };
}

describe('callPrivateConnector', () => {
  it('writes the fixed JSON-RPC envelope and returns the connector read-back', async () => {
    let observed: Record<string, unknown> | undefined;
    const socketPath = await socketServer((request, socket) => {
      observed = request;
      socket.end(`${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { idea_id: 'IDEA-1' } })}\n`);
    });

    await expect(callPrivateConnector(input(), { socketPath, timeoutMs: 1_000 })).resolves.toEqual({
      idea_id: 'IDEA-1',
    });
    expect(observed).toMatchObject({
      jsonrpc: '2.0',
      method: 'actions/call',
      params: {
        name: 'idea_create',
        grant_id: 'appr-1',
        operation_key: 'idea-feature:appr-1',
        actor_user_id: 'telegram:119',
        source_event_id: '-1000000000001:119:ag-product',
        payload: { idea: { title: 'Onboarding' } },
      },
    });
  });

  it('turns a timeout after socket write into pending verification', async () => {
    const socketPath = await socketServer(() => {
      // Deliberately retain the connection without a response.
    });

    const error = await callPrivateConnector(input(), { socketPath, timeoutMs: 30 }).catch((caught) => caught);
    expect(error).toBeInstanceOf(PendingVerificationError);
    expect(error.message).toContain('pending verification');
  });

  it('surfaces a bounded connector error without treating it as pending', async () => {
    const socketPath = await socketServer((_request, socket) => {
      socket.end(`${JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'bad payload' } })}\n`);
    });

    await expect(callPrivateConnector(input(), { socketPath, timeoutMs: 1_000 })).rejects.toThrow('bad payload');
  });
});
