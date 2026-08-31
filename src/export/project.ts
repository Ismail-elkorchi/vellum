import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ExportMetadataValue, ExportProfile } from './profiles.js';
import { exportOutputPath } from './profiles.js';
import { assertProjectPathContained } from '../files/project-operations.js';
import {
  exportDocument,
  type BufferDocumentSource,
  type CombinedProjectDocumentSource,
  type DiskDocumentSource,
  type ExportOptions,
  type ExportResult
} from './exporter.js';

export interface ProjectExportSelection {
  readonly profileId: string;
  readonly template?: string;
}

export interface VellumProjectManifest {
  readonly version: 1;
  readonly title: string;
  readonly files: readonly string[];
  readonly profiles: readonly ProjectExportSelection[];
  readonly metadata: Readonly<Record<string, ExportMetadataValue>>;
  readonly bibliography: readonly string[];
  readonly csl?: string;
  readonly resourcePaths: readonly string[];
  readonly coverImage?: string;
  readonly outputDirectory: string;
}

export interface ProjectExportProgress {
  readonly completed: number;
  readonly total: number;
  readonly profileId: string;
}

export async function loadProjectManifest(
  rootDirectory: string,
  manifestPath = path.join(rootDirectory, '.vellum', 'project.json')
): Promise<VellumProjectManifest> {
  const parsed = JSON.parse(await readFile(manifestPath, 'utf8')) as unknown;
  const manifest = decodeManifest(parsed);
  await validateManifestPaths(path.resolve(rootDirectory), manifest);
  return manifest;
}

export async function exportProjectManifest(
  rootDirectory: string,
  manifest: VellumProjectManifest,
  profiles: readonly ExportProfile[],
  liveSources: ReadonlyMap<string, { readonly source: string; readonly unsaved: boolean }> = new Map(),
  options: Omit<ExportOptions, 'outputPath'> = {},
  onProgress?: (progress: ProjectExportProgress) => void
): Promise<readonly ExportResult[]> {
  const root = path.resolve(rootDirectory);
  await validateManifestPaths(root, manifest);
  const byId = new Map(profiles.map((profile) => [profile.id, profile]));
  const documents: Array<DiskDocumentSource | BufferDocumentSource> = manifest.files.map((relativePath) => {
    const absolutePath = resolveBelow(root, relativePath, 'project file');
    const live = liveSources.get(absolutePath);
    return live === undefined
      ? Object.freeze({ kind: 'disk' as const, path: absolutePath })
      : Object.freeze({
          kind: 'buffer' as const,
          source: live.source,
          label: path.basename(absolutePath),
          baseDirectory: path.dirname(absolutePath),
          path: absolutePath,
          unsaved: live.unsaved
        });
  });
  const results: ExportResult[] = [];
  for (let index = 0; index < manifest.profiles.length; index += 1) {
    options.signal?.throwIfAborted();
    const selection = manifest.profiles[index];
    if (selection === undefined) continue;
    const configured = byId.get(selection.profileId);
    if (configured === undefined) throw new Error(`Project manifest references an unknown export profile: ${selection.profileId}`);
    const profile: ExportProfile = selection.template === undefined
      ? configured
      : Object.freeze({ ...configured, template: selection.template });
    const outputDirectory = resolveBelow(root, manifest.outputDirectory, 'output directory', true);
    const outputPath = exportOutputPath(path.join(outputDirectory, `${safeTitle(manifest.title)}.md`), profile);
    const document: CombinedProjectDocumentSource = Object.freeze({
      kind: 'combinedProject',
      title: manifest.title,
      rootDirectory: root,
      documents: Object.freeze(documents),
      metadata: Object.freeze({
        ...manifest.metadata,
        title: manifest.title,
        ...(manifest.coverImage === undefined ? {} : { cover: manifest.coverImage })
      }),
      resourcePaths: manifest.resourcePaths,
      bibliography: manifest.bibliography,
      ...(manifest.csl === undefined ? {} : { csl: manifest.csl }),
      outputPath
    });
    onProgress?.(Object.freeze({ completed: index, total: manifest.profiles.length, profileId: profile.id }));
    results.push(await exportDocument(document, profile, options));
    onProgress?.(Object.freeze({ completed: index + 1, total: manifest.profiles.length, profileId: profile.id }));
  }
  return Object.freeze(results);
}

