import { constants } from 'node:fs';
import { access, readdir } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { ExportProfile } from './profiles.js';
import { exportOutputPath } from './profiles.js';

export interface ExportOptions {
  readonly outputPath?: string;
  readonly overwrite?: boolean;
  readonly timeoutMilliseconds?: number;
  readonly signal?: AbortSignal;
}

export interface ExportResult {
  readonly inputPath: string;
  readonly outputPath: string;
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly standardOutput: string;
  readonly standardError: string;
}

export async function exportSourceDocument(
  sourcePath: string,
  profile: ExportProfile,
  options: ExportOptions = {}
): Promise<ExportResult> {
  options.signal?.throwIfAborted();
  const inputPath = path.resolve(sourcePath);
  const outputPath = path.resolve(options.outputPath ?? exportOutputPath(inputPath, profile));
  if (options.overwrite !== true && await exists(outputPath)) {
    throw new Error(`Export output already exists: ${outputPath}`);
  }
  const resourcePaths = [path.dirname(inputPath), ...profile.resourcePaths.map((value) => path.resolve(path.dirname(inputPath), value))];
  const args = Object.freeze([
    ...profile.arguments,
    '--from=gfm',
    `--to=${profile.targetFormat}`,
    `--resource-path=${resourcePaths.join(path.delimiter)}`,
    '--output',
    outputPath,
    inputPath
  ]);
  const processResult = await execute(profile.executable, args, options.timeoutMilliseconds ?? 120_000, options.signal);
  return Object.freeze({ inputPath, outputPath, executable: profile.executable, arguments: args, ...processResult });
}

export async function exportProjectDirectory(
  directoryPath: string,
  profile: ExportProfile,
  options: Omit<ExportOptions, 'outputPath'> = {}
): Promise<readonly ExportResult[]> {
  const files = await markdownFiles(path.resolve(directoryPath), options.signal);
  const results: ExportResult[] = [];
  for (const file of files) {
    options.signal?.throwIfAborted();
    results.push(await exportSourceDocument(file, profile, options));
  }
  return Object.freeze(results);
}

async function markdownFiles(directory: string, signal?: AbortSignal): Promise<readonly string[]> {
  const found: string[] = [];
  const visit = async (current: string): Promise<void> => {
    signal?.throwIfAborted();
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      signal?.throwIfAborted();
      if (entry.name === '.git' || entry.isSymbolicLink()) continue;
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(candidate);
      else if (entry.isFile() && /\.(?:md|markdown)$/iu.test(entry.name)) found.push(candidate);
    }
  };
  await visit(directory);
  return Object.freeze(found);
}

function execute(
  executable: string,
  arguments_: readonly string[],
  timeoutMilliseconds: number,
  signal?: AbortSignal
): Promise<{ readonly standardOutput: string; readonly standardError: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...arguments_], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      ...(signal === undefined ? {} : { signal })
    });
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMilliseconds);
    child.stdout.on('data', (chunk: Buffer) => output.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => errors.push(chunk));
    child.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (error.code === 'ENOENT') reject(new Error(`Export executable was not found: ${executable}`));
      else reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      const standardOutput = Buffer.concat(output).toString('utf8');
      const standardError = Buffer.concat(errors).toString('utf8');
      if (timedOut) reject(new Error(`Export exceeded the ${String(timeoutMilliseconds)} ms timeout.`));
      else if (code !== 0) reject(new Error(`Export failed with exit status ${String(code)}${standardError.length === 0 ? '.' : `: ${standardError.trim()}`}`));
      else resolve(Object.freeze({ standardOutput, standardError }));
    });
  });
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
