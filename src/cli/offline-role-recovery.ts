#!/usr/bin/env node

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { closeDb, initDb } from '../db/connection.js';
import { getUserRoles, revokeRole } from '../modules/permissions/db/user-roles.js';
import type { UserRoleKind } from '../types.js';

export const PRODUCT_AGENT_GROUP_ID = 'ag-5ebefc95-eaf4-43c3-baec-78e579544926';
export const CENTRAL_DATABASE_PATH = '/home/user-artha-hr/nanoclaw/data/v2.db';
const NANOCLAW_SERVICE = 'artha-hr-nanoclaw.service';
const DOMAIN_ROLES = new Set<UserRoleKind>(['product_approver', 'technical_approver']);
const execFileAsync = promisify(execFile);

function effectiveUid(): number {
  if (!process.geteuid) throw new Error('offline role recovery requires Linux effective-UID support');
  return process.geteuid();
}

export interface OfflineRoleRecoveryDependencies {
  expectedDatabasePath: string;
  expectedUid: number;
  assertServiceStopped: () => Promise<void>;
  /** Test-only race seam; production leaves this undefined. */
  afterDatabaseFileOpened?: () => void;
}

interface RecoveryRequest {
  database: string;
  expectedUserId: string;
  targetUserId: string;
  role: 'product_approver' | 'technical_approver';
  group: string;
}

const productionDependencies: OfflineRoleRecoveryDependencies = {
  expectedDatabasePath: CENTRAL_DATABASE_PATH,
  expectedUid: effectiveUid(),
  assertServiceStopped: async () => {
    const { stdout } = await execFileAsync('/usr/bin/systemctl', [
      '--user',
      'show',
      NANOCLAW_SERVICE,
      '--property=ActiveState',
      '--value',
    ]);
    if (stdout.trim() !== 'inactive') {
      throw new Error(`NanoClaw service must be stopped; ActiveState=${JSON.stringify(stdout.trim())}`);
    }
  },
};

function parseRequest(argv: string[]): RecoveryRequest {
  if (argv[0] !== 'revoke') throw new Error('only supported verb is revoke');
  const allowed = new Set(['database', 'expected-user-id', 'target-user-id', 'role', 'group']);
  const values = new Map<string, string>();
  for (let i = 1; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!flag?.startsWith('--')) throw new Error(`unexpected argument ${JSON.stringify(flag)}`);
    const name = flag.slice(2);
    if (!allowed.has(name)) throw new Error(`unknown flag --${name}`);
    if (values.has(name)) throw new Error(`duplicate flag --${name}`);
    if (value === undefined || value.startsWith('--') || value.length === 0)
      throw new Error(`--${name} requires a value`);
    values.set(name, value);
  }
  for (const name of allowed) {
    if (!values.has(name)) throw new Error(`--${name} is required`);
  }
  const role = values.get('role') as UserRoleKind;
  if (!DOMAIN_ROLES.has(role)) throw new Error('role must be product_approver or technical_approver');
  const group = values.get('group')!;
  if (group !== PRODUCT_AGENT_GROUP_ID) throw new Error(`group must be exact Product group ${PRODUCT_AGENT_GROUP_ID}`);
  const expectedUserId = values.get('expected-user-id')!;
  const targetUserId = values.get('target-user-id')!;
  if (expectedUserId !== targetUserId) throw new Error('--expected-user-id and --target-user-id must match exactly');
  if (targetUserId.length > 256 || /[\0\r\n]/u.test(targetUserId)) throw new Error('target user ID has invalid shape');
  return {
    database: values.get('database')!,
    expectedUserId,
    targetUserId,
    role: role as RecoveryRequest['role'],
    group,
  };
}

