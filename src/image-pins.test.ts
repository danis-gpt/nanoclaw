import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { desiredImagePins, reconcileImagePinsWith } from './image-pins.js';

describe('desiredImagePins', () => {
  it('suppresses expected runtime stderr while probing a missing image', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src', 'image-pins.ts'), 'utf8');
    expect(source).toContain("stdio: ['ignore', 'pipe', 'ignore']");
  });

  it('pins the base image and every unique DB-referenced image', () => {
    const pins = desiredImagePins(
      [
        { agent_group_id: 'ag-a', image_tag: 'localhost/nanoclaw-agent:ag-a' },
        { agent_group_id: 'ag-b', image_tag: 'localhost/nanoclaw-agent:ag-b' },
        { agent_group_id: 'ag-empty', image_tag: null },
      ],
      'localhost/nanoclaw-agent:latest',
      'install-1',
    );

    expect(pins).toEqual([
      { name: 'nanoclaw-install-1-image-pin-base', image: 'localhost/nanoclaw-agent:latest' },
      { name: 'nanoclaw-install-1-image-pin-ag-a', image: 'localhost/nanoclaw-agent:ag-a' },
      { name: 'nanoclaw-install-1-image-pin-ag-b', image: 'localhost/nanoclaw-agent:ag-b' },
    ]);
  });
});

describe('reconcileImagePinsWith', () => {
  it('removes stale pins, recreates desired pins, and reports missing images', async () => {
    const removed: string[] = [];
    const created: Array<{ name: string; image: string }> = [];
    const result = await reconcileImagePinsWith(
      [
        { name: 'nanoclaw-install-1-image-pin-base', image: 'base:latest' },
        { name: 'nanoclaw-install-1-image-pin-ag-a', image: 'agent:ag-a' },
      ],
      {
        listPinNames: async () => ['nanoclaw-install-1-image-pin-stale', 'nanoclaw-install-1-image-pin-base'],
        imageExists: async (image) => image !== 'agent:ag-a',
        removePin: async (name) => {
          removed.push(name);
        },
        restoreImageTag: async () => false,
        createPin: async (name, image) => {
          created.push({ name, image });
        },
      },
    );

    expect(removed).toEqual(['nanoclaw-install-1-image-pin-stale', 'nanoclaw-install-1-image-pin-base']);
    expect(created).toEqual([{ name: 'nanoclaw-install-1-image-pin-base', image: 'base:latest' }]);
    expect(result.missingImages).toEqual(['agent:ag-a']);
  });

  it('restores a missing tag from its existing pin without rebuilding', async () => {
    const restored: Array<{ name: string; image: string }> = [];
    const result = await reconcileImagePinsWith([{ name: 'nanoclaw-install-1-image-pin-ag-a', image: 'agent:ag-a' }], {
      listPinNames: async () => ['nanoclaw-install-1-image-pin-ag-a'],
      imageExists: async () => false,
      removePin: async () => {
        throw new Error('existing pin must stay in place');
      },
      restoreImageTag: async (name, image) => {
        restored.push({ name, image });
        return true;
      },
      createPin: async () => {
        throw new Error('restored pin must not be recreated');
      },
    });

    expect(restored).toEqual([{ name: 'nanoclaw-install-1-image-pin-ag-a', image: 'agent:ag-a' }]);
    expect(result.missingImages).toEqual([]);
  });
});
