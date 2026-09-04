/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Two auth modes:
 *   API key:  Proxy injects x-api-key on every request.
 *   OAuth:    Container CLI exchanges its placeholder token for a temp
 *             API key via /api/oauth/claude_cli/create_api_key.
 *             Proxy injects real OAuth token on that exchange request;
 *             subsequent requests carry the temp key which is valid as-is.
 */
import { createServer, type Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, type RequestOptions } from 'http';

import { readEnvFile } from './env.js';
import { log } from './log.js';

export type AuthMode = 'api-key' | 'oauth';

export function startCredentialProxy(
  port: number,
  host = process.env.CREDENTIAL_PROXY_HOST || '127.0.0.1',
): Promise<Server> {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  ]);

  // Reverse model map: glm-* → claude-* for response rewriting
  const modelRewriteReverse: Record<string, string> = {};
  if (secrets.ANTHROPIC_DEFAULT_SONNET_MODEL)
    modelRewriteReverse[secrets.ANTHROPIC_DEFAULT_SONNET_MODEL] = 'claude-sonnet-4-6';
  if (secrets.ANTHROPIC_DEFAULT_OPUS_MODEL)
    modelRewriteReverse[secrets.ANTHROPIC_DEFAULT_OPUS_MODEL] = 'claude-opus-4-7';
  if (secrets.ANTHROPIC_DEFAULT_HAIKU_MODEL)
    modelRewriteReverse[secrets.ANTHROPIC_DEFAULT_HAIKU_MODEL] = 'claude-haiku-4-5';

  const modelRewrite: Record<string, string> = {};
  if (secrets.ANTHROPIC_DEFAULT_SONNET_MODEL)
    modelRewrite['claude-sonnet-4-6'] = secrets.ANTHROPIC_DEFAULT_SONNET_MODEL;
  if (secrets.ANTHROPIC_DEFAULT_OPUS_MODEL) modelRewrite['claude-opus-4-7'] = secrets.ANTHROPIC_DEFAULT_OPUS_MODEL;
  if (secrets.ANTHROPIC_DEFAULT_HAIKU_MODEL) modelRewrite['claude-haiku-4-5'] = secrets.ANTHROPIC_DEFAULT_HAIKU_MODEL;

  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
  const oauthToken = secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;

  const upstreamUrl = new URL(secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com');
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;
  const basePath = upstreamUrl.pathname.replace(/\/$/, '');

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        log.info('Proxy request', { method: req.method, url: req.url });
        let body = Buffer.concat(chunks);

        // Debug: log request body for non-HEAD requests
        if (req.method !== 'HEAD' && body.length > 0) {
          try {
            const json = JSON.parse(body.toString('utf-8'));
            log.debug('Request body', { body: json });
            // eslint-disable-next-line no-catch-all/no-catch-all -- this boundary has an explicit fallback for the failure
          } catch {
            log.debug('Request body (raw)', { body: body.toString('utf-8').substring(0, 500) });
          }
        }

        if (Object.keys(modelRewrite).length > 0) {
          try {
            const json = JSON.parse(body.toString('utf-8'));
            if (json.model && modelRewrite[json.model]) {
              const from = json.model;
              json.model = modelRewrite[json.model];
              body = Buffer.from(JSON.stringify(json), 'utf-8');
              log.debug('Model rewritten', { from, to: json.model });
            }
            // eslint-disable-next-line no-catch-all/no-catch-all -- this boundary has an explicit fallback for the failure
          } catch {
            // Not JSON or unparseable — pass through as-is
          }
        }

        const headers: Record<string, string | number | string[] | undefined> = {
          ...(req.headers as Record<string, string>),
          host: upstreamUrl.host,
          'content-length': body.length,
        };

        delete headers['connection'];
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];

        if (authMode === 'api-key') {
          delete headers['x-api-key'];
          headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
        } else {
          if (headers['authorization']) {
            delete headers['authorization'];
            if (oauthToken) {
              headers['authorization'] = `Bearer ${oauthToken}`;
            }
          }
        }

        const upstream = makeRequest(
          {
            hostname: upstreamUrl.hostname,
            port: upstreamUrl.port || (isHttps ? 443 : 80),
            path: basePath + req.url,
            method: req.method,
            headers,
          } as RequestOptions,
          (upRes) => {
            const contentType = upRes.headers['content-type'] || '';
            const isJson = contentType.includes('application/json');
            const isSSE = contentType.includes('text/event-stream');

            if (isJson && Object.keys(modelRewriteReverse).length > 0) {
              // Non-streaming: rewrite model in JSON response
              const chunks: Buffer[] = [];
              upRes.on('data', (c: Buffer) => chunks.push(c));
              upRes.on('end', () => {
                try {
                  const json = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
                  if (json.model && modelRewriteReverse[json.model]) {
                    json.model = modelRewriteReverse[json.model];
                  }
                  const body = Buffer.from(JSON.stringify(json), 'utf-8');
                  const headers = { ...upRes.headers, 'content-length': body.length };
                  res.writeHead(upRes.statusCode!, headers);
                  res.end(body);
                  // eslint-disable-next-line no-catch-all/no-catch-all -- this boundary has an explicit fallback for the failure
                } catch {
                  res.writeHead(upRes.statusCode!, upRes.headers);
                  res.end(Buffer.concat(chunks));
                }
              });
            } else if (isSSE && Object.keys(modelRewriteReverse).length > 0) {
              // Streaming: rewrite model in SSE data events
              res.writeHead(upRes.statusCode!, upRes.headers);
              let buffer = '';
              upRes.on('data', (chunk: Buffer) => {
                buffer += chunk.toString('utf-8');
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';
                for (const line of lines) {
                  if (line.startsWith('data: ') && line.length > 6) {
                    try {
                      const json = JSON.parse(line.slice(6));
                      if (json.model && modelRewriteReverse[json.model]) {
                        json.model = modelRewriteReverse[json.model];
                      }
                      res.write(`data: ${JSON.stringify(json)}\n\n`);
                      continue;
                      // eslint-disable-next-line no-catch-all/no-catch-all -- this boundary has an explicit fallback for the failure
                    } catch {
                      /* not JSON, pass through */
                    }
                  }
                  res.write(line + '\n');
                }
              });
              upRes.on('end', () => {
                if (buffer) res.write(buffer);
                res.end();
              });
            } else {
              res.writeHead(upRes.statusCode!, upRes.headers);
              upRes.pipe(res);
            }
          },
        );

        upstream.on('error', (err) => {
          log.error('Credential proxy upstream error', { err, url: req.url });
          if (!res.headersSent) {
            res.writeHead(502);
            res.end('Bad Gateway');
          }
        });

        upstream.write(body);
        upstream.end();
      });
    });

    server.listen(port, host, () => {
      log.info('Credential proxy started', { port, host, authMode });
      resolve(server);
    });

    server.on('error', reject);
  });
}

export function detectAuthMode(): AuthMode {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
  return secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
}
