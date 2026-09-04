import { getAgentGroup } from '../../db/agent-groups.js';
import type { Session } from '../../types.js';
import { notifyAgent, requestApproval } from '../approvals/index.js';
import { canAccessAgentGroup } from '../permissions/access.js';
import { getScopedRoleHolders, type DomainApproverRole } from '../permissions/db/user-roles.js';
import { canonicalJson } from './guard.js';
import type { PrivateActionName } from './private-client.js';
import { verifySourceEvent } from './source-event.js';

const OPERATIONS: ReadonlySet<PrivateActionName> = new Set([
  'idea_create',
  'idea_add_observation',
  'idea_prepare_review',
  'idea_reopen',
  'idea_record_product_decision',
  'idea_record_technical_decision',
  'idea_convert_to_feature',
  'feature_update_specification',
  'feature_advance',
  'prd_create_draft',
  'prd_update_draft',
]);
const SOURCE_EVENT = /^[A-Za-z0-9-][A-Za-z0-9:._/@+-]{0,511}$/;
const IDEA_ID = /^IDEA-[1-9][0-9]*$/;
const FEATURE_ID = /^FEAT-[1-9][0-9]*$/;
const CONTROL_FIELDS = new Set([
  '__proto__',
  'constructor',
  'prototype',
  'actor_user_id',
  'approver_user_id',
  'grant_id',
  'operation_key',
  'project_id',
  'state_id',
  'label_id',
  'collection_id',
  'parent_document_id',
  'plane_uuid',
  'outline_uuid',
]);
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_APPROVAL_QUESTION_BYTES = 3_500;
const APPROVAL_TTL_MS = 15 * 60 * 1_000;

export interface ParsedIdeaFeatureRequest {
  operation: PrivateActionName;
  sourceEventId: string;
  request: Record<string, unknown>;
}

export interface HostBinding {
  verifiedActorUserId: string;
  approverUserId: string;
  requiredRole: DomainApproverRole | null;
}

function plainRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${field} must be a plain object`);
  return value as Record<string, unknown>;
}

function exactFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
  field: string,
): void {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length > 0) throw new Error(`${field} contains an additional field: ${extras.sort()[0]}`);
  const missing = required.find((key) => !(key in value));
  if (missing) throw new Error(`${field}.${missing} is required`);
}

function boundedString(value: unknown, field: string, max: number, pattern?: RegExp): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) throw new Error(`${field} is invalid`);
  if (pattern && !pattern.test(value)) throw new Error(`${field} is malformed`);
  return value;
}

function stringArray(value: unknown, field: string, min = 1, max = 50, itemMax = 2_000): string[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw new Error(`${field} is invalid`);
  return value.map((item, index) => boundedString(item, `${field}[${index}]`, itemMax));
}

function assertNoControlFields(value: unknown, field = 'request'): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoControlFields(item, `${field}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  const object = plainRecord(value, field);
  for (const [key, item] of Object.entries(object)) {
    if (CONTROL_FIELDS.has(key)) throw new Error(`${field}.${key} is host-controlled`);
    assertNoControlFields(item, `${field}.${key}`);
  }
}

const FEATURE_FIELDS = [
  'title',
  'problem',
  'user_roles',
  'user_scenario',
  'expected_behaviour',
  'in_scope',
  'out_of_scope',
  'success_criteria',
  'dependencies',
  'constraints',
  'risks',
  'technical_assessment',
  'acceptance_criteria',
  'idea_ids',
] as const;

function validateFeature(value: unknown): void {
  const feature = plainRecord(value, 'request.feature');
  exactFields(feature, FEATURE_FIELDS, FEATURE_FIELDS, 'request.feature');
  boundedString(feature.title, 'request.feature.title', 255);
  boundedString(feature.problem, 'request.feature.problem', 4_000);
  boundedString(feature.user_scenario, 'request.feature.user_scenario', 4_000);
  boundedString(feature.expected_behaviour, 'request.feature.expected_behaviour', 4_000);
  boundedString(feature.technical_assessment, 'request.feature.technical_assessment', 4_000);
  for (const field of [
    'user_roles',
    'in_scope',
    'out_of_scope',
    'success_criteria',
    'dependencies',
    'constraints',
    'risks',
    'acceptance_criteria',
  ] as const)
    stringArray(feature[field], `request.feature.${field}`);
  for (const id of stringArray(feature.idea_ids, 'request.feature.idea_ids', 1, 50, 32)) {
    if (!IDEA_ID.test(id)) throw new Error('request.feature.idea_ids is malformed');
  }
}

