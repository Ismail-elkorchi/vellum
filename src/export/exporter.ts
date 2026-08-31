import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, mkdtemp, open, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { ExportMetadataValue, ExportProfile } from './profiles.js';
import { exportOutputPath, pandocFormat, validateExportProfiles } from './profiles.js';
import { compareText } from '../order.js';
import { flushDirectoryMetadata } from '../files/durability.js';

export interface DiskDocumentSource {
  readonly kind: 'disk';
  readonly path: string;
}

export interface BufferDocumentSource {
  readonly kind: 'buffer';
  readonly source: string;
  readonly label: string;
  readonly baseDirectory: string;
  readonly path?: string;
  readonly unsaved: boolean;
}

export interface CombinedProjectDocumentSource {
  readonly kind: 'combinedProject';
  readonly title: string;
  readonly rootDirectory: string;
  readonly documents: readonly (DiskDocumentSource | BufferDocumentSource)[];
  readonly metadata: Readonly<Record<string, ExportMetadataValue>>;
  readonly resourcePaths: readonly string[];
  readonly bibliography: readonly string[];
  readonly csl?: string;
  readonly outputPath: string;
}

export type ExportDocumentSource = DiskDocumentSource | BufferDocumentSource | CombinedProjectDocumentSource;

export interface ExportOptions {
  readonly outputPath?: string;
  readonly overwrite?: boolean;
  readonly timeoutMilliseconds?: number;
  readonly signal?: AbortSignal;
}

export interface ExportResult {
  readonly inputLabels: readonly string[];
  readonly outputPath: string;
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly standardOutput: string;
  readonly standardError: string;
  readonly elapsedMilliseconds: number;
  readonly usedUnsavedSource: boolean;
}

interface PreparedDocument {
  readonly inputPaths: readonly string[];
  readonly inputLabels: readonly string[];
  readonly baseDirectories: readonly string[];
  readonly defaultOutputPath: string;
  readonly metadata: Readonly<Record<string, ExportMetadataValue>>;
  readonly resourcePaths: readonly string[];
  readonly bibliography: readonly string[];
  readonly csl?: string;
  readonly usedUnsavedSource: boolean;
  cleanup(): Promise<void>;
}

export async function exportDocument(
  document: ExportDocumentSource,
  profile: ExportProfile,
  options: ExportOptions = {}
): Promise<ExportResult> {
  options.signal?.throwIfAborted();
  const diagnostics = validateExportProfiles([profile]);
  if (diagnostics.length > 0) throw new Error(diagnostics.map((value) => value.message).join('\n'));
  const timeoutMilliseconds = options.timeoutMilliseconds ?? 120_000;
  if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds < 1) throw new RangeError('Export timeoutMilliseconds must be a positive integer.');
  const prepared = await prepareDocument(document, profile, options.signal);
  let temporaryOutputPath: string | undefined;
  try {
    const outputPath = path.resolve(options.outputPath ?? prepared.defaultOutputPath);
    if (prepared.inputPaths.includes(outputPath)) throw new Error('Export output must not replace an input document.');
    if (options.overwrite !== true && await exists(outputPath)) throw new Error(`Export output already exists: ${outputPath}`);
    const outputDirectory = path.dirname(outputPath);
    await mkdir(outputDirectory, { recursive: true });
    const stagedOutputPath = path.join(outputDirectory, `.${path.basename(outputPath)}.vellum-${randomUUID()}.tmp`);
    temporaryOutputPath = stagedOutputPath;
    const baseDirectory = document.kind === 'combinedProject' ? document.rootDirectory : prepared.baseDirectories[0] ?? process.cwd();
    const resourcePaths = unique([
      ...prepared.baseDirectories,
      ...profile.resourcePaths.map((value) => path.resolve(baseDirectory, value)),
      ...prepared.resourcePaths.map((value) => path.resolve(baseDirectory, value))
    ]);
    const args = Object.freeze([
      ...profile.arguments,
      `--from=${pandocFormat(profile.reader)}`,
      `--to=${pandocFormat(profile.writer)}`,
      ...(profile.standalone ? ['--standalone'] : []),
      ...(profile.template === undefined ? [] : [`--template=${path.resolve(baseDirectory, profile.template)}`]),
      ...profile.stylesheets.map((value) => `--css=${path.resolve(baseDirectory, value)}`),
      ...profile.filters.map((value) => `--filter=${path.resolve(baseDirectory, value)}`),
      ...[...profile.bibliography, ...prepared.bibliography].map((value) => `--bibliography=${path.resolve(baseDirectory, value)}`),
      ...((prepared.csl ?? profile.csl) === undefined ? [] : [`--csl=${path.resolve(baseDirectory, prepared.csl ?? profile.csl as string)}`]),
      ...metadataArguments({ ...profile.metadata, ...prepared.metadata }),
      `--resource-path=${resourcePaths.join(path.delimiter)}`,
      '--output',
      stagedOutputPath,
      ...prepared.inputPaths
    ]);
    const started = performance.now();
    const processResult = await execute(
      profile.executable,
      args,
      timeoutMilliseconds,
      options.signal,
      Object.freeze({ ...process.env, ...profile.environment })
    );
    const resultArguments = Object.freeze(args.map((argument) => argument === stagedOutputPath ? outputPath : argument));
    await commitExportOutput(stagedOutputPath, outputPath, options.overwrite === true);
    temporaryOutputPath = undefined;
    if (profile.postExport === 'open') await openOutput(outputPath);
    return Object.freeze({
      inputLabels: prepared.inputLabels,
      outputPath,
      executable: profile.executable,
      arguments: resultArguments,
      ...processResult,
      elapsedMilliseconds: performance.now() - started,
      usedUnsavedSource: prepared.usedUnsavedSource
    });
  } finally {
    if (temporaryOutputPath !== undefined) await rm(temporaryOutputPath, { recursive: true, force: true });
    await prepared.cleanup();
  }
}

