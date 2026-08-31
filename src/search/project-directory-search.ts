import path from 'node:path';
import { minimatch } from 'minimatch';
import type { ProjectDocumentIndexEntry, ProjectIndexState } from '../app/types.js';
import {
  findDocumentMatches,
  type DocumentSearchOptions
} from './document-search.js';
import { compareText } from '../order.js';

export interface ProjectDirectorySearchOptions extends DocumentSearchOptions {
  readonly maximumResults?: number;
  readonly includePatterns?: readonly string[];
  readonly excludePatterns?: readonly string[];
  readonly sort?: 'relevance' | 'path' | 'modified';
  readonly onBatch?: (results: readonly ProjectDirectorySearchResult[]) => void;
}

export interface ProjectDirectorySearchResult {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly span: { readonly start: number; readonly end: number };
  readonly context: string;
}

interface ParsedProjectQuery {
  readonly content: string;
  readonly regularExpression: boolean;
  readonly paths: readonly string[];
  readonly files: readonly string[];
  readonly headings: readonly string[];
  readonly properties: readonly { readonly key: string; readonly value?: string }[];
  readonly links: readonly { readonly value: string; readonly negated: boolean }[];
  readonly task?: 'open' | 'closed';
}

export async function searchProjectDirectory(
  index: ProjectIndexState,
  query: string,
  options: ProjectDirectorySearchOptions,
  signal: AbortSignal
): Promise<readonly ProjectDirectorySearchResult[]> {
  const maximumResults = bounded(options.maximumResults ?? 2_000, 1, 100_000, 'maximumResults');
  const parsed = parseProjectQuery(query, options.regularExpression === true);
  const results: ProjectDirectorySearchResult[] = [];
  let batch: ProjectDirectorySearchResult[] = [];
  for (let documentIndex = 0; documentIndex < index.orderedPaths.length; documentIndex += 1) {
    if (documentIndex > 0 && documentIndex % 64 === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      signal.throwIfAborted();
    }
    const filePath = index.orderedPaths[documentIndex] as string;
    signal.throwIfAborted();
    const document = index.documents[filePath];
    if (document === undefined || !documentMatchesFilters(document, parsed, options)) continue;
    const matches = contentMatches(document, parsed, options);
    if (matches.length === 0) continue;
    const starts = sourceLineStarts(document.searchableText);
    for (const match of matches) {
      const position = lineColumn(starts, match.start);
      const lineEnd = document.searchableText.indexOf('\n', match.end);
      const lineStart = document.searchableText.lastIndexOf('\n', Math.max(0, match.start - 1)) + 1;
      const result = Object.freeze({
        path: filePath,
        line: position.line,
        column: position.column,
        span: Object.freeze({ start: match.start, end: match.end }),
        context: document.searchableText.slice(lineStart, lineEnd < 0 ? document.searchableText.length : lineEnd).replace(/\r$/u, '')
      });
      results.push(result);
      batch.push(result);
      if (batch.length >= 32) {
        options.onBatch?.(Object.freeze(batch));
        batch = [];
        await new Promise<void>((resolve) => setImmediate(resolve));
        signal.throwIfAborted();
      }
      if (results.length >= maximumResults) break;
    }
    if (results.length >= maximumResults) break;
  }
  if (batch.length > 0) options.onBatch?.(Object.freeze(batch));
  return Object.freeze(results.toSorted(resultComparator(index, parsed, options.sort ?? 'relevance')));
}

export function parseProjectQuery(query: string, regularExpression = false): ParsedProjectQuery {
  const paths: string[] = [];
  const files: string[] = [];
  const headings: string[] = [];
  const properties: Array<{ readonly key: string; readonly value?: string }> = [];
  const links: Array<{ readonly value: string; readonly negated: boolean }> = [];
  let task: ParsedProjectQuery['task'];
  const content: string[] = [];
  for (const token of tokenize(query)) {
    const separator = token.indexOf(':');
    const rawField = separator < 0 ? '' : token.slice(0, separator).toLowerCase();
    const negated = rawField.startsWith('-');
    const field = negated ? rawField.slice(1) : rawField;
    const value = separator < 0 ? token : token.slice(separator + 1);
    if (!negated && field === 'path') paths.push(value);
    else if (!negated && field === 'file') files.push(value);
    else if (!negated && field === 'heading') headings.push(value);
    else if (!negated && field === 'property') {
      const equals = value.indexOf('=');
      properties.push(Object.freeze(equals < 0
        ? { key: value }
        : { key: value.slice(0, equals), value: value.slice(equals + 1) }));
    } else if (field === 'link' && value.length > 0) links.push(Object.freeze({ value, negated }));
    else if (!negated && field === 'task' && (value === 'open' || value === 'closed')) task = value;
    else content.push(token);
  }
  const joined = content.join(' ');
  const slashExpression = joined.length > 2 && joined.startsWith('/') && joined.endsWith('/');
  return Object.freeze({
    content: slashExpression ? joined.slice(1, -1) : joined,
    regularExpression: regularExpression || slashExpression,
    paths: Object.freeze(paths),
    files: Object.freeze(files),
    headings: Object.freeze(headings),
    properties: Object.freeze(properties),
    links: Object.freeze(links),
    ...(task === undefined ? {} : { task })
  });
}

