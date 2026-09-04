import { createHash, timingSafeEqual } from 'node:crypto';

import { HOLD, defineGuardedAction, type GuardInput } from '../../guard/index.js';
import type { PendingApproval } from '../../types.js';

function normalize(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonical JSON does not support non-finite numbers');
    return value;
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(object).sort()) {
      if (object[key] === undefined) throw new Error('canonical JSON does not support undefined values');
      result[key] = normalize(object[key]);
    }
    return result;
  }
  throw new Error(`canonical JSON does not support ${typeof value}`);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

export function canonicalHash(value: unknown): Buffer {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest();
}

function grantCoversRequest(grant: PendingApproval, input: GuardInput): boolean {
  try {
    if (
      grant.status !== 'pending' ||
      !grant.expires_at ||
      !Number.isFinite(Date.parse(grant.expires_at)) ||
      Date.parse(grant.expires_at) <= Date.now()
    )
      return false;
    const heldPayload = JSON.parse(grant.payload) as unknown;
    return timingSafeEqual(canonicalHash(heldPayload), canonicalHash(input.payload));
    // eslint-disable-next-line no-catch-all/no-catch-all -- malformed or non-canonical approval payloads deny by contract
  } catch {
    return false;
  }
}

export const ideaFeatureMutation = defineGuardedAction({
  action: 'idea_feature.mutate',
  grantActionName: 'idea_feature_request',
  decide: () => HOLD('explicit human confirmation required'),
  grantCoversRequest,
});
