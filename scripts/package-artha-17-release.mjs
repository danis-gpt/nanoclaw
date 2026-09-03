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
  assertNoSymlinkOrSpecialTree(path.dirname(packageJson));
  fs.cpSync(path.dirname(packageJson), path.join(recoveryRoot, 'node_modules', packageName), {
    recursive: true,
    dereference: true,
  });
}

function assertNoSymlinkOrSpecialTree(root) {
  const stat = fs.lstatSync(root);
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
    throw new Error(`unsafe dependency package input: ${root}`);
  }
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(root).sort()) assertNoSymlinkOrSpecialTree(path.join(root, name));
  }
}

function assertSafeRegularTree(root) {
  const visit = (entry) => {
    const stat = fs.lstatSync(entry);
    if (stat.isSymbolicLink()) throw new Error(`unsafe symlink in package input: ${entry}`);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(entry).sort()) visit(path.join(entry, name));
      return;
    }
    if (!stat.isFile() || stat.nlink !== 1) throw new Error(`unsafe non-regular or hardlinked package input: ${entry}`);
  };
  visit(root);
}

function writeArtifactManifest(root, sourceCommit, sourceTree) {
  const files = {};
  const visit = (entry, relative = '') => {
    for (const name of fs.readdirSync(entry).sort()) {
      const child = path.join(entry, name);
      const childRelative = relative ? `${relative}/${name}` : name;
      const stat = fs.lstatSync(child);
      if (stat.isDirectory()) visit(child, childRelative);
      else if (stat.isFile()) files[childRelative] = sha256(child);
      else throw new Error(`unsafe artifact entry: ${childRelative}`);
    }
  };
  visit(root);
  fs.writeFileSync(
    path.join(root, 'artifact-manifest.json'),
    `${JSON.stringify({ version: 1, source_commit: sourceCommit, source_tree: sourceTree, files }, null, 2)}\n`,
    { mode: 0o644 },
  );
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
      '--format=ustar',
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
    const sourceArchive = path.join(stage, 'source.tar');
    const sourceRoot = path.join(stage, 'source');
    fs.mkdirSync(sourceRoot, { mode: 0o700 });
    const unsafeTrackedEntries = command('/usr/bin/git', ['ls-tree', '-r', sourceCommit], exactRepo)
      .split('\n')
      .filter((line) => line && !line.startsWith('100644 ') && !line.startsWith('100755 '));
    if (unsafeTrackedEntries.length > 0)
      throw new Error('source commit contains non-regular entries and cannot be packaged safely');
    execFileSync('/usr/bin/git', ['archive', '--format=tar', `--output=${sourceArchive}`, sourceCommit], {
      cwd: exactRepo,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    execFileSync('/usr/bin/tar', ['-xf', sourceArchive, '-C', sourceRoot], { stdio: ['ignore', 'ignore', 'pipe'] });
    fs.unlinkSync(sourceArchive);
    const sourceModules = path.join(sourceRoot, 'node_modules');
    fs.symlinkSync(path.join(exactRepo, 'node_modules'), sourceModules, 'dir');
    try {
      execFileSync('/usr/local/bin/pnpm', ['run', 'build'], {
        cwd: sourceRoot,
        stdio: ['ignore', 'ignore', 'pipe'],
        env: { ...process.env, HUSKY: '0' },
      });
    } finally {
      fs.unlinkSync(sourceModules);
    }
    const freshDist = path.join(sourceRoot, 'dist');
    if (!fs.existsSync(freshDist) || !fs.statSync(freshDist).isDirectory()) {
      throw new Error('clean source build did not produce a complete dist directory');
    }
    assertSafeRegularTree(freshDist);

    const distRoot = path.join(stage, 'release');
    fs.mkdirSync(distRoot, { mode: 0o700 });
    fs.cpSync(freshDist, path.join(distRoot, 'dist'), { recursive: true });
    fs.writeFileSync(
      path.join(distRoot, 'package.json'),
      `${JSON.stringify({ private: true, type: 'module' }, null, 2)}\n`,
    );

    const recoveryRoot = path.join(stage, 'recovery');
    fs.mkdirSync(recoveryRoot, { mode: 0o700 });
    const recoveryEntry = path.join(recoveryRoot, 'offline-role-recovery.mjs');
    execFileSync(
      findEsbuild(),
      [
        'src/cli/offline-role-recovery.ts',
        '--bundle',
        '--platform=node',
        '--format=esm',
        '--target=node22',
        '--tree-shaking=true',
        '--external:better-sqlite3',
        `--outfile=${recoveryEntry}`,
      ],
      { cwd: sourceRoot },
    );
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
      copyPackage(betterSqlitePackage, 'better-sqlite3', distRoot);
      copyPackage(bindingsPackage, 'bindings', distRoot);
      copyPackage(fileUriPackage, 'file-uri-to-path', distRoot);
    }

    writeArtifactManifest(distRoot, sourceCommit, sourceTree);
    writeArtifactManifest(recoveryRoot, sourceCommit, sourceTree);
    assertSafeRegularTree(distRoot);
    assertSafeRegularTree(recoveryRoot);

    const builtRecovery = fs.readFileSync(recoveryEntry, 'utf8');
    if (/\bgrantRole\b|roles[ -]grant|--grant/u.test(builtRecovery)) {
      throw new Error('offline recovery bundle contains a reachable grant surface');
    }

    deterministicTar(stage, 'release', distTemp, epoch);
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