function assertPhysicalDatabase(
  database: string,
  expectedPath: string,
  expectedUid: number,
): {
  directoryFd: number;
  fileFd: number;
  fdPath: string;
} {
  if (!path.isAbsolute(database) || path.normalize(database) !== database || database !== expectedPath) {
    throw new Error(`database must equal exact approved database path ${expectedPath}`);
  }

  const components = database.split(path.sep).filter(Boolean);
  const fileName = components.pop();
  if (!fileName) throw new Error('database path must name a file');
  let directoryFd = fs.openSync(path.parse(database).root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  let fileFd: number | undefined;
  try {
    for (const component of components) {
      const candidate = `/proc/self/fd/${directoryFd}/${component}`;
      const linkStat = fs.lstatSync(candidate);
      if (linkStat.isSymbolicLink()) throw new Error(`database path contains symlink: ${component}`);
      const nextFd = fs.openSync(candidate, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      const stat = fs.fstatSync(nextFd);
      if (!stat.isDirectory()) {
        fs.closeSync(nextFd);
        throw new Error(`database ancestor is not a directory: ${component}`);
      }
      if (stat.uid !== 0 && stat.uid !== expectedUid) {
        fs.closeSync(nextFd);
        throw new Error(`unsafe database ancestor owner: ${component}`);
      }
      if ((stat.mode & 0o022) !== 0) {
        fs.closeSync(nextFd);
        throw new Error(`group/other-writable ancestor rejected: ${component}`);
      }
      fs.closeSync(directoryFd);
      directoryFd = nextFd;
    }
    const candidatePath = `/proc/self/fd/${directoryFd}/${fileName}`;
    const linkStat = fs.lstatSync(candidatePath);
    if (linkStat.isSymbolicLink()) throw new Error('database path contains symlink at file');
    if (!linkStat.isFile()) throw new Error('database must be a regular file');
    fileFd = fs.openSync(candidatePath, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const fdStat = fs.fstatSync(fileFd);
    const pathStat = fs.lstatSync(candidatePath);
    if (!fdStat.isFile()) throw new Error('database must be a regular file');
    if (fdStat.uid !== expectedUid) throw new Error(`database owner must be effective uid ${expectedUid}`);
    if ((fdStat.mode & 0o777) !== 0o600) throw new Error('database must have exact mode 0600');
    if (fdStat.nlink !== 1) throw new Error('database must be single-link');
    if (fdStat.dev !== pathStat.dev || fdStat.ino !== pathStat.ino) {
      fs.closeSync(fileFd);
      fileFd = undefined;
      throw new Error('database identity changed while opening stable handles');
    }
    return { directoryFd, fileFd, fdPath: `/proc/self/fd/${fileFd}` };
  } catch (error) {
    if (fileFd !== undefined) fs.closeSync(fileFd);
    fs.closeSync(directoryFd);
    throw error;
  }
}

export async function runOfflineRoleRecovery(
  argv: string[],
  dependencies: OfflineRoleRecoveryDependencies = productionDependencies,
): Promise<{ revoked: { user_id: string; role: RecoveryRequest['role']; agent_group_id: string } }> {
  const request = parseRequest(argv);
  if (request.database !== dependencies.expectedDatabasePath) {
    throw new Error(`database must equal exact approved database path ${dependencies.expectedDatabasePath}`);
  }
  await dependencies.assertServiceStopped();
  const handles = assertPhysicalDatabase(request.database, dependencies.expectedDatabasePath, dependencies.expectedUid);
  try {
    dependencies.afterDatabaseFileOpened?.();
    const openedStat = fs.fstatSync(handles.fileFd);
    if (openedStat.nlink !== 1) throw new Error('validated database was unlinked before SQLite open');
    if (!openedStat.isFile() || openedStat.uid !== dependencies.expectedUid || (openedStat.mode & 0o777) !== 0o600) {
      throw new Error('validated database identity changed before SQLite open');
    }
    initDb(handles.fdPath);
    const before = getUserRoles(request.targetUserId);
    const matching = before.filter(
      (row) =>
        row.user_id === request.expectedUserId && row.role === request.role && row.agent_group_id === request.group,
    );
    if (matching.length !== 1) throw new Error('recovery requires exactly one matching grant');
    await dependencies.assertServiceStopped();
    revokeRole(request.targetUserId, request.role, request.group);
    const after = getUserRoles(request.targetUserId);
    if (
      after.some(
        (row) =>
          row.user_id === request.expectedUserId && row.role === request.role && row.agent_group_id === request.group,
      )
    ) {
      throw new Error('canonical read-back did not prove the exact role absent');
    }
    await dependencies.assertServiceStopped();
    return {
      revoked: { user_id: request.targetUserId, role: request.role, agent_group_id: request.group },
    };
  } finally {
    closeDb();
    fs.closeSync(handles.fileFd);
    fs.closeSync(handles.directoryFd);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runOfflineRoleRecovery(process.argv.slice(2))
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
