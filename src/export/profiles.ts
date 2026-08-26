import path from 'node:path';

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
