import net from 'node:net';
import path from 'node:path';

export type PrivateActionName =
  | 'idea_create'
  | 'idea_add_observation'
  | 'idea_prepare_review'
  | 'idea_reopen'
  | 'idea_record_product_decision'
  | 'idea_record_technical_decision'
  | 'idea_convert_to_feature'
  | 'feature_update_specification'
  | 'feature_advance'
  | 'prd_create_draft'
  | 'prd_update_draft';

export interface PrivateActionRequest {
  name: PrivateActionName;
  grantId: string;
  operationKey: string;
  actorUserId: string;
  sourceEventId: string;
  payload: Record<string, unknown>;
}

export interface PrivateClientOptions {
  socketPath?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export class PendingVerificationError extends Error {
  readonly pendingVerification = true;

  constructor() {
    super('private connector timed out after request write; result is pending verification');
    this.name = 'PendingVerificationError';
  }
}

function safeError(message: unknown): string {
  const text = typeof message === 'string' ? message : 'private connector request failed';
  return text
    .replace(/plane_api_[A-Za-z0-9_-]+/gu, '<redacted>')
    .replace(/ol_api_[A-Za-z0-9_-]+/gu, '<redacted>')
    .replace(/Bearer\s+\S+/giu, 'Bearer <redacted>')
    .slice(0, 500);
}

export function callPrivateConnector(
  request: PrivateActionRequest,
  options: PrivateClientOptions = {},
): Promise<Record<string, unknown>> {
  const socketPath = options.socketPath ?? process.env.IDEA_FEATURE_PRIVATE_SOCKET ?? '';
  if (!socketPath || !path.isAbsolute(socketPath)) {
    return Promise.reject(new Error('IDEA_FEATURE_PRIVATE_SOCKET must be an absolute path'));
  }
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxResponseBytes = options.maxResponseBytes ?? 1024 * 1024;
  const encoded = `${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'actions/call',
    params: {
      name: request.name,
      grant_id: request.grantId,
      operation_key: request.operationKey,
      actor_user_id: request.actorUserId,
      source_event_id: request.sourceEventId,
      payload: request.payload,
    },
  })}\n`;

  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    let settled = false;
    let writeCompleted = false;
    let response = '';

    const finish = (error?: Error, result?: Record<string, unknown>): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(result ?? {});
    };

    socket.setEncoding('utf8');
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      socket.write(encoded, 'utf8', () => {
        writeCompleted = true;
      });
    });
    socket.on('data', (chunk: string) => {
      response += chunk;
      if (Buffer.byteLength(response, 'utf8') > maxResponseBytes) {
        finish(new Error('private connector response exceeded limit'));
        return;
      }
      const newline = response.indexOf('\n');
      if (newline < 0) return;
      try {
        const rpc = JSON.parse(response.slice(0, newline)) as {
          jsonrpc?: unknown;
          id?: unknown;
          result?: unknown;
          error?: { message?: unknown };
        };
        if (rpc.jsonrpc !== '2.0' || rpc.id !== 1) throw new Error('private connector returned an invalid response');
        if (rpc.error) throw new Error(safeError(rpc.error.message));
        if (!rpc.result || typeof rpc.result !== 'object' || Array.isArray(rpc.result)) {
          throw new Error('private connector returned an invalid result');
        }
        finish(undefined, rpc.result as Record<string, unknown>);
        // eslint-disable-next-line no-catch-all/no-catch-all -- the protocol boundary turns any malformed response into a bounded failure
      } catch (error) {
        finish(error instanceof Error ? error : new Error('private connector returned invalid JSON'));
      }
    });
    socket.once('timeout', () => {
      finish(writeCompleted ? new PendingVerificationError() : new Error('private connector timed out before write'));
    });
    socket.once('error', (error) => {
      finish(new Error(`private connector unavailable: ${safeError(error.message)}`));
    });
    socket.once('end', () => {
      if (!settled) finish(new Error('private connector closed without a response'));
    });
  });
}
