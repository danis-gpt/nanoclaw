import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { closeSessionDb, initTestSessionDb } from '../db/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { ideaFeatureRequestTools, requestIdeaCreate } from './idea-feature.js';

beforeEach(() => initTestSessionDb());
afterEach(() => closeSessionDb());

describe('Idea Feature request tools', () => {
  it('writes the exact request-only outbound action for Idea creation', async () => {
    const result = await requestIdeaCreate.handler({
      source_event_id: '-1000000000001:119:ag-product-test',
      title: 'Automatic onboarding plan',
      record_type: 'Idea',
      problem: 'Managers assemble onboarding plans manually',
      target_user: 'Team manager',
      expected_outcome: 'A standard plan is prepared faster',
      product_area: 'Onboarding',
    });

    expect(result.isError).not.toBe(true);
    expect(JSON.parse(getUndeliveredMessages()[0].content)).toEqual({
      action: 'idea_feature_request',
      payload: {
        operation: 'idea_create',
        sourceEventId: '-1000000000001:119:ag-product-test',
        request: {
          title: 'Automatic onboarding plan',
          record_type: 'Idea',
          problem: 'Managers assemble onboarding plans manually',
          target_user: 'Team manager',
          expected_outcome: 'A standard plan is prepared faster',
          product_area: 'Onboarding',
        },
      },
    });
    expect(JSON.stringify(result)).toContain('requested');
    expect(JSON.stringify(result)).not.toContain('succeeded');
  });

  it('exports request-only tools without model-controlled identity or UUID fields', () => {
    expect(ideaFeatureRequestTools.map((entry) => entry.tool.name)).toEqual([
      'request_idea_create',
      'request_idea_observation',
      'request_idea_review',
      'request_idea_reopen',
      'request_product_decision',
      'request_technical_decision',
      'request_feature_conversion',
      'request_feature_update',
      'request_feature_advance',
      'request_prd_draft',
      'request_prd_update',
    ]);
    for (const entry of ideaFeatureRequestTools) {
      const properties = entry.tool.inputSchema.properties ?? {};
      for (const forbidden of [
        'actor_user_id', 'approver_user_id', 'grant_id', 'operation_key',
        'project_id', 'state_id', 'collection_id', 'plane_uuid', 'outline_uuid',
      ]) {
        expect(forbidden in properties).toBe(false);
      }
    }
  });

  it('rejects missing source events and model-supplied control fields before enqueue', async () => {
    const missing = await requestIdeaCreate.handler({
      title: 'No source',
      record_type: 'Idea',
      problem: 'Manual work',
      target_user: 'Manager',
      expected_outcome: 'Faster',
      product_area: 'Onboarding',
    });
    expect(missing.isError).toBe(true);

    const injected = await requestIdeaCreate.handler({
      source_event_id: '-1000000000001:119:ag-product-test',
      title: 'Injected',
      record_type: 'Idea',
      problem: 'Manual work',
      target_user: 'Manager',
      expected_outcome: 'Faster',
      product_area: 'Onboarding',
      actor_user_id: 'telegram:attacker',
    });
    expect(injected.isError).toBe(true);
    const malformed = await requestIdeaCreate.handler({
      source_event_id: '-1000000000001:119:ag-product-test',
      title: 123,
      record_type: 'Idea',
      problem: 'Manual work',
      target_user: 'Manager',
      expected_outcome: 'Faster',
      product_area: 'Onboarding',
    });
    expect(malformed.isError).toBe(true);
    expect(getUndeliveredMessages()).toHaveLength(0);
  });
});
