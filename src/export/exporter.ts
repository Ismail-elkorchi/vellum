import { constants } from 'node:fs';
import { access, lstat, open, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { ExportProfile } from './profiles.js';
import { exportOutputPath, validateExportProfiles } from './profiles.js';
import { compareText } from '../order.js';

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
  const diagnostics = validateExportProfiles([profile]);
  if (diagnostics.length > 0) throw new Error(diagnostics.map((value) => value.message).join('\n'));
  const inputPath = path.resolve(sourcePath);
  const outputPath = path.resolve(options.outputPath ?? exportOutputPath(inputPath, profile));
  if (outputPath === inputPath) throw new Error('Export output must not replace the source document.');
  const timeoutMilliseconds = options.timeoutMilliseconds ?? 120_000;
  if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds < 1) {
    throw new RangeError('Export timeoutMilliseconds must be a positive integer.');
  }
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
  const reservation = options.overwrite === true ? undefined : await reserveOutput(outputPath);
  try {
    const processResult = await execute(profile.executable, args, timeoutMilliseconds, options.signal);
    const outputMetadata = await lstat(outputPath);
    if (!outputMetadata.isFile()) throw new Error(`Export did not produce a regular output file: ${outputPath}`);
    return Object.freeze({ inputPath, outputPath, executable: profile.executable, arguments: args, ...processResult });
  } catch (error) {
    if (reservation !== undefined) await removeReservation(outputPath, reservation);
    throw error;
  }
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
    entries.sort((left, right) => compareText(left.name, right.name));
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
    let outputBytes = 0;
    let errorBytes = 0;
    let captureExceeded = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMilliseconds);
    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > maximumCapturedOutputBytes) {
        captureExceeded = true;
        child.kill();
      } else output.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      errorBytes += chunk.length;
      if (errorBytes > maximumCapturedOutputBytes) {
        captureExceeded = true;
        child.kill();
      } else errors.push(chunk);
    });
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
      else if (captureExceeded) reject(new Error('Export process output exceeded the capture limit.'));
      else if (code !== 0) reject(new Error(`Export failed with exit status ${String(code)}${standardError.length === 0 ? '.' : `: ${standardError.trim()}`}`));
      else resolve(Object.freeze({ standardOutput, standardError }));
    });
  });
}

const maximumCapturedOutputBytes = 1_000_000;

interface OutputReservation {
  readonly device: bigint;
  readonly inode: bigint;
}

async function reserveOutput(outputPath: string): Promise<OutputReservation> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(outputPath, 'wx');
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`Export output already exists: ${outputPath}`);
    }
    throw error;
  }
  try {
    const metadata = await handle.stat({ bigint: true });
    return Object.freeze({ device: metadata.dev, inode: metadata.ino });
  } finally {
    await handle.close();
  }
}

async function removeReservation(outputPath: string, reservation: OutputReservation): Promise<void> {
  try {
    const metadata = await lstat(outputPath, { bigint: true });
    if (metadata.dev === reservation.device && metadata.ino === reservation.inode) {
      await rm(outputPath);
    }
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT')) throw error;
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch (error) {
    if (error instanceof Error
      && 'code' in error
      && (error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
