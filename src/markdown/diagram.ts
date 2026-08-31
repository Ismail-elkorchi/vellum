import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BoundedLruMap } from '../cache/lru.js';

export interface DiagramRendererDefinition {
  readonly language: string;
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly version: string;
  readonly outputContentType: 'image/png' | 'image/x-portable-pixmap';
  readonly transport: 'stdio' | 'files';
}

export interface DiagramRenderSettings {
  readonly timeoutMilliseconds: number;
  readonly maximumOutputBytes: number;
  readonly maximumCacheEntries: number;
}

export interface DiagramRenderResult {
  readonly cacheKey: string;
  readonly contentType: DiagramRendererDefinition['outputContentType'];
  readonly bytes: Uint8Array;
}

export interface DiagramRendererRegistry {
  render(language: string, source: string, signal?: AbortSignal): Promise<DiagramRenderResult | undefined>;
  stats(): { readonly cacheEntries: number; readonly renderers: number };
  clear(): void;
}

export function createDiagramRendererRegistry(
  definitions: readonly DiagramRendererDefinition[],
  settings: Partial<DiagramRenderSettings> = {}
): DiagramRendererRegistry {
  const configuration = validateSettings(Object.freeze({
    timeoutMilliseconds: 10_000,
    maximumOutputBytes: 10_000_000,
    maximumCacheEntries: 128,
    ...settings
  }));
  const byLanguage = new Map<string, DiagramRendererDefinition>();
  for (const definition of definitions) {
    const language = definition.language.trim().toLowerCase();
    if (language.length === 0) throw new TypeError('A diagram renderer language is required.');
    if (byLanguage.has(language)) throw new Error(`Duplicate diagram renderer language: ${language}`);
    if (definition.executable.length === 0) throw new TypeError(`The ${language} diagram renderer executable is required.`);
    if (definition.version.length === 0) throw new TypeError(`The ${language} diagram renderer version is required.`);
    if (definition.transport !== 'stdio' && definition.transport !== 'files') {
      throw new TypeError(`The ${language} diagram renderer transport must be stdio or files.`);
    }
    byLanguage.set(language, Object.freeze({
      ...definition,
      language,
      arguments: Object.freeze([...definition.arguments])
    }));
  }
  const cache = new BoundedLruMap<string, DiagramRenderResult>(configuration.maximumCacheEntries);
  return Object.freeze({
    async render(language: string, source: string, signal?: AbortSignal) {
      const definition = byLanguage.get(language.toLowerCase());
      if (definition === undefined) return undefined;
      signal?.throwIfAborted();
      const cacheKey = createHash('sha256')
        .update(definition.language).update('\0').update(definition.version).update('\0')
        .update(JSON.stringify(configuration)).update('\0').update(source).digest('hex');
      const existing = cache.get(cacheKey);
      if (existing !== undefined) return existing;
      const bytes = await runRenderer(definition, source, configuration, signal);
      const result = Object.freeze({ cacheKey, contentType: definition.outputContentType, bytes });
      cache.set(cacheKey, result);
      return result;
    },
    stats() {
      return Object.freeze({ cacheEntries: cache.size, renderers: byLanguage.size });
    },
    clear() {
      cache.clear();
    }
  });
}

export function mermaidRenderer(executable: string, version: string): DiagramRendererDefinition {
  return Object.freeze({
    language: 'mermaid',
    executable,
    arguments: Object.freeze(['--input', '{input}', '--output', '{output}', '--outputFormat', 'png']),
    version,
    outputContentType: 'image/png',
    transport: 'files'
  });
}

export function detectedDiagramRenderers(environment: NodeJS.ProcessEnv = process.env): readonly DiagramRendererDefinition[] {
  const executable = findExecutable('mmdc', environment);
  if (executable === undefined) return Object.freeze([]);
  const versionResult = spawnSync(executable, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 3_000 });
  if (versionResult.status !== 0) return Object.freeze([]);
  const version = versionResult.stdout.trim() || versionResult.stderr.trim();
  if (version.length === 0) return Object.freeze([]);
  return Object.freeze([mermaidRenderer(executable, version)]);
}

