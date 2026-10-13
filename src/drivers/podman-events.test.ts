import { describe, expect, it } from 'vitest';
import { dockerEventToSessionEvent } from './docker-driver.js';
import { LABELS } from './types.js';

describe('Podman session events', () => {
  const Attributes = { [LABELS.install]: 'probe', [LABELS.group]: 'g1', [LABELS.session]: 's1' };

  it.each([
    ['create', 'phase'],
    ['start', 'phase'],
    ['died', 'terminal'],
    ['remove', 'terminal'],
  ])('maps the actual Podman %s envelope to %s', (Status, kind) => {
    expect(dockerEventToSessionEvent({ Type: 'container', Status, Attributes }, 'probe')).toEqual({
      key: { installSlug: 'probe', agentGroupId: 'g1', sessionId: 's1' }, kind,
    });
  });

  it('rejects events labeled for a different install', () => {
    expect(dockerEventToSessionEvent({ Status: 'died', Attributes }, 'peer')).toBeNull();
  });
});
