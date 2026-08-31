import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { defaultVellumConfigurationDirectory } from '../config/paths.js';

export interface ExportFormat {
  readonly name: string;
  readonly extensions: readonly string[];
}

export type ExportMetadataValue = string | number | boolean | readonly string[];

export interface ExportProfile {
  readonly id: string;
  readonly label: string;
  readonly reader: ExportFormat;
  readonly writer: ExportFormat;
  readonly outputExtension: string;
  readonly executable: string;
  readonly standalone: boolean;
  readonly arguments: readonly string[];
  readonly template?: string;
  readonly stylesheets: readonly string[];
  readonly filters: readonly string[];
  readonly bibliography: readonly string[];
  readonly csl?: string;
  readonly metadata: Readonly<Record<string, ExportMetadataValue>>;
  readonly resourcePaths: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly outputName: string;
  readonly postExport: 'none' | 'open';
}

export const builtInExportProfiles: readonly ExportProfile[] = Object.freeze([
  profile('html', 'HTML', 'html5', '.html'),
  profile('pdf', 'PDF', 'pdf', '.pdf'),
  profile('docx', 'DOCX', 'docx', '.docx'),
  profile('epub', 'EPUB', 'epub3', '.epub')
]);

export interface ExportProfileDiagnostic {
  readonly profileId: string;
  readonly message: string;
}

export interface LoadedExportProfiles {
  readonly profiles: readonly ExportProfile[];
  readonly diagnostics: readonly ExportProfileDiagnostic[];
}

