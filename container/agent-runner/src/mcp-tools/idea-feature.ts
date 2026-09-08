/**
 * Request-only Idea → Feature tools.
 *
 * These tools never call Plane or Outline and never accept identity, approval,
 * credential, project, state, or collection controls from the model. They put
 * one system request into outbound.db; the NanoClaw host verifies the source
 * event, obtains and consumes a human approval, and applies it separately.
 */
import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const SOURCE_EVENT = /^[A-Za-z0-9-][A-Za-z0-9:._/@+-]{0,511}$/;
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

type Operation =
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

interface RequestToolSpec {
  name: string;
  operation: Operation;
  description: string;
  properties: Record<string, object>;
  required: string[];
}

type RuntimeSchema = {
  type?: string | string[];
  enum?: unknown[];
  const?: unknown;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minItems?: number;
  maxItems?: number;
  items?: RuntimeSchema;
  properties?: Record<string, RuntimeSchema>;
  required?: string[];
  additionalProperties?: boolean;
};

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ok(operation: Operation) {
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({ requested: true, operation }),
    }],
  };
}

function err(message: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertNoControlFields(value: unknown, path = 'request'): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoControlFields(item, `${path}[${index}]`));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (CONTROL_FIELDS.has(key)) throw new Error(`${path}.${key} is host-controlled`);
    assertNoControlFields(item, `${path}.${key}`);
  }
}

