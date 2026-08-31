import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import { lstat, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import ignore, { type Ignore } from 'ignore';
import { minimatch } from 'minimatch';
import {
  extractMarkdownOutline,
  type MarkdownFrontMatterValue,
  type MarkdownNode
} from 'markspan';
import type {
  ProjectDocumentIndexEntry,
  ProjectIndexState,
  ProjectLinkIndexEntry
} from '../app/types.js';
import { createBufferParser } from '../markdown/preview.js';
import { compareText } from '../order.js';

export interface ProjectIndexSettings {
  readonly extensions: readonly string[];
  readonly maximumFileBytes: number;
  readonly includePatterns: readonly string[];
  readonly excludePatterns: readonly string[];
  readonly symlinkFiles: boolean;
}

export interface BuiltProjectIndex {
  readonly state: ProjectIndexState;
  readonly directories: readonly string[];
}

interface IgnoreLayer {
  readonly base: string;
  readonly matcher: Ignore;
  readonly hasNegation: boolean;
}

export const defaultProjectIndexSettings: ProjectIndexSettings = Object.freeze({
  extensions: Object.freeze(['.md', '.markdown', '.mdown', '.mkd']),
  maximumFileBytes: 2 * 1024 * 1024,
  includePatterns: Object.freeze([]),
  excludePatterns: Object.freeze(['.git/', 'node_modules/']),
  symlinkFiles: true
});

export function emptyProjectIndex(): ProjectIndexState {
  return Object.freeze({
    documents: Object.freeze({}),
    orderedPaths: Object.freeze([]),
    assetPaths: Object.freeze([]),
    indexing: false,
    revision: 0
  });
}

export async function buildProjectIndex(
  rootDirectory: string,
  previous: ProjectIndexState,
  suppliedSettings: Partial<ProjectIndexSettings> = {},
  signal?: AbortSignal
): Promise<BuiltProjectIndex> {
  const root = path.resolve(rootDirectory);
  const settings = resolveSettings(suppliedSettings);
  const documents: Record<string, ProjectDocumentIndexEntry> = {};
  const directories: string[] = [];
  const assetPaths: string[] = [];
  const initialRules: readonly IgnoreLayer[] = settings.excludePatterns.length === 0
    ? Object.freeze([])
    : Object.freeze([ignoreLayer('', settings.excludePatterns.join('\n'))]);
  const pending: Array<{ readonly directory: string; readonly rules: readonly IgnoreLayer[] }> = [
    Object.freeze({ directory: root, rules: initialRules })
  ];
  while (pending.length > 0) {
    signal?.throwIfAborted();
    const current = pending.pop();
    if (current === undefined) break;
    directories.push(current.directory);
    const relativeDirectory = normalizedRelative(root, current.directory);
    const localRules = await readIgnoreRules(current.directory, relativeDirectory, current.rules);
    const entries = (await readdir(current.directory, { withFileTypes: true }))
      .toSorted((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      signal?.throwIfAborted();
      if (entry.name === '.gitignore' || entry.name === '.ignore') continue;
      const entryPath = path.join(current.directory, entry.name);
      const relativePath = normalizedRelative(root, entryPath);
      const isDirectory = entry.isDirectory();
      if (pathIgnored(relativePath, isDirectory, localRules)) {
        if (isDirectory && localRules.some((rule) => rule.hasNegation)) {
          pending.push(Object.freeze({ directory: entryPath, rules: localRules }));
        }
        continue;
      }
      if (isDirectory) {
        pending.push(Object.freeze({ directory: entryPath, rules: localRules }));
        continue;
      }
      let file = entry.isFile();
      if (entry.isSymbolicLink() && settings.symlinkFiles) file = (await statIfPresent(entryPath))?.isFile() === true;
      if (!file) continue;
      if (assetExtension(relativePath)) {
        assetPaths.push(entryPath);
        continue;
      }
      if (!supportedDocument(relativePath, settings)) continue;
      const metadata = await stat(entryPath);
      if (metadata.size > settings.maximumFileBytes) continue;
      const previousEntry = previous.documents[entryPath];
      if (previousEntry !== undefined
        && previousEntry.size === metadata.size
        && previousEntry.modifiedMilliseconds === metadata.mtimeMs) {
        documents[entryPath] = previousEntry;
        continue;
      }
      const bytes = await readFile(entryPath);
      if (bytes.includes(0)) continue;
      let source: string;
      try {
        source = decodeUtf8Source(bytes);
      } catch {
        continue;
      }
      documents[entryPath] = indexDocument(entryPath, relativePath, source, metadata.size, metadata.mtimeMs);
    }
  }
  const orderedPaths = Object.keys(documents).toSorted(compareText);
  return Object.freeze({
    state: Object.freeze({
      documents: Object.freeze(documents),
      orderedPaths: Object.freeze(orderedPaths),
      assetPaths: Object.freeze(assetPaths.toSorted(compareText)),
      indexing: false,
      revision: previous.revision + 1
    }),
    directories: Object.freeze(directories.toSorted(compareText))
  });
}

export async function updateProjectIndexPaths(
  rootDirectory: string,
  previous: ProjectIndexState,
  changedPaths: readonly string[],
  suppliedSettings: Partial<ProjectIndexSettings> = {},
  signal?: AbortSignal
): Promise<ProjectIndexState | undefined> {
  const root = path.resolve(rootDirectory);
  const settings = resolveSettings(suppliedSettings);
  const documents: Record<string, ProjectDocumentIndexEntry> = { ...previous.documents };
  const assets = new Set(previous.assetPaths);
  let changed = false;
  for (const suppliedPath of new Set(changedPaths.map((candidate) => path.resolve(candidate)))) {
    signal?.throwIfAborted();
    const relativePath = normalizedRelative(root, suppliedPath);
    if (relativePath === '') return undefined;
    if (relativePath === '..' || relativePath.startsWith('../') || path.isAbsolute(relativePath)) continue;
    if (path.basename(suppliedPath) === '.gitignore' || path.basename(suppliedPath) === '.ignore') return undefined;
    const metadata = await lstatIfPresent(suppliedPath);
    if (metadata?.isDirectory() === true) return undefined;
    if (metadata === undefined) {
      for (const documentPath of Object.keys(documents)) {
        if (documentPath === suppliedPath || pathWithin(suppliedPath, documentPath)) {
          delete documents[documentPath];
          changed = true;
        }
      }
      for (const assetPath of [...assets]) {
        if (assetPath === suppliedPath || pathWithin(suppliedPath, assetPath)) {
          assets.delete(assetPath);
          changed = true;
        }
      }
      continue;
    }
    const fileMetadata = metadata.isSymbolicLink() && settings.symlinkFiles
      ? await statIfPresent(suppliedPath)
      : metadata;
    const rules = await ignoreRulesForPath(root, path.dirname(suppliedPath), settings.excludePatterns);
    const ignored = pathIgnored(relativePath, false, rules);
    const asset = assetExtension(relativePath);
    const document = supportedDocument(relativePath, settings);
    if (ignored || fileMetadata?.isFile() !== true || (!asset && !document)) {
      if (delete documents[suppliedPath]) changed = true;
      if (assets.delete(suppliedPath)) changed = true;
      continue;
    }
    if (asset) {
      if (!assets.has(suppliedPath)) {
        assets.add(suppliedPath);
        changed = true;
      }
      if (delete documents[suppliedPath]) changed = true;
      continue;
    }
    assets.delete(suppliedPath);
    if (fileMetadata.size > settings.maximumFileBytes) {
      if (delete documents[suppliedPath]) changed = true;
      continue;
    }
    const old = documents[suppliedPath];
    if (old !== undefined && old.size === fileMetadata.size && old.modifiedMilliseconds === fileMetadata.mtimeMs) continue;
    const bytes = await readFile(suppliedPath);
    if (bytes.includes(0)) {
      if (delete documents[suppliedPath]) changed = true;
      continue;
    }
    try {
      const source = decodeUtf8Source(bytes);
      documents[suppliedPath] = indexDocument(suppliedPath, relativePath, source, fileMetadata.size, fileMetadata.mtimeMs);
      changed = true;
    } catch {
      if (delete documents[suppliedPath]) changed = true;
    }
  }
  if (!changed) return previous;
  return Object.freeze({
    documents: Object.freeze(documents),
    orderedPaths: Object.freeze(Object.keys(documents).toSorted(compareText)),
    assetPaths: Object.freeze([...assets].toSorted(compareText)),
    indexing: false,
    revision: previous.revision + 1
  });
}

export function overlayOpenBuffers(
  index: ProjectIndexState,
  buffers: AppBufferOverlay
): ProjectIndexState {
  let changed = false;
  const documents: Record<string, ProjectDocumentIndexEntry> = { ...index.documents };
  for (const buffer of buffers) {
    if (buffer.path === undefined) continue;
    const existing = documents[buffer.path];
    const hash = contentHash(buffer.source);
    if (existing?.contentHash === hash) continue;
    const relativePath = existing?.relativePath ?? path.basename(buffer.path);
    documents[buffer.path] = indexDocument(
      buffer.path,
      relativePath,
      buffer.source,
      Buffer.byteLength(buffer.source),
      existing?.modifiedMilliseconds ?? 0
    );
    changed = true;
  }
  return changed
    ? Object.freeze({ ...index, documents: Object.freeze(documents), revision: index.revision + 1 })
    : index;
}

export type AppBufferOverlay = readonly {
  readonly path?: string;
  readonly source: string;
}[];

function indexDocument(
  filePath: string,
  relativePath: string,
  source: string,
  size: number,
  modifiedMilliseconds: number
): ProjectDocumentIndexEntry {
  const preview = createBufferParser(source, 0).preview();
  const headings = preview.kind === 'ready'
    ? flattenOutline(extractMarkdownOutline(preview.snapshot.document.tree)).map((entry) => Object.freeze({
        text: entry.text,
        depth: entry.depth,
        sourceOffset: entry.span.start
      }))
    : [];
  const links: ProjectLinkIndexEntry[] = [];
  const taskStates: boolean[] = [];
  const properties: Record<string, string | number | boolean | readonly string[]> = {};
  const tags = [...new Set([...source.matchAll(/(?:^|[\s([{])#([\p{L}\p{N}_][\p{L}\p{N}_/-]*)/gmu)].map((match) => match[1] ?? '').filter(Boolean))];
  const citationKeys = [...new Set([...source.matchAll(/(?:^|[\s\[;(])-?@([A-Za-z0-9_:.#$%&+?<>~/\\-]+)/gmu)].map((match) => match[1] ?? '').filter(Boolean))];
  if (preview.kind === 'ready') {
    visitNode(preview.snapshot.document.tree, (node) => {
      if (node.kind === 'link' || node.kind === 'image') {
        links.push(Object.freeze({ destination: node.destination, sourceSpan: node.destinationSpan ?? node.span }));
      } else if (node.kind === 'listItem' && node.task !== null) {
        taskStates.push(node.task.checked);
      } else if (node.kind === 'frontMatter' && node.value?.kind === 'mapping') {
        for (const entry of node.value.entries) {
          const value = propertyValue(entry.value);
          if (value !== undefined) properties[entry.key] = value;
        }
      }
    });
  }
  return Object.freeze({
    path: filePath,
    relativePath,
    size,
    modifiedMilliseconds,
    contentHash: contentHash(source),
    headings: Object.freeze(headings),
    links: Object.freeze(links),
    properties: Object.freeze(properties),
    taskStates: Object.freeze(taskStates),
    tags: Object.freeze(tags),
    citationKeys: Object.freeze(citationKeys),
    searchableText: source
  });
}

function assetExtension(relativePath: string): boolean {
  return ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.ppm'].includes(path.extname(relativePath).toLowerCase());
}

function visitNode(node: MarkdownNode, visit: (node: MarkdownNode) => void): void {
  visit(node);
  switch (node.kind) {
    case 'document':
    case 'paragraph':
    case 'heading':
    case 'blockQuote':
    case 'callout':
    case 'listItem':
    case 'footnoteDefinition':
    case 'emphasis':
    case 'strong':
    case 'strikethrough':
    case 'link':
    case 'image':
      for (const child of node.children) visitNode(child, visit);
      break;
    case 'list':
      for (const item of node.items) visitNode(item, visit);
      break;
    case 'table':
      visitNode(node.header, visit);
      for (const row of node.rows) visitNode(row, visit);
      break;
    case 'tableRow':
      for (const cell of node.cells) visitNode(cell, visit);
      break;
    case 'tableCell':
      for (const child of node.children) visitNode(child, visit);
      break;
    default:
      break;
  }
}

function propertyValue(value: MarkdownFrontMatterValue): string | number | boolean | readonly string[] | undefined {
  if (value.kind === 'scalar') return value.value === null ? '' : value.value;
  if (value.kind === 'sequence') {
    const values = value.items.flatMap((item) => (
      item.kind === 'scalar' && item.value !== null ? [String(item.value)] : []
    ));
    return values.length === value.items.length ? Object.freeze(values) : undefined;
  }
  return undefined;
}

function flattenOutline(entries: ReturnType<typeof extractMarkdownOutline>): ReturnType<typeof extractMarkdownOutline> {
  return entries.flatMap((entry) => [entry, ...flattenOutline(entry.children)]);
}

async function readIgnoreRules(
  directory: string,
  base: string,
  inherited: readonly IgnoreLayer[]
): Promise<readonly IgnoreLayer[]> {
  const sources: string[] = [];
  for (const name of ['.gitignore', '.ignore']) {
    let source: string;
    try {
      source = await readFile(path.join(directory, name), 'utf8');
    } catch (error) {
      if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    sources.push(source);
  }
  return sources.length === 0
    ? inherited
    : Object.freeze([...inherited, ignoreLayer(base, sources.join('\n'))]);
}

async function ignoreRulesForPath(
  root: string,
  directory: string,
  exclusionPatterns: readonly string[]
): Promise<readonly IgnoreLayer[]> {
  let rules: readonly IgnoreLayer[] = exclusionPatterns.length === 0
    ? Object.freeze([])
    : Object.freeze([ignoreLayer('', exclusionPatterns.join('\n'))]);
  let current = root;
  rules = await readIgnoreRules(current, '', rules);
  const relative = normalizedRelative(root, directory);
  if (relative === '') return rules;
  for (const segment of relative.split('/')) {
    current = path.join(current, segment);
    rules = await readIgnoreRules(current, normalizedRelative(root, current), rules);
  }
  return rules;
}

function ignoreLayer(base: string, source: string): IgnoreLayer {
  return Object.freeze({
    base,
    matcher: ignore().add(source),
    hasNegation: source.split(/\r?\n/u).some((line) => /^\s*![^!]/u.test(line))
  });
}

function pathIgnored(relativePath: string, directory: boolean, rules: readonly IgnoreLayer[]): boolean {
  let ignored = false;
  for (const rule of rules) {
    if (rule.base.length > 0 && relativePath !== rule.base && !relativePath.startsWith(`${rule.base}/`)) continue;
    const local = rule.base.length === 0 ? relativePath : relativePath.slice(rule.base.length + 1);
    if (local.length === 0) continue;
    const result = rule.matcher.test(directory ? `${local}/` : local);
    if (result.ignored) ignored = true;
    else if (result.unignored) ignored = false;
  }
  return ignored;
}

function supportedDocument(relativePath: string, settings: ProjectIndexSettings): boolean {
  const extension = path.extname(relativePath).toLowerCase();
  if (!settings.extensions.includes(extension)) return false;
  if (settings.includePatterns.length === 0) return true;
  return settings.includePatterns.some((pattern) => minimatch(relativePath, pattern, {
    dot: true,
    matchBase: !pattern.includes('/'),
    nocase: process.platform === 'win32'
  }));
}

function resolveSettings(value: Partial<ProjectIndexSettings>): ProjectIndexSettings {
  return Object.freeze({
    extensions: Object.freeze([...(value.extensions ?? defaultProjectIndexSettings.extensions)].map((item) => item.toLowerCase())),
    maximumFileBytes: value.maximumFileBytes ?? defaultProjectIndexSettings.maximumFileBytes,
    includePatterns: Object.freeze([...(value.includePatterns ?? defaultProjectIndexSettings.includePatterns)]),
    excludePatterns: Object.freeze([...(value.excludePatterns ?? defaultProjectIndexSettings.excludePatterns)]),
    symlinkFiles: value.symlinkFiles ?? defaultProjectIndexSettings.symlinkFiles
  });
}

function normalizedRelative(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join('/');
}

function contentHash(source: string): string {
  return createHash('sha256').update(source).digest('hex');
}

function decodeUtf8Source(bytes: Uint8Array): string {
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  return new TextDecoder('utf-8', { fatal: true }).decode(bom ? bytes.subarray(3) : bytes);
}

function pathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function lstatIfPresent(filePath: string): Promise<Stats | undefined> {
  try {
    return await lstat(filePath);
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function statIfPresent(filePath: string): Promise<Stats | undefined> {
  try {
    return await stat(filePath);
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