export async function loadUserExportProfiles(
  filePath = path.join(defaultVellumConfigurationDirectory(), 'export-profiles.json')
): Promise<LoadedExportProfiles> {
  let source: string;
  try {
    source = await readFile(filePath, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) return Object.freeze({ profiles: Object.freeze([]), diagnostics: Object.freeze([]) });
    return Object.freeze({
      profiles: Object.freeze([]),
      diagnostics: Object.freeze([errorDiagnostic('configuration', error instanceof Error ? error.message : String(error))])
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    return Object.freeze({
      profiles: Object.freeze([]),
      diagnostics: Object.freeze([errorDiagnostic('configuration', `Export profile JSON is invalid: ${error instanceof Error ? error.message : String(error)}`)])
    });
  }
  if (!Array.isArray(parsed)) {
    return Object.freeze({
      profiles: Object.freeze([]),
      diagnostics: Object.freeze([errorDiagnostic('configuration', 'Export profile configuration must be an array.')])
    });
  }
  const profiles: ExportProfile[] = [];
  const diagnostics: ExportProfileDiagnostic[] = [];
  for (let index = 0; index < parsed.length; index += 1) {
    const decoded = decodeProfile(parsed[index], index);
    if ('diagnostic' in decoded) diagnostics.push(decoded.diagnostic);
    else profiles.push(decoded.profile);
  }
  diagnostics.push(...validateExportProfiles([...builtInExportProfiles, ...profiles]));
  return Object.freeze({ profiles: Object.freeze(profiles), diagnostics: Object.freeze(diagnostics) });
}

export function validateExportProfiles(values: readonly ExportProfile[]): readonly ExportProfileDiagnostic[] {
  const diagnostics: ExportProfileDiagnostic[] = [];
  const ids = new Set<string>();
  for (const value of values) {
    if (!/^[a-z][a-z0-9-]*$/u.test(value.id)) diagnostics.push(error(value.id, 'Export profile identifier is invalid.'));
    if (ids.has(value.id)) diagnostics.push(error(value.id, 'Export profile identifier is duplicated.'));
    ids.add(value.id);
    if (value.label.trim().length === 0) diagnostics.push(error(value.id, 'Export profile label is empty.'));
    validateFormat(value.id, 'reader', value.reader, diagnostics);
    validateFormat(value.id, 'writer', value.writer, diagnostics);
    if (!/^\.[A-Za-z0-9]+$/u.test(value.outputExtension)) diagnostics.push(error(value.id, 'Export output extension is invalid.'));
    if (value.executable.trim().length === 0) diagnostics.push(error(value.id, 'Export executable is empty.'));
    if (value.outputName.trim().length === 0 || !value.outputName.includes('{name}')) diagnostics.push(error(value.id, 'Export outputName must contain {name}.'));
    for (const text of [
      value.executable,
      value.outputName,
      ...value.arguments,
      ...value.stylesheets,
      ...value.filters,
      ...value.bibliography,
      ...value.resourcePaths,
      ...Object.keys(value.metadata),
      ...Object.values(value.environment),
      ...(value.template === undefined ? [] : [value.template]),
      ...(value.csl === undefined ? [] : [value.csl])
    ]) {
      if (text.includes('\0')) diagnostics.push(error(value.id, 'Export profile text contains a null character.'));
    }
  }
  return Object.freeze(diagnostics);
}

export function exportOutputPath(sourcePath: string, profile: ExportProfile, date = new Date()): string {
  const parsed = path.parse(sourcePath);
  const name = profile.outputName
    .replaceAll('{name}', parsed.name)
    .replaceAll('{profile}', profile.id)
    .replaceAll('{date}', date.toISOString().slice(0, 10));
  if (path.basename(name) !== name) throw new Error(`Export outputName must not contain a directory: ${profile.outputName}`);
  return path.join(parsed.dir, name + profile.outputExtension);
}

export function pandocFormat(format: ExportFormat): string {
  return `${format.name}${format.extensions.map((extension) => `${extension.startsWith('-') ? '' : '+'}${extension}`).join('')}`;
}

function profile(id: string, label: string, writer: string, outputExtension: string): ExportProfile {
  return Object.freeze({
    id,
    label,
    reader: Object.freeze({
      name: 'markdown',
      extensions: Object.freeze(['yaml_metadata_block', 'pipe_tables', 'task_lists', 'footnotes', 'tex_math_dollars', 'strikeout', 'autolink_bare_uris'])
    }),
    writer: Object.freeze({ name: writer, extensions: Object.freeze([]) }),
    outputExtension,
    executable: 'pandoc',
    standalone: true,
    arguments: Object.freeze([]),
    stylesheets: Object.freeze([]),
    filters: Object.freeze([]),
    bibliography: Object.freeze([]),
    metadata: Object.freeze({}),
    resourcePaths: Object.freeze([]),
    environment: Object.freeze({}),
    outputName: '{name}',
    postExport: 'none'
  });
}

function validateFormat(profileId: string, label: string, format: ExportFormat, diagnostics: ExportProfileDiagnostic[]): void {
  if (!/^[A-Za-z0-9_-]+$/u.test(format.name)) diagnostics.push(error(profileId, `Export ${label} name is invalid.`));
  for (const extension of format.extensions) {
    if (!/^-?[A-Za-z0-9_]+$/u.test(extension)) diagnostics.push(error(profileId, `Export ${label} extension is invalid: ${extension}`));
  }
}

function error(profileId: string, message: string): ExportProfileDiagnostic {
  return Object.freeze({ profileId, message });
}

function decodeProfile(value: unknown, index: number): { readonly profile: ExportProfile } | { readonly diagnostic: ExportProfileDiagnostic } {
  const profileId = `entry-${String(index + 1)}`;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { diagnostic: errorDiagnostic(profileId, 'Export profile entry must be an object.') };
  const record = value as Readonly<Record<string, unknown>>;
  const allowed = new Set([
    'id', 'label', 'reader', 'writer', 'outputExtension', 'executable', 'standalone', 'arguments', 'template',
    'stylesheets', 'filters', 'bibliography', 'csl', 'metadata', 'resourcePaths', 'environment', 'outputName', 'postExport'
  ]);
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  if (unknown.length > 0) return { diagnostic: errorDiagnostic(profileId, `Unknown export profile fields: ${unknown.join(', ')}.`) };
  for (const key of ['id', 'label', 'outputExtension', 'executable', 'outputName'] as const) {
    if (typeof record[key] !== 'string') return { diagnostic: errorDiagnostic(profileId, `Export profile ${key} must be a string.`) };
  }
  if (typeof record['standalone'] !== 'boolean' || (record['postExport'] !== 'none' && record['postExport'] !== 'open')) {
    return { diagnostic: errorDiagnostic(profileId, 'Export profile standalone and postExport fields are invalid.') };
  }
  const reader = decodeFormat(record['reader']);
  const writer = decodeFormat(record['writer']);
  if (reader === undefined || writer === undefined) return { diagnostic: errorDiagnostic(profileId, 'Export reader and writer must contain a name and extensions array.') };
  for (const key of ['arguments', 'stylesheets', 'filters', 'bibliography', 'resourcePaths'] as const) {
    if (!isStringArray(record[key])) return { diagnostic: errorDiagnostic(profileId, `Export profile ${key} must be a string array.`) };
  }
  if (record['template'] !== undefined && typeof record['template'] !== 'string') return { diagnostic: errorDiagnostic(profileId, 'Export template must be a string.') };
  if (record['csl'] !== undefined && typeof record['csl'] !== 'string') return { diagnostic: errorDiagnostic(profileId, 'Export csl must be a string.') };
  const metadata = decodeMetadata(record['metadata']);
  const environment = decodeStringRecord(record['environment']);
  if (metadata === undefined || environment === undefined) return { diagnostic: errorDiagnostic(profileId, 'Export metadata or environment is invalid.') };
  return { profile: Object.freeze({
    id: record['id'] as string,
    label: record['label'] as string,
    reader,
    writer,
    outputExtension: record['outputExtension'] as string,
    executable: record['executable'] as string,
    standalone: record['standalone'] as boolean,
    arguments: Object.freeze([...(record['arguments'] as readonly string[])]),
    ...(record['template'] === undefined ? {} : { template: record['template'] as string }),
    stylesheets: Object.freeze([...(record['stylesheets'] as readonly string[])]),
    filters: Object.freeze([...(record['filters'] as readonly string[])]),
    bibliography: Object.freeze([...(record['bibliography'] as readonly string[])]),
    ...(record['csl'] === undefined ? {} : { csl: record['csl'] as string }),
    metadata,
    resourcePaths: Object.freeze([...(record['resourcePaths'] as readonly string[])]),
    environment,
    outputName: record['outputName'] as string,
    postExport: record['postExport'] as 'none' | 'open'
  }) };
}

function decodeFormat(value: unknown): ExportFormat | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Readonly<Record<string, unknown>>;
  return typeof record['name'] === 'string' && isStringArray(record['extensions'])
    ? Object.freeze({ name: record['name'], extensions: Object.freeze([...record['extensions']]) })
    : undefined;
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

function decodeStringRecord(value: unknown): Readonly<Record<string, string>> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return Object.values(value).every((item) => typeof item === 'string')
    ? Object.freeze({ ...(value as Record<string, string>) })
    : undefined;
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function errorDiagnostic(profileId: string, message: string): ExportProfileDiagnostic {
  return Object.freeze({ profileId, message });
}
