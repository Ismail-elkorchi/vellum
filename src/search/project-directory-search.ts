import { open } from 'node:fs/promises';
import type { FileTreeState } from '../app/types.js';
import { indexedFilePaths } from '../project/file-tree.js';
import {
  findDocumentMatches,
  type DocumentSearchOptions
} from './document-search.js';
import { compareText } from '../order.js';

export interface ProjectDirectorySearchOptions extends DocumentSearchOptions {
  readonly maximumFileBytes?: number;
  readonly concurrency?: number;
}

export interface ProjectDirectorySearchResult {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly span: { readonly start: number; readonly end: number };
  readonly context: string;
}

export async function searchProjectDirectory(
  fileTree: FileTreeState,
  query: string,
  options: ProjectDirectorySearchOptions,
  signal: AbortSignal
): Promise<readonly ProjectDirectorySearchResult[]> {
  const paths = indexedFilePaths(fileTree);
  const maximumFileBytes = bounded(options.maximumFileBytes ?? 2_000_000, 1, 100_000_000, 'maximumFileBytes');
  const concurrency = bounded(options.concurrency ?? 8, 1, 64, 'concurrency');
  const results: ProjectDirectorySearchResult[] = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, paths.length) }, async () => {
    for (;;) {
      signal.throwIfAborted();
      const index = cursor;
      cursor += 1;
      const filePath = paths[index];
      if (filePath === undefined) return;
      const bytes = await readBoundedProjectFile(filePath, maximumFileBytes, signal);
      if (bytes === undefined || bytes.subarray(0, 8_192).includes(0)) continue;
      let source: string;
      try {
        source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        continue;
      }
      const found = findDocumentMatches(source, query, options);
      if (found.error !== undefined) throw new Error(found.error);
      const starts = sourceLineStarts(source);
      for (const match of found.matches) {
        const position = lineColumn(starts, match.start);
        const lineEnd = source.indexOf('\n', match.end);
        const lineStart = source.lastIndexOf('\n', Math.max(0, match.start - 1)) + 1;
        results.push(Object.freeze({
          path: filePath,
          line: position.line,
          column: position.column,
          span: Object.freeze({ start: match.start, end: match.end }),
          context: source.slice(lineStart, lineEnd < 0 ? source.length : lineEnd).replace(/\r$/u, '')
        }));
      }
    }
  });
  await Promise.all(workers);
  return Object.freeze(results.toSorted((left, right) => (
    compareText(left.path, right.path)
    || left.span.start - right.span.start
    || left.span.end - right.span.end
  )));
}

async function readBoundedProjectFile(
  filePath: string,
  maximumBytes: number,
  signal: AbortSignal
): Promise<Uint8Array | undefined> {
  signal.throwIfAborted();
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(filePath, 'r');
  } catch (error) {
    if (fileErrorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > maximumBytes) return undefined;
    const bytes = Buffer.alloc(metadata.size);
    let offset = 0;
    while (offset < bytes.length) {
      signal.throwIfAborted();
      const read = await handle.read(bytes, offset, Math.min(65_536, bytes.length - offset), offset);
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    const extra = Buffer.alloc(1);
    if ((await handle.read(extra, 0, 1, offset)).bytesRead > 0) return undefined;
    signal.throwIfAborted();
    return new Uint8Array(bytes.subarray(0, offset));
  } finally {
    await handle.close();
  }
}

function fileErrorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}

function sourceLineStarts(source: string): readonly number[] {
  const starts = [0];
  for (let offset = 0; offset < source.length; offset += 1) {
    if (source.charCodeAt(offset) === 0x0a) starts.push(offset + 1);
  }
  return Object.freeze(starts);
}

function lineColumn(starts: readonly number[], offset: number): { readonly line: number; readonly column: number } {
  let low = 0;
  let high = starts.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((starts[middle] ?? Number.POSITIVE_INFINITY) <= offset) low = middle + 1;
    else high = middle;
  }
  const index = Math.max(0, low - 1);
  return { line: index + 1, column: offset - (starts[index] ?? 0) + 1 };
}

function bounded(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be between ${minimum} and ${maximum}.`);
  }
  return value;
}