function decodeManifest(value: unknown): VellumProjectManifest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Vellum project manifest must be an object.');
  const record = value as Readonly<Record<string, unknown>>;
  const allowed = new Set(['version', 'title', 'files', 'profiles', 'metadata', 'bibliography', 'csl', 'resourcePaths', 'coverImage', 'outputDirectory']);
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`Unknown Vellum project manifest fields: ${unknown.join(', ')}.`);
  if (record['version'] !== 1) throw new Error('Unsupported Vellum project manifest version.');
  if (typeof record['title'] !== 'string' || record['title'].trim().length === 0) throw new Error('Project title is required.');
  if (!isStringArray(record['files']) || record['files'].length === 0) throw new Error('Project files must be a nonempty string array.');
  if (!Array.isArray(record['profiles']) || record['profiles'].length === 0) throw new Error('Project profiles must be a nonempty array.');
  const profiles = record['profiles'].map((entry): ProjectExportSelection => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Project profile selection must be an object.');
    const selection = entry as Readonly<Record<string, unknown>>;
    const unknownSelectionFields = Object.keys(selection).filter((key) => key !== 'profileId' && key !== 'template');
    if (unknownSelectionFields.length > 0) throw new Error(`Unknown project profile fields: ${unknownSelectionFields.join(', ')}.`);
    if (typeof selection['profileId'] !== 'string' || (selection['template'] !== undefined && typeof selection['template'] !== 'string')) {
      throw new Error('Project profile selection requires profileId and an optional template.');
    }
    return Object.freeze({
      profileId: selection['profileId'],
      ...(selection['template'] === undefined ? {} : { template: selection['template'] as string })
    });
  });
  const metadata = decodeMetadata(record['metadata']);
  if (metadata === undefined) throw new Error('Project metadata is invalid.');
  if (!isStringArray(record['bibliography']) || !isStringArray(record['resourcePaths'])) throw new Error('Project bibliography and resourcePaths must be string arrays.');
  if (record['csl'] !== undefined && typeof record['csl'] !== 'string') throw new Error('Project csl must be a string.');
  if (record['coverImage'] !== undefined && typeof record['coverImage'] !== 'string') throw new Error('Project coverImage must be a string.');
  if (typeof record['outputDirectory'] !== 'string' || record['outputDirectory'].length === 0) throw new Error('Project outputDirectory is required.');
  return Object.freeze({
    version: 1,
    title: record['title'],
    files: Object.freeze([...record['files']]),
    profiles: Object.freeze(profiles),
    metadata,
    bibliography: Object.freeze([...record['bibliography']]),
    ...(record['csl'] === undefined ? {} : { csl: record['csl'] as string }),
    resourcePaths: Object.freeze([...record['resourcePaths']]),
    ...(record['coverImage'] === undefined ? {} : { coverImage: record['coverImage'] as string }),
    outputDirectory: record['outputDirectory']
  });
}

async function validateManifestPaths(root: string, manifest: VellumProjectManifest): Promise<void> {
  const seen = new Set<string>();
  for (const relativePath of manifest.files) {
    const absolutePath = resolveBelow(root, relativePath, 'project file');
    if (seen.has(absolutePath)) throw new Error(`Project file is duplicated: ${relativePath}`);
    seen.add(absolutePath);
    if (!/\.(?:md|markdown|mdown|mkd)$/iu.test(absolutePath)) throw new Error(`Project file is not Markdown: ${relativePath}`);
    await assertProjectPathContained(root, absolutePath);
    if (!(await stat(absolutePath)).isFile()) throw new Error(`Project path is not a file: ${relativePath}`);
  }
  await assertProjectPathContained(root, resolveBelow(root, manifest.outputDirectory, 'output directory', true));
  for (const resourcePath of manifest.resourcePaths) {
    await assertProjectPathContained(root, resolveBelow(root, resourcePath, 'resource path', true));
  }
  for (const bibliography of manifest.bibliography) {
    await assertProjectPathContained(root, resolveBelow(root, bibliography, 'bibliography'));
  }
  if (manifest.csl !== undefined) await assertProjectPathContained(root, resolveBelow(root, manifest.csl, 'CSL file'));
  if (manifest.coverImage !== undefined) await assertProjectPathContained(root, resolveBelow(root, manifest.coverImage, 'cover image'));
  for (const selection of manifest.profiles) {
    if (selection.template !== undefined) await assertProjectPathContained(root, resolveBelow(root, selection.template, 'template'));
  }
}

function resolveBelow(root: string, requested: string, label: string, allowRoot = false): string {
  if (requested.length === 0 || path.isAbsolute(requested)) throw new Error(`The ${label} must be project-relative: ${requested}`);
  const resolved = path.resolve(root, requested);
  const relative = path.relative(root, resolved);
  if ((!allowRoot && relative === '') || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`The ${label} must remain inside the project: ${requested}`);
  }
  return resolved;
}

function decodeMetadata(value: unknown): Readonly<Record<string, ExportMetadataValue>> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const result: Record<string, ExportMetadataValue> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean' || isStringArray(item)) result[key] = item;
    else return undefined;
  }
  return Object.freeze(result);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function safeTitle(value: string): string {
  const safe = value.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '-').replace(/\s+/gu, ' ');
  return safe.length === 0 ? 'project' : safe;
}
