import { createHash } from 'node:crypto';

import { getMessagingGroup } from '../../db/messaging-groups.js';
import type { PendingApproval, Session } from '../../types.js';
import { notifyAgent } from '../approvals/index.js';
import { getUser } from '../permissions/db/users.js';
import { canonicalJson } from './guard.js';
import {
  callPrivateConnector,
  PendingVerificationError,
  type PrivateActionName,
  type PrivateActionRequest,
} from './private-client.js';
import { parseIdeaFeatureRequest, type HostBinding } from './request.js';

interface ApplyDependencies {
  callConnector?: (request: PrivateActionRequest) => Promise<Record<string, unknown>>;
  notify?: (session: Session, text: string) => void;
  operationContext?: (session: Session) => { instance: string; platformId: string };
  now?: () => string;
}

export function operationKeyFor(
  channelInstance: string,
  platformId: string,
  sourceEventId: string,
  operation: PrivateActionName,
): string {
  return createHash('sha256')
    .update(`${channelInstance}|${platformId}|${sourceEventId}|${operation}|1`, 'utf8')
    .digest('hex');
}

function defaultOperationContext(session: Session): { instance: string; platformId: string } {
  if (!session.messaging_group_id) throw new Error('Idea Feature action requires a channel session');
  const group = getMessagingGroup(session.messaging_group_id);
  if (!group || group.channel_type !== 'telegram') throw new Error('Idea Feature action requires a Telegram session');
  return { instance: group.instance ?? group.channel_type, platformId: group.platform_id };
}

function hostBinding(value: unknown, grant: PendingApproval): HostBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('host binding is missing');
  const binding = value as Record<string, unknown>;
  const expected = ['approverUserId', 'requiredRole', 'verifiedActorUserId'];
  if (Object.keys(binding).sort().join('|') !== expected.join('|')) throw new Error('host binding is invalid');
  if (
    typeof binding.verifiedActorUserId !== 'string' ||
    typeof binding.approverUserId !== 'string' ||
    ![null, 'product_approver', 'technical_approver'].includes(binding.requiredRole as string | null)
  ) {
    throw new Error('host binding is invalid');
  }
  if (!grant.approver_user_id || grant.approver_user_id !== binding.approverUserId) {
    throw new Error('approval grant actor does not match host binding');
  }
  return binding as unknown as HostBinding;
}

function privatePayload(
  operation: PrivateActionName,
  request: Record<string, unknown>,
  binding: HostBinding,
  sourceEventId: string,
  decidedAt: string,
): Record<string, unknown> {
  if (operation === 'idea_create') return { idea: request };
  if (operation !== 'idea_record_product_decision' && operation !== 'idea_record_technical_decision') return request;

  const kind = operation === 'idea_record_product_decision' ? 'product' : 'technical';
  const expectedRole = kind === 'product' ? 'product_approver' : 'technical_approver';
  if (binding.requiredRole !== expectedRole) throw new Error(`decision requires live ${expectedRole}`);
  const user = getUser(binding.approverUserId);
  if (!user) throw new Error('verified decision actor no longer exists');
  return {
    task_id: request.task_id,
    decision: {
      schema_version: 1,
      decision_id: request.decision_id,
      kind,
      outcome: request.outcome,
      actor_user_id: binding.approverUserId,
      actor_display_name: user.display_name ?? binding.approverUserId,
      decided_at: decidedAt,
      comment: request.comment,
      source_event_id: sourceEventId,
      supersedes_decision_id: request.supersedes_decision_id ?? null,
    },
  };
}

/** Handler body reached only after the guarded replay accepted a still-live approval row. */
export async function applyIdeaFeatureMutation(
  content: Record<string, unknown>,
  session: Session,
  grant: PendingApproval | null,
  dependencies: ApplyDependencies = {},
): Promise<void> {
  if (!grant || grant.action !== 'idea_feature_request')
    throw new Error('Idea Feature mutation requires a live approval grant');
  const parsed = parseIdeaFeatureRequest(content);
  const binding = hostBinding(content._host, grant);
  const context = (dependencies.operationContext ?? defaultOperationContext)(session);
  const connectorRequest: PrivateActionRequest = {
    name: parsed.operation,
    grantId: grant.approval_id,
    operationKey: operationKeyFor(context.instance, context.platformId, parsed.sourceEventId, parsed.operation),
    actorUserId: binding.approverUserId,
    sourceEventId: parsed.sourceEventId,
    payload: privatePayload(
      parsed.operation,
      parsed.request,
      binding,
      parsed.sourceEventId,
      (dependencies.now ?? (() => new Date().toISOString()))(),
    ),
  };
  const notify = dependencies.notify ?? notifyAgent;
  try {
    const result = await (dependencies.callConnector ?? callPrivateConnector)(connectorRequest);
    notify(session, `Idea → Feature result (${parsed.operation}): ${canonicalJson(result)}`);
  } catch (error) {
    if (error instanceof PendingVerificationError) {
      notify(
        session,
        `Idea → Feature ${parsed.operation} is pending verification; the connector may have applied it. Do not retry as a new operation.`,
      );
      return;
    }
    throw error;
  }
}