function validateValue(value: unknown, schema: RuntimeSchema, path: string): void {
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  const actualType = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (types.length > 0 && !types.includes(actualType)) {
    throw new Error(`${path} must be ${types.join(' or ')}`);
  }
  if (schema.const !== undefined && value !== schema.const) {
    throw new Error(`${path} must be ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum && !schema.enum.includes(value)) {
    throw new Error(`${path} is not an allowed value`);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.trim().length < schema.minLength) {
      throw new Error(`${path} is required`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      throw new Error(`${path} is too long`);
    }
    if (schema.pattern && !(new RegExp(schema.pattern, 'u')).test(value)) {
      throw new Error(`${path} is malformed`);
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      throw new Error(`${path} requires at least ${schema.minItems} item`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      throw new Error(`${path} has too many items`);
    }
    if (schema.items) value.forEach((item, index) => validateValue(item, schema.items!, `${path}[${index}]`));
  }
  if (actualType === 'object' && value !== null && !Array.isArray(value)) {
    if (!isPlainObject(value)) throw new Error(`${path} must be a plain object`);
    const properties = schema.properties ?? {};
    if (schema.additionalProperties === false) {
      const extras = Object.keys(value).filter((key) => !(key in properties));
      if (extras.length > 0) throw new Error(`${path}.${extras[0]} is not allowed`);
    }
    const missing = schema.required?.find((key) => !(key in value));
    if (missing) throw new Error(`${path}.${missing} is required`);
    for (const [key, item] of Object.entries(value)) {
      if (properties[key]) validateValue(item, properties[key], `${path}.${key}`);
    }
  }
}

function buildTool(spec: RequestToolSpec): McpToolDefinition {
  const allowed = new Set(['source_event_id', ...Object.keys(spec.properties)]);
  return {
    tool: {
      name: spec.name,
      description: spec.description,
      inputSchema: {
        type: 'object' as const,
        additionalProperties: false,
        properties: {
          source_event_id: {
            type: 'string',
            minLength: 1,
            maxLength: 512,
            description: 'Original source event ID visible in the current agent context.',
          },
          ...spec.properties,
        },
        required: ['source_event_id', ...spec.required],
      },
    },
    async handler(args) {
      try {
        if (!isPlainObject(args)) throw new Error('arguments must be an object');
        const extras = Object.keys(args).filter((key) => !allowed.has(key));
        if (extras.length > 0) throw new Error(`${extras[0]} is not accepted by this request tool`);
        const sourceEventId = args.source_event_id;
        if (typeof sourceEventId !== 'string' || !SOURCE_EVENT.test(sourceEventId)) {
          throw new Error('source_event_id is required and must be a bounded original event ID');
        }
        const missing = spec.required.find((key) => !(key in args));
        if (missing) throw new Error(`${missing} is required`);
        for (const [key, schema] of Object.entries(spec.properties)) {
          if (key in args) validateValue(args[key], schema as RuntimeSchema, key);
        }
        const request = Object.fromEntries(
          Object.entries(args).filter(([key]) => key !== 'source_event_id'),
        );
        assertNoControlFields(request);
        const encoded = JSON.stringify(request);
        if (Buffer.byteLength(encoded, 'utf8') > MAX_REQUEST_BYTES) {
          throw new Error('request exceeds 64 KiB');
        }
        writeMessageOut({
          id: generateId(),
          kind: 'system',
          content: JSON.stringify({
            action: 'idea_feature_request',
            payload: {
              operation: spec.operation,
              sourceEventId,
              request,
            },
          }),
        });
        return ok(spec.operation);
      } catch (error) {
        return err(error instanceof Error ? error.message : 'invalid Idea Feature request');
      }
    },
  };
}

const ideaProperties = {
  title: { type: 'string', minLength: 1, maxLength: 255 },
  record_type: { type: 'string', enum: ['Idea', 'Feature Request', 'Improvement', 'Problem'] },
  problem: { type: 'string', minLength: 1, maxLength: 4_000 },
  target_user: { type: 'string', minLength: 1, maxLength: 1_000 },
  expected_outcome: { type: 'string', minLength: 1, maxLength: 2_000 },
  proposed_solution: { type: 'string', maxLength: 4_000 },
  product_area: { type: 'string', minLength: 1, maxLength: 255 },
  evidence: { type: 'array', maxItems: 50, items: { type: 'string', maxLength: 2_000 } },
};

const featureSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 255 },
    problem: { type: 'string', minLength: 1, maxLength: 4_000 },
    user_roles: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'string', minLength: 1 } },
    user_scenario: { type: 'string', minLength: 1, maxLength: 4_000 },
    expected_behaviour: { type: 'string', minLength: 1, maxLength: 4_000 },
    in_scope: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'string', minLength: 1 } },
    out_of_scope: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'string', minLength: 1 } },
    success_criteria: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'string', minLength: 1 } },
    dependencies: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'string', minLength: 1 } },
    constraints: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'string', minLength: 1 } },
    risks: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'string', minLength: 1 } },
    technical_assessment: { type: 'string', minLength: 1, maxLength: 4_000 },
    acceptance_criteria: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'string', minLength: 1 } },
    idea_ids: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'string', pattern: '^IDEA-[1-9][0-9]*$' } },
  },
  required: [
    'title', 'problem', 'user_roles', 'user_scenario', 'expected_behaviour',
    'in_scope', 'out_of_scope', 'success_criteria', 'dependencies', 'constraints',
    'risks', 'technical_assessment', 'acceptance_criteria', 'idea_ids',
  ],
};

const decisionProperties = {
  task_id: { type: 'string', pattern: '^IDEA-[1-9][0-9]*$' },
  decision_id: { type: 'string', minLength: 1, maxLength: 128 },
  outcome: { type: 'string', minLength: 1, maxLength: 32 },
  comment: { type: 'string', minLength: 1, maxLength: 4_000 },
  supersedes_decision_id: { type: ['string', 'null'], maxLength: 128 },
};

const specs: RequestToolSpec[] = [
  {
    name: 'request_idea_create',
    operation: 'idea_create',
    description: 'Request creation of one Idea after showing the complete card and duplicate results.',
    properties: ideaProperties,
    required: ['title', 'record_type', 'problem', 'target_user', 'expected_outcome', 'product_area'],
  },
  {
    name: 'request_idea_observation',
    operation: 'idea_add_observation',
    description: 'Request an append-only observation on one native Idea.',
    properties: {
      task_id: { type: 'string', pattern: '^IDEA-[1-9][0-9]*$' },
      text: { type: 'string', minLength: 1, maxLength: 4_000 },
      observed_at: { type: 'string', maxLength: 64 },
    },
    required: ['task_id', 'text', 'observed_at'],
  },
  {
    name: 'request_idea_review',
    operation: 'idea_prepare_review',
    description: 'Request the guarded move of a complete, duplicate-checked Idea to Product Review.',
    properties: {
      task_id: { type: 'string', pattern: '^IDEA-[1-9][0-9]*$' },
      complete: { type: 'boolean', const: true },
      duplicate_checked: { type: 'boolean', const: true },
    },
    required: ['task_id', 'complete', 'duplicate_checked'],
  },
  {
    name: 'request_idea_reopen',
    operation: 'idea_reopen',
    description: 'Request a confirmed reopen along an allowlisted Idea state edge.',
    properties: {
      task_id: { type: 'string', pattern: '^IDEA-[1-9][0-9]*$' },
      to: { type: 'string', enum: ['Clarification', 'Technical Review'] },
    },
    required: ['task_id', 'to'],
  },
  {
    name: 'request_product_decision',
    operation: 'idea_record_product_decision',
    description: 'Request a product decision; only the live scoped product approver can confirm it.',
    properties: decisionProperties,
    required: ['task_id', 'decision_id', 'outcome', 'comment'],
  },
  {
    name: 'request_technical_decision',
    operation: 'idea_record_technical_decision',
    description: 'Request a technical decision; only the live scoped technical approver can confirm it.',
    properties: decisionProperties,
    required: ['task_id', 'decision_id', 'outcome', 'comment'],
  },
  {
    name: 'request_feature_conversion',
    operation: 'idea_convert_to_feature',
    description: 'Request idempotent conversion of approved Ideas into one Feature.',
    properties: {
      idea_ids: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'string', pattern: '^IDEA-[1-9][0-9]*$' } },
      feature: featureSchema,
    },
    required: ['idea_ids', 'feature'],
  },
  {
    name: 'request_feature_update',
    operation: 'feature_update_specification',
    description: 'Request a confirmed update of one Feature specification.',
    properties: {
      task_id: { type: 'string', pattern: '^FEAT-[1-9][0-9]*$' },
      feature: featureSchema,
    },
    required: ['task_id', 'feature'],
  },
  {
    name: 'request_feature_advance',
    operation: 'feature_advance',
    description: 'Request one allowlisted Feature transition; Accepted and Released remain human-only.',
    properties: {
      task_id: { type: 'string', pattern: '^FEAT-[1-9][0-9]*$' },
      to: { type: 'string', minLength: 1, maxLength: 64 },
    },
    required: ['task_id', 'to'],
  },
  {
    name: 'request_prd_draft',
    operation: 'prd_create_draft',
    description: 'Request creation of one reserved unpublished Feature PRD draft.',
    properties: {
      feature_id: { type: 'string', pattern: '^FEAT-[1-9][0-9]*$' },
      feature: featureSchema,
    },
    required: ['feature_id', 'feature'],
  },
  {
    name: 'request_prd_update',
    operation: 'prd_update_draft',
    description: 'Request update of one reserved unpublished Feature PRD draft.',
    properties: {
      document_id: { type: 'string', minLength: 1, maxLength: 128 },
      feature_id: { type: 'string', pattern: '^FEAT-[1-9][0-9]*$' },
      feature: featureSchema,
    },
    required: ['document_id', 'feature_id', 'feature'],
  },
];

export const ideaFeatureRequestTools = specs.map(buildTool);
export const requestIdeaCreate = ideaFeatureRequestTools[0];

registerTools(ideaFeatureRequestTools);
