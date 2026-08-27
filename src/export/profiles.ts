import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { defaultVellumConfigurationDirectory } from '../config/paths.js';

export interface ExportProfile {
  readonly id: string;
  readonly label: string;
  readonly targetFormat: string;
  readonly outputExtension: string;
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly resourcePaths: readonly string[];
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

export function validateExportProfiles(
  values: readonly ExportProfile[]
): readonly ExportProfileDiagnostic[] {
  const diagnostics: ExportProfileDiagnostic[] = [];
  const ids = new Set<string>();
  for (const value of values) {
    if (!/^[a-z][a-z0-9-]*$/u.test(value.id)) diagnostics.push(error(value.id, 'Export profile identifier is invalid.'));
    if (ids.has(value.id)) diagnostics.push(error(value.id, 'Export profile identifier is duplicated.'));
    ids.add(value.id);
    if (value.label.trim().length === 0) diagnostics.push(error(value.id, 'Export profile label is empty.'));
    if (value.targetFormat.trim().length === 0) diagnostics.push(error(value.id, 'Export target format is empty.'));
    if (!/^\.[A-Za-z0-9]+$/u.test(value.outputExtension)) diagnostics.push(error(value.id, 'Export output extension is invalid.'));
    if (value.executable.trim().length === 0) diagnostics.push(error(value.id, 'Export executable is empty.'));
    if (value.executable.includes('\0')) diagnostics.push(error(value.id, 'Export executable contains a null character.'));
    if (value.targetFormat.includes('\0')) diagnostics.push(error(value.id, 'Export target format contains a null character.'));
    for (const argument of value.arguments) {
      if (argument.includes('\0')) diagnostics.push(error(value.id, 'Export argument contains a null character.'));
    }
    for (const resourcePath of value.resourcePaths) {
      if (resourcePath.includes('\0')) diagnostics.push(error(value.id, 'Export resource path contains a null character.'));
    }
  }
  return Object.freeze(diagnostics);
}

export function exportOutputPath(sourcePath: string, profile: ExportProfile): string {
  const parsed = path.parse(sourcePath);
  return path.join(parsed.dir, parsed.name + profile.outputExtension);
}

function profile(id: string, label: string, targetFormat: string, outputExtension: string): ExportProfile {
  return Object.freeze({
    id,
    label,
    targetFormat,
    outputExtension,
    executable: 'pandoc',
    arguments: Object.freeze([]),
    resourcePaths: Object.freeze([])
  });
}

function error(profileId: string, message: string): ExportProfileDiagnostic {
  return Object.freeze({ profileId, message });
}

function decodeProfile(
  value: unknown,
  index: number
): { readonly profile: ExportProfile } | { readonly diagnostic: ExportProfileDiagnostic } {
  const profileId = `entry-${String(index + 1)}`;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { diagnostic: errorDiagnostic(profileId, 'Export profile entry must be an object.') };
  }
  const record = value as Readonly<Record<string, unknown>>;
  const allowed = new Set(['id', 'label', 'targetFormat', 'outputExtension', 'executable', 'arguments', 'resourcePaths']);
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    return { diagnostic: errorDiagnostic(profileId, `Unknown export profile fields: ${unknown.join(', ')}.`) };
  }
  for (const key of ['id', 'label', 'targetFormat', 'outputExtension', 'executable'] as const) {
    if (typeof record[key] !== 'string') {
      return { diagnostic: errorDiagnostic(profileId, `Export profile ${key} must be a string.`) };
    }
  }
  if (!isStringArray(record['arguments']) || !isStringArray(record['resourcePaths'])) {
    return { diagnostic: errorDiagnostic(profileId, 'Export profile arguments and resourcePaths must be string arrays.') };
  }
  return { profile: Object.freeze({
    id: record['id'] as string,
    label: record['label'] as string,
    targetFormat: record['targetFormat'] as string,
    outputExtension: record['outputExtension'] as string,
    executable: record['executable'] as string,
    arguments: Object.freeze([...record['arguments']]),
    resourcePaths: Object.freeze([...record['resourcePaths']])
  }) };
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
