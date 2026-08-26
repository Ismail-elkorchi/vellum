import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const repository = path.resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'vellum-package-'));

try {
  const firstDirectory = path.join(temporary, 'first');
  const secondDirectory = path.join(temporary, 'second');
  await Promise.all([mkdir(firstDirectory), mkdir(secondDirectory)]);
  const first = await pack(firstDirectory);
  const second = await pack(secondDirectory);
  const [firstBytes, secondBytes] = await Promise.all([readFile(first.path), readFile(second.path)]);
  if (createHash('sha256').update(firstBytes).digest('hex') !== createHash('sha256').update(secondBytes).digest('hex')) {
    throw new Error('Vellum package archives are not reproducible.');
  }
  const required = new Set([
    'dist/cli.js',
    'dist/cli.d.ts',
    'dist/main.js',
    'dist/main.d.ts',
    'package.json',
    'README.md',
    'LICENSE'
  ]);
  for (const file of first.files) required.delete(file.path);
  if (required.size > 0) throw new Error(`Vellum package is missing: ${[...required].join(', ')}`);
  if (first.files.some((file) => file.path.startsWith('dist/test/') || file.path.startsWith('dist/benchmark/') || file.path.startsWith('dist/scripts/'))) {
    throw new Error('Vellum package contains development-only output.');
  }
  const executable = first.files.find((file) => file.path === 'dist/cli.js');
  if (process.platform !== 'win32' && ((executable?.mode ?? 0) & 0o111) === 0) {
    throw new Error('Vellum package CLI is not executable.');
  }
  const extracted = path.join(temporary, 'extracted');
  await mkdir(extracted);
  const tarExecutable = process.platform === 'win32'
    ? path.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'tar.exe')
    : '/usr/bin/tar';
  await run(tarExecutable, ['-xzf', first.path, '-C', extracted], repository);
  const packedPackage = path.join(extracted, 'package');
  const packedModules = path.join(packedPackage, 'node_modules');
  const packedScope = path.join(packedModules, '@ismail-elkorchi');
  await mkdir(packedScope, { recursive: true });
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  await symlink(path.join(repository, 'node_modules', 'markspan'), path.join(packedModules, 'markspan'), linkType);
  await symlink(
    path.join(repository, 'node_modules', '@ismail-elkorchi', 'terminal-ui'),
    path.join(packedScope, 'terminal-ui'),
    linkType
  );
  const help = await run(process.execPath, [path.join(packedPackage, 'dist', 'cli.js'), '--help'], packedPackage);
  if (!help.standardOutput.includes('vellum export <file-or-project-directory>')) {
    throw new Error('The packed vellum executable help is incomplete.');
  }
  process.stdout.write(`Verified reproducible ${first.filename} and the vellum executable.\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}

async function pack(destination) {
  const npmCli = process.env['npm_execpath'];
  if (npmCli === undefined) throw new Error('npm_execpath is required to verify the package.');
  const result = await run(process.execPath, [npmCli, 'pack', '--json', '--ignore-scripts', '--pack-destination', destination], repository);
  const records = JSON.parse(result.standardOutput);
  const record = Array.isArray(records) ? records[0] : undefined;
  if (record === undefined || typeof record.filename !== 'string' || !Array.isArray(record.files)) {
    throw new Error('npm pack returned an invalid package manifest.');
  }
  return Object.freeze({ ...record, path: path.join(destination, record.filename) });
}

function run(executable, arguments_, workingDirectory) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, arguments_, { cwd: workingDirectory, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const output = [];
    const errors = [];
    child.stdout.on('data', (chunk) => output.push(chunk));
    child.stderr.on('data', (chunk) => errors.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      const standardOutput = Buffer.concat(output).toString('utf8');
      const standardError = Buffer.concat(errors).toString('utf8');
      if (code === 0) resolve({ standardOutput, standardError });
      else reject(new Error(`Command failed with exit status ${String(code)}: ${standardError.trim()}`));
    });
  });
}
