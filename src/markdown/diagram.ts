import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

export interface DiagramRendererDefinition {
  readonly language: string;
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly version: string;
  readonly outputContentType: 'image/png' | 'image/x-portable-pixmap' | 'image/svg+xml';
}

export interface DiagramRenderSettings {
  readonly timeoutMilliseconds: number;
  readonly maximumOutputBytes: number;
}

export interface DiagramRenderResult {
  readonly cacheKey: string;
  readonly contentType: string;
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
  const byLanguage = new Map(definitions.map((definition) => [definition.language.toLowerCase(), definition]));
  const cache = new Map<string, DiagramRenderResult>();
  return Object.freeze({
    async render(language: string, source: string, signal?: AbortSignal) {
      const definition = byLanguage.get(language.toLowerCase());
      if (definition === undefined) return undefined;
      signal?.throwIfAborted();
      const cacheKey = createHash('sha256')
        .update(definition.language).update('\0').update(definition.version).update('\0')
        .update(JSON.stringify(settings)).update('\0').update(source).digest('hex');
      const existing = cache.get(cacheKey);
      if (existing !== undefined) return existing;
      const bytes = await runRenderer(definition, source, settings, signal);
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
    const timer = setTimeout(() => child.kill(), settings.timeoutMilliseconds);
    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > settings.maximumOutputBytes) child.kill();
      else output.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => errors.push(chunk));
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, terminatedBy) => {
      clearTimeout(timer);
      if (outputBytes > settings.maximumOutputBytes) {
        reject(new Error('Diagram renderer output exceeded the configured size limit.'));
      } else if (code !== 0) {
        const detail = Buffer.concat(errors).toString('utf8').trim();
        reject(new Error(`Diagram renderer failed${terminatedBy === null ? '' : ` with ${terminatedBy}`}${detail.length === 0 ? '.' : `: ${detail}`}`));
      } else {
        resolve(new Uint8Array(Buffer.concat(output)));
      }
    });
    child.stdin.end(source, 'utf8');
  });
}
