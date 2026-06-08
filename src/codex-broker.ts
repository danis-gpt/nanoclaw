import fs from 'fs';
import http from 'http';
import path from 'path';

import { CODEX_BROKER_GRANTS_DIR, CODEX_BROKER_SOCKET } from './config.js';
import { runCodex, type BrokerRequest, type CodexBrokerGrant } from './codex-broker-runner.js';
import { log } from './log.js';

const MAX_REQUEST_BYTES = 20 * 1024 * 1024;

function grantPath(token: string): string {
  return path.join(CODEX_BROKER_GRANTS_DIR, `${token}.json`);
}

function readGrant(token: string): CodexBrokerGrant {
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('invalid broker token');
  const p = grantPath(token);
  if (!fs.existsSync(p)) throw new Error('unknown broker token');
  return JSON.parse(fs.readFileSync(p, 'utf8')) as CodexBrokerGrant;
}

function readJsonBody(req: http.IncomingMessage): Promise<BrokerRequest> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        reject(new Error('request too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as BrokerRequest);
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/v1/query') {
    writeJson(res, 404, { error: 'not found' });
    return;
  }

  try {
    const body = await readJsonBody(req);
    const token = body.token;
    if (!token) throw new Error('token is required');
    const grant = readGrant(token);
    const result = await runCodex(body, grant);
    writeJson(res, 200, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn('Codex broker request failed', { err: message });
    writeJson(res, 500, { error: message });
  }
});

fs.mkdirSync(path.dirname(CODEX_BROKER_SOCKET), { recursive: true });
try {
  fs.unlinkSync(CODEX_BROKER_SOCKET);
} catch {
  /* missing or already gone */
}

server.listen(CODEX_BROKER_SOCKET, () => {
  fs.chmodSync(CODEX_BROKER_SOCKET, 0o600);
  log.info('Codex broker listening', { socket: CODEX_BROKER_SOCKET });
});

function shutdown(signal: string): void {
  log.info('Codex broker shutdown signal received', { signal });
  server.close(() => {
    try {
      fs.unlinkSync(CODEX_BROKER_SOCKET);
    } catch {
      /* already removed */
    }
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