export async function batchExportDirectory(
  directoryPath: string,
  profile: ExportProfile,
  sources: ReadonlyMap<string, { readonly source: string; readonly unsaved: boolean }> = new Map(),
  options: Omit<ExportOptions, 'outputPath'> = {}
): Promise<readonly ExportResult[]> {
  const files = await markdownFiles(path.resolve(directoryPath), options.signal);
  const results: ExportResult[] = [];
  for (const file of files) {
    options.signal?.throwIfAborted();
    const live = sources.get(file);
    const document: ExportDocumentSource = live === undefined
      ? Object.freeze({ kind: 'disk', path: file })
      : Object.freeze({
          kind: 'buffer',
          source: live.source,
          label: path.basename(file),
          baseDirectory: path.dirname(file),
          path: file,
          unsaved: live.unsaved
        });
    results.push(await exportDocument(document, profile, options));
  }
  return Object.freeze(results);
}

async function prepareDocument(document: ExportDocumentSource, profile: ExportProfile, signal?: AbortSignal): Promise<PreparedDocument> {
  signal?.throwIfAborted();
  if (document.kind === 'disk') {
    const inputPath = path.resolve(document.path);
    return Object.freeze({
      inputPaths: Object.freeze([inputPath]),
      inputLabels: Object.freeze([inputPath]),
      baseDirectories: Object.freeze([path.dirname(inputPath)]),
      defaultOutputPath: exportOutputPath(inputPath, profile),
      metadata: Object.freeze({}),
      resourcePaths: Object.freeze([]),
      bibliography: Object.freeze([]),
      usedUnsavedSource: false,
      async cleanup() {}
    });
  }
  if (document.kind === 'buffer') {
    const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'vellum-export-'));
    const temporaryPath = path.join(temporaryDirectory, safeMarkdownName(document.label));
    await writeFile(temporaryPath, document.source, 'utf8');
    const sourcePath = document.path ?? path.join(document.baseDirectory, document.label);
    return Object.freeze({
      inputPaths: Object.freeze([temporaryPath]),
      inputLabels: Object.freeze([sourcePath]),
      baseDirectories: Object.freeze([path.resolve(document.baseDirectory)]),
      defaultOutputPath: exportOutputPath(sourcePath, profile),
      metadata: Object.freeze({}),
      resourcePaths: Object.freeze([]),
      bibliography: Object.freeze([]),
      usedUnsavedSource: document.unsaved,
      async cleanup() { await rm(temporaryDirectory, { recursive: true, force: true }); }
    });
  }
  if (document.documents.length === 0) throw new Error('A project export must include at least one document.');
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'vellum-project-export-'));
  const inputPaths: string[] = [];
  const inputLabels: string[] = [];
  const baseDirectories: string[] = [];
  let usedUnsavedSource = false;
  try {
    for (let index = 0; index < document.documents.length; index += 1) {
      signal?.throwIfAborted();
      const unit = document.documents[index];
      if (unit === undefined) continue;
      if (unit.kind === 'disk') {
        const inputPath = path.resolve(unit.path);
        inputPaths.push(inputPath);
        inputLabels.push(inputPath);
        baseDirectories.push(path.dirname(inputPath));
      } else {
        const temporaryPath = path.join(temporaryDirectory, `${String(index).padStart(5, '0')}-${safeMarkdownName(unit.label)}`);
        await writeFile(temporaryPath, unit.source, 'utf8');
        inputPaths.push(temporaryPath);
        inputLabels.push(unit.path ?? unit.label);
        baseDirectories.push(path.resolve(unit.baseDirectory));
        usedUnsavedSource ||= unit.unsaved;
      }
    }
    return Object.freeze({
      inputPaths: Object.freeze(inputPaths),
      inputLabels: Object.freeze(inputLabels),
      baseDirectories: Object.freeze(unique(baseDirectories)),
      defaultOutputPath: path.resolve(document.outputPath),
      metadata: document.metadata,
      resourcePaths: document.resourcePaths,
      bibliography: document.bibliography,
      ...(document.csl === undefined ? {} : { csl: document.csl }),
      usedUnsavedSource,
      async cleanup() { await rm(temporaryDirectory, { recursive: true, force: true }); }
    });
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
}