function documentMatchesFilters(
  document: ProjectDocumentIndexEntry,
  query: ParsedProjectQuery,
  options: ProjectDirectorySearchOptions
): boolean {
  const normalizedPath = document.relativePath.replaceAll('\\', '/');
  if (query.paths.some((value) => !wildcardMatch(normalizedPath, value))) return false;
  if (query.files.some((value) => !path.basename(document.path).toLowerCase().includes(value.toLowerCase()))) return false;
  if (query.headings.some((value) => !document.headings.some((heading) => heading.text.toLowerCase().includes(value.toLowerCase())))) return false;
  if (query.properties.some((filter) => {
    const value = document.properties[filter.key];
    return value === undefined || (filter.value !== undefined && String(value).toLowerCase() !== filter.value.toLowerCase());
  })) return false;
  if (query.links.some((filter) => {
    const linked = document.links.some((link) => link.destination.toLowerCase().includes(filter.value.toLowerCase()));
    return filter.negated ? linked : !linked;
  })) return false;
  if (query.task === 'open' && !document.taskStates.includes(false)) return false;
  if (query.task === 'closed' && !document.taskStates.includes(true)) return false;
  if ((options.includePatterns?.length ?? 0) > 0
    && !options.includePatterns?.some((pattern) => wildcardMatch(normalizedPath, pattern))) return false;
  if (options.excludePatterns?.some((pattern) => wildcardMatch(normalizedPath, pattern)) === true) return false;
  return true;
}

function resultComparator(
  index: ProjectIndexState,
  query: ParsedProjectQuery,
  sort: NonNullable<ProjectDirectorySearchOptions['sort']>
): (left: ProjectDirectorySearchResult, right: ProjectDirectorySearchResult) => number {
  return (left, right) => {
    if (sort === 'modified') {
      const modified = (index.documents[right.path]?.modifiedMilliseconds ?? 0)
        - (index.documents[left.path]?.modifiedMilliseconds ?? 0);
      if (modified !== 0) return modified;
    } else if (sort === 'relevance') {
      const relevance = resultRelevance(right, query) - resultRelevance(left, query);
      if (relevance !== 0) return relevance;
    }
    return compareText(left.path, right.path)
      || left.span.start - right.span.start
      || left.span.end - right.span.end;
  };
}

function resultRelevance(result: ProjectDirectorySearchResult, query: ParsedProjectQuery): number {
  if (query.content.length === 0) return 0;
  const needle = query.content.toLowerCase();
  const filename = path.basename(result.path).toLowerCase();
  const context = result.context.toLowerCase();
  return (filename === needle ? 8 : filename.startsWith(needle) ? 6 : filename.includes(needle) ? 4 : 0)
    + (context.trimStart().startsWith(needle) ? 3 : context.includes(needle) ? 1 : 0);
}

function contentMatches(
  document: ProjectDocumentIndexEntry,
  query: ParsedProjectQuery,
  options: ProjectDirectorySearchOptions
): readonly { readonly start: number; readonly end: number }[] {
  if (query.content.length === 0) return Object.freeze([{ start: 0, end: 0 }]);
  const found = findDocumentMatches(document.searchableText, query.content, {
    ...options,
    regularExpression: query.regularExpression
  });
  if (found.error !== undefined) throw new Error(found.error);
  return found.matches;
}

function tokenize(value: string): readonly string[] {
  const tokens: string[] = [];
  let current = '';
  let quote = false;
  for (const character of value.trim()) {
    if (character === '"') {
      quote = !quote;
      continue;
    }
    if (/\s/u.test(character) && !quote) {
      if (current.length > 0) tokens.push(current);
      current = '';
    } else current += character;
  }
  if (quote) throw new Error('The project search query contains an unterminated quote.');
  if (current.length > 0) tokens.push(current);
  return Object.freeze(tokens);
}

function wildcardMatch(value: string, pattern: string): boolean {
  return minimatch(value, pattern, {
    dot: true,
    matchBase: !pattern.includes('/'),
    nocase: process.platform === 'win32'
  });
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