async function runRenderer(
  definition: DiagramRendererDefinition,
  source: string,
  settings: DiagramRenderSettings,
  signal?: AbortSignal
): Promise<Uint8Array> {
  if (definition.transport === 'stdio') {
    return await runRendererProcess(definition, definition.arguments, source, settings, signal);
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vellum-diagram-'));
  const inputPath = path.join(directory, 'input.mmd');
  const outputPath = path.join(directory, 'output.png');
  try {
    await writeFile(inputPath, source, 'utf8');
    const arguments_ = definition.arguments.map((argument) => (
      argument.replaceAll('{input}', inputPath).replaceAll('{output}', outputPath)
    ));
    if (!definition.arguments.some((argument) => argument.includes('{input}'))
      || !definition.arguments.some((argument) => argument.includes('{output}'))) {
      throw new Error(`File-based diagram renderer ${definition.language} must declare {input} and {output} arguments.`);
    }
    await runRendererProcess(definition, arguments_, undefined, settings, signal);
    const bytes = await readFile(outputPath);
    if (bytes.length > settings.maximumOutputBytes) throw new Error('Diagram renderer output exceeded the configured size limit.');
    return new Uint8Array(bytes);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function runRendererProcess(
  definition: DiagramRendererDefinition,
  arguments_: readonly string[],
  source: string | undefined,
  settings: DiagramRenderSettings,
  signal?: AbortSignal
): Promise<Uint8Array> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(definition.executable, [...arguments_], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    let outputBytes = 0;
    let errorBytes = 0;
    let outputExceeded = false;
    let errorsTruncated = false;
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
    }, settings.timeoutMilliseconds);
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
      if (outputBytes > settings.maximumOutputBytes) {
        outputExceeded = true;
        terminate();
      }
      else output.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const remaining = settings.maximumOutputBytes - errorBytes;
      if (remaining <= 0) {
        errorsTruncated = true;
        return;
      }
      errors.push(chunk.subarray(0, remaining));
      errorBytes += Math.min(chunk.length, remaining);
      if (chunk.length > remaining) errorsTruncated = true;
    });
    child.stdin.on('error', () => undefined);
    child.once('error', (error) => {
      cleanup();
      reject(error);
    });
    child.once('close', (code, terminatedBy) => {
      cleanup();
      if (aborted) {
        reject(signal?.reason instanceof Error ? signal.reason : new DOMException('Diagram rendering cancelled.', 'AbortError'));
      } else if (timedOut) {
        reject(new Error(`Diagram rendering exceeded the ${String(settings.timeoutMilliseconds)} ms timeout.`));
      } else if (outputExceeded) {
        reject(new Error('Diagram renderer output exceeded the configured size limit.'));
      } else if (code !== 0) {
        const detail = Buffer.concat(errors).toString('utf8').trim();
        const suffix = detail.length === 0 ? '.' : `: ${detail}${errorsTruncated ? '…' : ''}`;
        reject(new Error(`Diagram renderer failed${terminatedBy === null ? '' : ` with ${terminatedBy}`}${suffix}`));
      } else {
        resolve(new Uint8Array(Buffer.concat(output)));
      }
    });
    if (source === undefined) child.stdin.end();
    else child.stdin.end(source, 'utf8');
  });
}

function findExecutable(command: string, environment: NodeJS.ProcessEnv): string | undefined {
  const pathValue = environment['PATH'];
  if (pathValue === undefined) return undefined;
  const extensions = process.platform === 'win32'
    ? (environment['PATHEXT'] ?? '.EXE;.CMD;.BAT;.COM').split(';')
    : [''];
  for (const directory of pathValue.split(path.delimiter)) {
    if (directory.length === 0) continue;
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension}`);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Continue through PATH.
      }
    }
  }
  return undefined;
}

function validateSettings(settings: DiagramRenderSettings): DiagramRenderSettings {
  if (!Number.isSafeInteger(settings.timeoutMilliseconds) || settings.timeoutMilliseconds < 1) {
    throw new RangeError('Diagram rendering timeoutMilliseconds must be a positive integer.');
  }
  if (!Number.isSafeInteger(settings.maximumOutputBytes) || settings.maximumOutputBytes < 1) {
    throw new RangeError('Diagram rendering maximumOutputBytes must be a positive integer.');
  }
  if (!Number.isSafeInteger(settings.maximumCacheEntries) || settings.maximumCacheEntries < 1) {
    throw new RangeError('Diagram rendering maximumCacheEntries must be a positive integer.');
  }
  return Object.freeze({ ...settings });
}
