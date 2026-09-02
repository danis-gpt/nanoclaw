#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

function command(file, args, cwd) {
  return execFileSync(file, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function assertProtectedExternalDirectory(repo, artifactDir) {
  if (!path.isAbsolute(artifactDir) || path.normalize(artifactDir) !== artifactDir) {
    throw new Error('artifact directory must be an exact absolute path');
  }
  const relative = path.relative(repo, artifactDir);
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..')) {
    throw new Error('artifact directory must be outside repository');
  }
  const stat = fs.lstatSync(artifactDir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(artifactDir) !== artifactDir) {
    throw new Error('artifact directory must be a physical directory');
  }
  if (stat.uid !== process.geteuid() || (stat.mode & 0o777) !== 0o700) {
    throw new Error('artifact directory must be euid-owned mode 0700');
  }
}

function findEsbuild() {
  const require = createRequire(import.meta.url);
  const tsxPackage = require.resolve('tsx/package.json');
  const binary = path.join(path.dirname(tsxPackage), '..', 'esbuild', 'bin', 'esbuild');
  if (!fs.statSync(binary).isFile()) throw new Error('pinned tsx esbuild binary is unavailable');
  return binary;
}

function copyPackage(packageJson, packageName, recoveryRoot) {
  fs.cpSync(path.dirname(packageJson), path.join(recoveryRoot, 'node_modules', packageName), {
    recursive: true,
    dereference: true,
  });
}

function deterministicTar(sourceParent, sourceName, output, epoch) {
  execFileSync(
    '/usr/bin/tar',
    [
      '--sort=name',
      `--mtime=@${epoch}`,
      '--owner=0',
      '--group=0',
      '--numeric-owner',
      '--format=gnu',
      '--mode=u+rwX,go=rX',
      '-cf',
      output,
      '-C',
      sourceParent,
      sourceName,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
}

function publishNoReplace(tempPath, finalPath) {
  if (fs.existsSync(finalPath)) throw new Error(`refusing to overwrite release artifact: ${finalPath}`);
  let linked = false;
  try {
    fs.linkSync(tempPath, finalPath);
    linked = true;
    fs.chmodSync(finalPath, 0o600);
    const fd = fs.openSync(finalPath, fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.unlinkSync(tempPath);
  } catch (error) {
    if (linked) fs.unlinkSync(finalPath);
    throw error;
  }
}

export function packageArtha17Release({ repo, artifactDir, includeRuntimeDependencies = true }) {
  const exactRepo = fs.realpathSync(repo);
  if (path.resolve(repo) !== exactRepo) throw new Error('repository must be an exact physical path');
  if (command('/usr/bin/git', ['rev-parse', '--show-toplevel'], exactRepo) !== exactRepo) {
    throw new Error('repository path must be the git worktree root');
  }
  const dirty = command('/usr/bin/git', ['status', '--porcelain=v1', '--untracked-files=all'], exactRepo);
  if (dirty !== '') throw new Error(`packaging requires a clean source commit; dirty paths:\n${dirty}`);
  assertProtectedExternalDirectory(exactRepo, artifactDir);

  const distDir = path.join(exactRepo, 'dist');
  if (!fs.existsSync(distDir) || !fs.statSync(distDir).isDirectory()) {
    throw new Error('complete built dist directory is required before packaging');
  }
  const sourceCommit = command('/usr/bin/git', ['rev-parse', 'HEAD^{commit}'], exactRepo);
  const sourceTree = command('/usr/bin/git', ['rev-parse', 'HEAD^{tree}'], exactRepo);
  const epoch = command('/usr/bin/git', ['show', '-s', '--format=%ct', sourceCommit], exactRepo);
  const short = sourceCommit.slice(0, 12);
  const distFinal = path.join(artifactDir, `nanoclaw-dist-${short}.tar`);
  const recoveryFinal = path.join(artifactDir, `nanoclaw-offline-role-recovery-${short}.tar`);
  if (fs.existsSync(distFinal) || fs.existsSync(recoveryFinal)) {
    throw new Error('refusing to overwrite existing release artifact');
  }

  const stage = fs.mkdtempSync(path.join(artifactDir, '.artha-17-stage-'));
  const distTemp = path.join(artifactDir, `.dist-${process.pid}-${Date.now()}.tmp`);
  const recoveryTemp = path.join(artifactDir, `.recovery-${process.pid}-${Date.now()}.tmp`);
  try {
    const recoveryRoot = path.join(stage, 'recovery');
    fs.mkdirSync(recoveryRoot, { mode: 0o700 });
    const recoveryEntry = path.join(recoveryRoot, 'offline-role-recovery.mjs');
    execFileSync(findEsbuild(), [
      path.join(exactRepo, 'src', 'cli', 'offline-role-recovery.ts'),
      '--bundle',
      '--platform=node',
      '--format=esm',
      '--target=node22',
      '--tree-shaking=true',
      '--external:better-sqlite3',
      `--outfile=${recoveryEntry}`,
    ]);
    fs.chmodSync(recoveryEntry, 0o755);
    fs.writeFileSync(
      path.join(recoveryRoot, 'package.json'),
      `${JSON.stringify({ private: true, type: 'module' }, null, 2)}\n`,
      { mode: 0o644 },
    );
    if (includeRuntimeDependencies) {
      const requireFromRepo = createRequire(path.join(exactRepo, 'package.json'));
      const betterSqlitePackage = requireFromRepo.resolve('better-sqlite3/package.json');
      const requireFromBetterSqlite = createRequire(betterSqlitePackage);
      const bindingsPackage = requireFromBetterSqlite.resolve('bindings/package.json');
      const requireFromBindings = createRequire(bindingsPackage);
      const fileUriPackage = requireFromBindings.resolve('file-uri-to-path/package.json');
      copyPackage(betterSqlitePackage, 'better-sqlite3', recoveryRoot);
      copyPackage(bindingsPackage, 'bindings', recoveryRoot);
      copyPackage(fileUriPackage, 'file-uri-to-path', recoveryRoot);
    }

    const builtRecovery = fs.readFileSync(recoveryEntry, 'utf8');
    if (/\bgrantRole\b|roles[ -]grant|--grant/u.test(builtRecovery)) {
      throw new Error('offline recovery bundle contains a reachable grant surface');
    }

    deterministicTar(exactRepo, 'dist', distTemp, epoch);
    deterministicTar(stage, 'recovery', recoveryTemp, epoch);
    let distPublished = false;
    try {
      publishNoReplace(distTemp, distFinal);
      distPublished = true;
      publishNoReplace(recoveryTemp, recoveryFinal);
    } catch (error) {
      if (distPublished) fs.unlinkSync(distFinal);
      throw error;
    }
    const dirFd = fs.openSync(artifactDir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    fs.fsyncSync(dirFd);
    fs.closeSync(dirFd);
    return {
      sourceCommit,
      sourceTree,
      sourceCommitEpoch: Number(epoch),
      dist: { path: distFinal, sha256: sha256(distFinal) },
      recovery: { path: recoveryFinal, sha256: sha256(recoveryFinal) },
    };
  } finally {
    if (fs.existsSync(distTemp)) fs.unlinkSync(distTemp);
    if (fs.existsSync(recoveryTemp)) fs.unlinkSync(recoveryTemp);
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

function parseCli(argv) {
  const values = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!['--repo', '--artifact-dir'].includes(flag) || !value)
      throw new Error('usage: package-artha-17-release.mjs --repo ABS --artifact-dir ABS');
    if (values.has(flag)) throw new Error(`duplicate flag ${flag}`);
    values.set(flag, value);
  }
  if (values.size !== 2) throw new Error('usage: package-artha-17-release.mjs --repo ABS --artifact-dir ABS');
  return { repo: values.get('--repo'), artifactDir: values.get('--artifact-dir') };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(`${JSON.stringify(packageArtha17Release(parseCli(process.argv.slice(2))), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