function validateDecision(request: Record<string, unknown>, kind: 'product' | 'technical'): void {
  exactFields(
    request,
    ['task_id', 'decision_id', 'outcome', 'comment', 'supersedes_decision_id'],
    ['task_id', 'decision_id', 'outcome', 'comment'],
    'request',
  );
  boundedString(request.task_id, 'request.task_id', 32, IDEA_ID);
  boundedString(request.decision_id, 'request.decision_id', 128);
  boundedString(request.comment, 'request.comment', 4_000);
  const outcomes = kind === 'product' ? ['approved', 'parked', 'rejected'] : ['approved', 'needs_research', 'rejected'];
  if (typeof request.outcome !== 'string' || !outcomes.includes(request.outcome))
    throw new Error('request.outcome is invalid');
  if (request.supersedes_decision_id !== undefined && request.supersedes_decision_id !== null) {
    boundedString(request.supersedes_decision_id, 'request.supersedes_decision_id', 128);
  }
}

function validateRequest(operation: PrivateActionName, request: Record<string, unknown>): void {
  if (operation === 'idea_create') {
    const allowed = [
      'title',
      'record_type',
      'problem',
      'target_user',
      'expected_outcome',
      'proposed_solution',
      'product_area',
      'evidence',
    ];
    exactFields(
      request,
      allowed,
      ['title', 'record_type', 'problem', 'target_user', 'expected_outcome', 'product_area'],
      'request',
    );
    boundedString(request.title, 'request.title', 255);
    boundedString(request.problem, 'request.problem', 4_000);
    boundedString(request.target_user, 'request.target_user', 1_000);
    boundedString(request.expected_outcome, 'request.expected_outcome', 2_000);
    boundedString(request.product_area, 'request.product_area', 255);
    if (!['Idea', 'Feature Request', 'Improvement', 'Problem'].includes(String(request.record_type))) {
      throw new Error('request.record_type is invalid');
    }
    if (request.proposed_solution !== undefined)
      boundedString(request.proposed_solution, 'request.proposed_solution', 4_000);
    if (request.evidence !== undefined) stringArray(request.evidence, 'request.evidence', 0);
    return;
  }
  if (operation === 'idea_add_observation') {
    exactFields(request, ['task_id', 'text', 'observed_at'], ['task_id', 'text', 'observed_at'], 'request');
    boundedString(request.task_id, 'request.task_id', 32, IDEA_ID);
    boundedString(request.text, 'request.text', 4_000);
    const observedAt = boundedString(request.observed_at, 'request.observed_at', 64);
    if (!Number.isFinite(Date.parse(observedAt))) throw new Error('request.observed_at must be ISO time');
    return;
  }
  if (operation === 'idea_prepare_review') {
    exactFields(
      request,
      ['task_id', 'complete', 'duplicate_checked'],
      ['task_id', 'complete', 'duplicate_checked'],
      'request',
    );
    boundedString(request.task_id, 'request.task_id', 32, IDEA_ID);
    if (request.complete !== true || request.duplicate_checked !== true)
      throw new Error('review prerequisites must both be true');
    return;
  }
  if (operation === 'idea_reopen') {
    exactFields(request, ['task_id', 'to'], ['task_id', 'to'], 'request');
    boundedString(request.task_id, 'request.task_id', 32, IDEA_ID);
    if (!['Clarification', 'Technical Review'].includes(String(request.to))) throw new Error('request.to is invalid');
    return;
  }
  if (operation === 'idea_record_product_decision' || operation === 'idea_record_technical_decision') {
    validateDecision(request, operation === 'idea_record_product_decision' ? 'product' : 'technical');
    return;
  }
  if (operation === 'idea_convert_to_feature') {
    exactFields(request, ['idea_ids', 'feature'], ['idea_ids', 'feature'], 'request');
    for (const id of stringArray(request.idea_ids, 'request.idea_ids', 1, 50, 32)) {
      if (!IDEA_ID.test(id)) throw new Error('request.idea_ids is malformed');
    }
    validateFeature(request.feature);
    return;
  }
  if (operation === 'feature_update_specification') {
    exactFields(request, ['task_id', 'feature'], ['task_id', 'feature'], 'request');
    boundedString(request.task_id, 'request.task_id', 32, FEATURE_ID);
    validateFeature(request.feature);
    return;
  }
  if (operation === 'feature_advance') {
    exactFields(request, ['task_id', 'to'], ['task_id', 'to'], 'request');
    boundedString(request.task_id, 'request.task_id', 32, FEATURE_ID);
    const agentStates = [
      'Discovery',
      'Specification',
      'Ready for Planning',
      'Planned',
      'In Development',
      'In Review',
      'Ready for Acceptance',
    ];
    if (!agentStates.includes(String(request.to))) throw new Error('request.to is invalid or human-only');
    return;
  }
  if (operation === 'prd_create_draft') {
    exactFields(request, ['feature_id', 'feature'], ['feature_id', 'feature'], 'request');
    boundedString(request.feature_id, 'request.feature_id', 32, FEATURE_ID);
    validateFeature(request.feature);
    return;
  }
  exactFields(request, ['document_id', 'feature_id', 'feature'], ['document_id', 'feature_id', 'feature'], 'request');
  boundedString(request.document_id, 'request.document_id', 128);
  boundedString(request.feature_id, 'request.feature_id', 32, FEATURE_ID);
  validateFeature(request.feature);
}

