import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

export interface DiagramRendererDefinition {
  readonly language: string;
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly version: string;
  readonly outputContentType: 'image/png' | 'image/x-portable-pixmap';
}

export interface DiagramRenderSettings {
  readonly timeoutMilliseconds: number;
  readonly maximumOutputBytes: number;
}

export interface DiagramRenderResult {
  readonly cacheKey: string;
  readonly contentType: DiagramRendererDefinition['outputContentType'];
  readonly bytes: Uint8Array;
}

export interface DiagramRendererRegistry {
  render(language: string, source: string, signal?: AbortSignal): Promise<DiagramRenderResult | undefined>;
  clear(): void;
}

export function createDiagramRendererRegistry(
  definitions: readonly DiagramRendererDefinition[],
  settings: DiagramRenderSettings = { timeoutMilliseconds: 10_000, maximumOutputBytes: 10_000_000 }
): DiagramRendererRegistry {
  const configuration = validateSettings(settings);
  const byLanguage = new Map<string, DiagramRendererDefinition>();
  for (const definition of definitions) {
    const language = definition.language.trim().toLowerCase();
    if (language.length === 0) throw new TypeError('A diagram renderer language is required.');
    if (byLanguage.has(language)) throw new Error(`Duplicate diagram renderer language: ${language}`);
    if (definition.executable.length === 0) throw new TypeError(`The ${language} diagram renderer executable is required.`);
    if (definition.version.length === 0) throw new TypeError(`The ${language} diagram renderer version is required.`);
    byLanguage.set(language, Object.freeze({
      ...definition,
      language,
      arguments: Object.freeze([...definition.arguments])
    }));
  }
  const cache = new Map<string, DiagramRenderResult>();
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
    clear() {
      cache.clear();
    }
  });
}

export function mermaidRenderer(executable: string, version: string): DiagramRendererDefinition {
  return Object.freeze({
    language: 'mermaid',
    executable,
    arguments: Object.freeze(['--input', '-', '--output', '-', '--outputFormat', 'png']),
    version,
    outputContentType: 'image/png'
  });
}

function runRenderer(
  definition: DiagramRendererDefinition,
  source: string,
  settings: DiagramRenderSettings,
  signal?: AbortSignal
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const child = spawn(definition.executable, [...definition.arguments], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      ...(signal === undefined ? {} : { signal })
    });
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    let outputBytes = 0;
    let errorBytes = 0;
    let outputExceeded = false;
    let errorsTruncated = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, settings.timeoutMilliseconds);
    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > settings.maximumOutputBytes) {
        outputExceeded = true;
        child.kill();
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
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, terminatedBy) => {
      clearTimeout(timer);
      if (timedOut) {
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
    child.stdin.end(source, 'utf8');
  });
}

function validateSettings(settings: DiagramRenderSettings): DiagramRenderSettings {
  if (!Number.isSafeInteger(settings.timeoutMilliseconds) || settings.timeoutMilliseconds < 1) {
    throw new RangeError('Diagram rendering timeoutMilliseconds must be a positive integer.');
  }
  if (!Number.isSafeInteger(settings.maximumOutputBytes) || settings.maximumOutputBytes < 1) {
    throw new RangeError('Diagram rendering maximumOutputBytes must be a positive integer.');
  }
  return Object.freeze({ ...settings });
}
