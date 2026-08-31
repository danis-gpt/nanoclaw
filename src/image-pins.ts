import { execFileSync } from 'child_process';

import { CONTAINER_IMAGE, INSTALL_SLUG } from './config.js';
import { getAllContainerConfigs } from './db/container-configs.js';
import { CONTAINER_RUNTIME_BIN } from './container-runtime.js';
import { log } from './log.js';

const IMAGE_PIN_LABEL = 'dev.nanoclaw.image-pin';

interface ImageConfigRef {
  agent_group_id: string;
  image_tag: string | null;
}

export interface ImagePin {
  name: string;
  image: string;
}

export interface ImagePinRuntime {
  listPinNames(): Promise<string[]>;
  imageExists(image: string): Promise<boolean>;
  removePin(name: string): Promise<void>;
  restoreImageTag(name: string, image: string): Promise<boolean>;
  createPin(name: string, image: string): Promise<void>;
}

function safeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function desiredImagePins(configs: ImageConfigRef[], baseImage: string, installSlug: string): ImagePin[] {
  const prefix = `nanoclaw-${safeName(installSlug)}-image-pin`;
  const pins: ImagePin[] = [{ name: `${prefix}-base`, image: baseImage }];
  const seen = new Set([baseImage]);
  for (const config of configs) {
    if (!config.image_tag || seen.has(config.image_tag)) continue;
    seen.add(config.image_tag);
    pins.push({ name: `${prefix}-${safeName(config.agent_group_id)}`, image: config.image_tag });
  }
  return pins;
}

export async function reconcileImagePinsWith(
  desired: ImagePin[],
  runtime: ImagePinRuntime,
): Promise<{ missingImages: string[] }> {
  const current = new Set(await runtime.listPinNames());
  const desiredNames = new Set(desired.map((pin) => pin.name));

  for (const name of current) {
    if (!desiredNames.has(name)) await runtime.removePin(name);
  }

  const missingImages: string[] = [];
  for (const pin of desired) {
    if (!(await runtime.imageExists(pin.image))) {
      if (current.has(pin.name) && (await runtime.restoreImageTag(pin.name, pin.image))) continue;
      missingImages.push(pin.image);
      continue;
    }
    if (current.has(pin.name)) await runtime.removePin(pin.name);
    await runtime.createPin(pin.name, pin.image);
  }
  return { missingImages };
}

function runtimeOutput(args: string[]): string {
  return execFileSync(CONTAINER_RUNTIME_BIN, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

const hostRuntime: ImagePinRuntime = {
  async listPinNames() {
    const output = runtimeOutput([
      'ps',
      '-a',
      '--filter',
      `label=${IMAGE_PIN_LABEL}=${INSTALL_SLUG}`,
      '--format',
      '{{.Names}}',
    ]);
    return output ? output.split('\n').filter(Boolean) : [];
  },
  async imageExists(image) {
    try {
      runtimeOutput(['image', 'inspect', image]);
      return true;
      // eslint-disable-next-line no-catch-all/no-catch-all -- inspect failure is represented as an unavailable image for reconciliation
    } catch {
      return false;
    }
  },
  async removePin(name) {
    execFileSync(CONTAINER_RUNTIME_BIN, ['rm', '-f', name], { stdio: 'ignore' });
  },
  async restoreImageTag(name, image) {
    try {
      const imageId = runtimeOutput(['inspect', name, '--format', '{{.Image}}']);
      if (!imageId) return false;
      execFileSync(CONTAINER_RUNTIME_BIN, ['tag', imageId, image], { stdio: 'ignore' });
      return true;
      // eslint-disable-next-line no-catch-all/no-catch-all -- failed restore falls back to the existing rebuild-or-warn flow
    } catch {
      return false;
    }
  },
  async createPin(name, image) {
    execFileSync(
      CONTAINER_RUNTIME_BIN,
      ['create', '--name', name, '--label', `${IMAGE_PIN_LABEL}=${INSTALL_SLUG}`, '--entrypoint', '/bin/true', image],
      { stdio: 'ignore' },
    );
  },
};

export async function reconcileImagePins(): Promise<void> {
  const desired = desiredImagePins(getAllContainerConfigs(), CONTAINER_IMAGE, INSTALL_SLUG);
  const result = await reconcileImagePinsWith(desired, hostRuntime);
  if (result.missingImages.includes(CONTAINER_IMAGE)) {
    throw new Error(`NanoClaw base image is missing: ${CONTAINER_IMAGE}`);
  }
  if (result.missingImages.length > 0) {
    log.warn('Configured agent images are missing; they will rebuild on the next wake', {
      images: result.missingImages,
    });
  }
  log.info('NanoClaw image pins reconciled', {
    pinned: desired.length - result.missingImages.length,
    missing: result.missingImages.length,
  });
}