export function parseIdeaFeatureRequest(content: Record<string, unknown>): ParsedIdeaFeatureRequest {
  const root = plainRecord(content, 'message');
  exactFields(root, ['action', 'payload', '_host'], ['action', 'payload'], 'message');
  if (root.action !== 'idea_feature_request') throw new Error('message action is invalid');
  const payload = plainRecord(root.payload, 'payload');
  exactFields(payload, ['operation', 'sourceEventId', 'request'], ['operation', 'sourceEventId', 'request'], 'payload');
  if (typeof payload.operation !== 'string' || !OPERATIONS.has(payload.operation as PrivateActionName)) {
    throw new Error('operation is not allowlisted');
  }
  const sourceEventId = boundedString(payload.sourceEventId, 'payload.sourceEventId', 512, SOURCE_EVENT);
  const request = plainRecord(payload.request, 'request');
  assertNoControlFields(request);
  if (Buffer.byteLength(JSON.stringify(request), 'utf8') > MAX_REQUEST_BYTES) throw new Error('request exceeds 64 KiB');
  validateRequest(payload.operation as PrivateActionName, request);
  return { operation: payload.operation as PrivateActionName, sourceEventId, request };
}

export async function resolveApproverForRequest(
  operation: PrivateActionName,
  requesterUserId: string,
  agentGroupId: string,
): Promise<{ approverUserId: string; requiredRole: DomainApproverRole | null }> {
  let requiredRole: DomainApproverRole | null = null;
  if (operation === 'idea_record_product_decision') requiredRole = 'product_approver';
  if (operation === 'idea_record_technical_decision') requiredRole = 'technical_approver';
  if (!requiredRole) return { approverUserId: requesterUserId, requiredRole: null };

  const holders = [];
  for (const row of await getScopedRoleHolders(requiredRole, agentGroupId)) {
    if ((await canAccessAgentGroup(row.user_id, agentGroupId)).allowed) holders.push(row);
  }
  if (holders.length !== 1) throw new Error(`request requires exactly one active ${requiredRole}`);
  return { approverUserId: holders[0].user_id, requiredRole };
}

function visibleJson(value: unknown): string {
  return canonicalJson(value).replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cs}\u2028\u2029`]/gu, (character) => {
    const point = character.codePointAt(0) ?? 0;
    return point > 0xffff ? `\\u{${point.toString(16)}}` : `\\u${point.toString(16).padStart(4, '0')}`;
  });
}

function approvalQuestion(parsed: ParsedIdeaFeatureRequest, binding: HostBinding): string {
  return [
    `Operation: ${parsed.operation}`,
    `Verified requester: ${binding.verifiedActorUserId}`,
    `Exclusive approver: ${binding.approverUserId}`,
    `Source event: ${parsed.sourceEventId}`,
    `Exact request: ${visibleJson(parsed.request)}`,
  ].join('\n');
}

export async function validateAndBindIdeaFeatureRequest(
  content: Record<string, unknown>,
  session: Session,
): Promise<boolean> {
  try {
    const configuredProductGroup = process.env.IDEA_FEATURE_PRODUCT_AGENT_GROUP_ID;
    if (!configuredProductGroup || configuredProductGroup !== session.agent_group_id) {
      throw new Error('request did not originate from the configured Product Agent group');
    }
    const parsed = parseIdeaFeatureRequest(content);
    const verifiedActorUserId = await verifySourceEvent(session, parsed.sourceEventId);
    const route = await resolveApproverForRequest(parsed.operation, verifiedActorUserId, session.agent_group_id);
    const binding: HostBinding = { verifiedActorUserId, ...route };
    content._host = binding;
    if (Buffer.byteLength(approvalQuestion(parsed, binding), 'utf8') > MAX_APPROVAL_QUESTION_BYTES) {
      throw new Error('complete approval card exceeds the safe Telegram size');
    }
    return true;
    // eslint-disable-next-line no-catch-all/no-catch-all -- the host validation boundary denies and safely reports all invalid requests
  } catch (error) {
    await notifyAgent(
      session,
      `idea_feature_request denied: ${error instanceof Error ? error.message : 'invalid request'}.`,
    );
    return false;
  }
}

export async function requestIdeaFeatureHold(content: Record<string, unknown>, session: Session): Promise<void> {
  const parsed = parseIdeaFeatureRequest(content);
  const binding = plainRecord(content._host, '_host') as unknown as HostBinding;
  const agent = await getAgentGroup(session.agent_group_id);
  if (!agent) {
    await notifyAgent(session, 'idea_feature_request denied: agent group not found.');
    return;
  }
  await requestApproval({
    session,
    agentName: agent.name,
    action: 'idea_feature_request',
    payload: content,
    title: `Idea → Feature: ${parsed.operation}`,
    question: approvalQuestion(parsed, binding),
    approverUserId: binding.approverUserId,
    expiresAt: new Date(Date.now() + APPROVAL_TTL_MS).toISOString(),
  });
}