async function markdownFiles(directory: string, signal?: AbortSignal): Promise<readonly string[]> {
  const found: string[] = [];
  const visit = async (current: string): Promise<void> => {
    signal?.throwIfAborted();
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      signal?.throwIfAborted();
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.isSymbolicLink()) continue;
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(candidate);
      else if (entry.isFile() && /\.(?:md|markdown|mdown|mkd)$/iu.test(entry.name)) found.push(candidate);
    }
  };
  await visit(directory);
  return Object.freeze(found);
}

function metadataArguments(metadata: Readonly<Record<string, ExportMetadataValue>>): readonly string[] {
  return Object.freeze(Object.entries(metadata).flatMap(([key, value]) => (
    Array.isArray(value)
      ? value.map((entry) => `--metadata=${key}:${entry}`)
      : [`--metadata=${key}:${String(value)}`]
  )));
}

function execute(
  executable: string,
  arguments_: readonly string[],
  timeoutMilliseconds: number,
  signal: AbortSignal | undefined,
  environment: NodeJS.ProcessEnv
): Promise<{ readonly standardOutput: string; readonly standardError: string }> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...arguments_], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: environment
    });
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    let outputBytes = 0;
    let errorBytes = 0;
    let captureExceeded = false;
    let timedOut = false;
    let aborted = false;
    let forceKillTimer: NodeJS.Timeout | undefined;
    const terminate = (): void => {
      child.kill();
      forceKillTimer ??= setTimeout(() => child.kill('SIGKILL'), 500);
      forceKillTimer.unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMilliseconds);
    const onAbort = (): void => {
      aborted = true;
      terminate();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted === true) onAbort();
    const cleanup = (): void => {
      clearTimeout(timer);
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      signal?.removeEventListener('abort', onAbort);
    };
    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > maximumCapturedOutputBytes) {
        captureExceeded = true;
        terminate();
      } else output.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      errorBytes += chunk.length;
      if (errorBytes > maximumCapturedOutputBytes) {
        captureExceeded = true;
        terminate();
      } else errors.push(chunk);
    });
    child.once('error', (error: NodeJS.ErrnoException) => {
      cleanup();
      if (error.code === 'ENOENT') reject(new Error(`Export executable was not found: ${executable}`));
      else reject(error);
    });
    child.once('close', (code) => {
      cleanup();
      const standardOutput = Buffer.concat(output).toString('utf8');
      const standardError = Buffer.concat(errors).toString('utf8');
      if (aborted) reject(signal?.reason instanceof Error ? signal.reason : new DOMException('Export cancelled.', 'AbortError'));
      else if (timedOut) reject(new Error(`Export exceeded the ${String(timeoutMilliseconds)} ms timeout.`));
      else if (captureExceeded) reject(new Error('Export process output exceeded the capture limit.'));
      else if (code !== 0) reject(new Error(`Export failed with exit status ${String(code)}${standardError.length === 0 ? '.' : `: ${standardError.trim()}`}`));
      else resolve(Object.freeze({ standardOutput, standardError }));
    });
  });
}

async function openOutput(outputPath: string): Promise<void> {
  const executable = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd.exe' : 'xdg-open';
  const arguments_ = process.platform === 'win32' ? ['/d', '/s', '/c', 'start', '', outputPath] : [outputPath];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, arguments_, { stdio: 'ignore', windowsHide: true, detached: process.platform !== 'win32' });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

function unique(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)]);
}

function safeMarkdownName(label: string): string {
  const basename = path.basename(label).replaceAll('\0', '');
  return /\.(?:md|markdown|mdown|mkd)$/iu.test(basename) ? basename : `${basename || 'untitled'}.md`;
}

const maximumCapturedOutputBytes = 1_000_000;

async function commitExportOutput(temporaryPath: string, outputPath: string, overwrite: boolean): Promise<void> {
  const metadata = await lstat(temporaryPath);
  if (!metadata.isFile()) throw new Error(`Export did not produce a regular output file: ${outputPath}`);
  const handle = await open(temporaryPath, process.platform === 'win32' ? 'r+' : 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (overwrite) {
    await rename(temporaryPath, outputPath);
  } else {
    try {
      await link(temporaryPath, outputPath);
    } catch (error) {
      if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error(`Export output already exists: ${outputPath}`);
      }
      throw error;
    }
    await rm(temporaryPath);
  }
  await flushDirectoryMetadata(path.dirname(outputPath));
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
