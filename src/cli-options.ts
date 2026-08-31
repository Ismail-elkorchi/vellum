import type { EditorMode, PaneArrangement } from './app/types.js';

export interface CliOptionDefinition {
  readonly names: readonly string[];
  readonly valueName?: string;
  readonly description: string;
}

export const cliOptionDefinitions: readonly CliOptionDefinition[] = Object.freeze([
  Object.freeze({ names: Object.freeze(['-h', '--help']), description: 'Show command help.' }),
  Object.freeze({ names: Object.freeze(['--line']), valueName: 'number', description: 'Place the caret on a one-based source line.' }),
  Object.freeze({ names: Object.freeze(['--preview']), description: 'Open the preview pane.' }),
  Object.freeze({ names: Object.freeze(['--source']), description: 'Open the source editor.' }),
  Object.freeze({ names: Object.freeze(['--hybrid']), description: 'Open the hybrid editor.' }),
  Object.freeze({ names: Object.freeze(['--profile']), valueName: 'id', description: 'Select an export profile.' }),
  Object.freeze({ names: Object.freeze(['--output']), valueName: 'path', description: 'Write an exported file to this exact path.' }),
  Object.freeze({ names: Object.freeze(['--overwrite']), description: 'Permit replacement of an existing export output.' }),
  Object.freeze({ names: Object.freeze(['--batch']), description: 'Batch-export every Markdown file in a directory.' }),
  Object.freeze({ names: Object.freeze(['--project-manifest']), description: 'Export .vellum/project.json in declared order and profiles.' }),
  Object.freeze({ names: Object.freeze(['--strict-config']), description: 'Treat every configuration diagnostic as fatal.' }),
  Object.freeze({ names: Object.freeze(['--check-keymap']), description: 'Validate the configured keymap and exit.' }),
  Object.freeze({ names: Object.freeze(['--keyboard-report']), description: 'Show normalized terminal key events until interrupted.' })
]);

export interface OpenCliArguments {
  readonly kind: 'open';
  readonly path?: string;
  readonly line?: number;
  readonly editorMode?: EditorMode;
  readonly paneArrangement?: PaneArrangement;
  readonly help: boolean;
  readonly strictConfig?: true;
}

export interface ExportCliArguments {
  readonly kind: 'export';
  readonly path: string;
  readonly profileId: string;
  readonly scope: 'document' | 'batchDirectory' | 'projectManifest';
  readonly outputPath?: string;
  readonly overwrite: boolean;
  readonly help: boolean;
  readonly strictConfig?: true;
}

export interface DiagnosticCliArguments {
  readonly kind: 'checkKeymap' | 'keyboardReport';
  readonly help: boolean;
  readonly strictConfig?: true;
}

export type CliArguments = OpenCliArguments | ExportCliArguments | DiagnosticCliArguments;

export function parseCliArguments(arguments_: readonly string[]): CliArguments {
  const values = [...arguments_];
  const exportMode = values[0] === 'export';
  if (exportMode) values.shift();
  let help = false;
  let line: number | undefined;
  let profileId: string | undefined;
  let outputPath: string | undefined;
  let overwrite = false;
  let strictConfig = false;
  let exportScope: ExportCliArguments['scope'] = 'document';
  let diagnosticMode: DiagnosticCliArguments['kind'] | undefined;
  let editorMode: EditorMode | undefined;
  let paneArrangement: PaneArrangement | undefined;
  let presentationOption: string | undefined;
  const positional: string[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const argument = values[index] as string;
    if (argument === '--') {
      positional.push(...values.slice(index + 1));
      break;
    }
    if (argument === '-h' || argument === '--help') help = true;
    else if (argument === '--overwrite') overwrite = true;
    else if (argument === '--strict-config') strictConfig = true;
    else if (argument === '--batch' || argument === '--project-manifest') {
      if (exportScope !== 'document') throw new Error('Export scope options conflict.');
      exportScope = argument === '--batch' ? 'batchDirectory' : 'projectManifest';
    }
    else if (argument === '--check-keymap' || argument === '--keyboard-report') {
      const requested = argument === '--check-keymap' ? 'checkKeymap' : 'keyboardReport';
      if (diagnosticMode !== undefined) throw new Error('Keyboard diagnostic options conflict.');
      diagnosticMode = requested;
    }
    else if (argument === '--line') {
      const raw = values[++index];
      const parsed = raw === undefined ? Number.NaN : Number(raw);
      if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error('--line requires a positive one-based line number.');
      line = parsed;
    } else if (argument === '--profile') {
      profileId = requiredValue(values[++index], '--profile');
    } else if (argument === '--output') {
      outputPath = requiredValue(values[++index], '--output');
    } else if (argument === '--preview' || argument === '--source' || argument === '--hybrid') {
      if (presentationOption !== undefined) throw new Error(`Presentation options conflict: ${presentationOption} and ${argument}.`);
      presentationOption = argument;
      if (argument === '--preview') paneArrangement = 'preview';
      else {
        paneArrangement = 'editor';
        editorMode = argument === '--hybrid' ? 'hybrid' : 'source';
      }
    } else if (argument.startsWith('-') && argument !== '-') {
      throw new Error(`Unknown option: ${argument}`);
    } else positional.push(argument);
  }
  if (diagnosticMode !== undefined) {
    if (positional.length > 0 || exportMode || line !== undefined || profileId !== undefined || outputPath !== undefined
      || overwrite || presentationOption !== undefined) {
      throw new Error('Keyboard diagnostic options cannot be combined with files, export, or editor options.');
    }
    return Object.freeze({
      kind: diagnosticMode,
      help,
      ...(strictConfig ? { strictConfig: true as const } : {})
    });
  }
  if (exportMode) {
    if (help) return Object.freeze({
      kind: 'export',
      path: positional[0] ?? '',
      profileId: profileId ?? 'manifest',
      scope: exportScope,
      overwrite,
      help
    });
    if (positional.length !== 1) throw new Error('vellum export requires exactly one file or project directory.');
    if (exportScope !== 'projectManifest' && profileId === undefined) throw new Error('Document and batch exports require --profile <id>.');
    if (exportScope === 'projectManifest' && profileId !== undefined) throw new Error('A project manifest declares its own export profiles.');
    if (exportScope !== 'document' && outputPath !== undefined) throw new Error('--output is only valid for one document export.');
    if (line !== undefined || presentationOption !== undefined) throw new Error('Editor options cannot be used with vellum export.');
    return Object.freeze({
      kind: 'export',
      path: positional[0] as string,
      profileId: profileId ?? 'manifest',
      scope: exportScope,
      ...(outputPath === undefined ? {} : { outputPath }),
      overwrite,
      ...(strictConfig ? { strictConfig: true as const } : {}),
      help
    });
  }
  if (profileId !== undefined || outputPath !== undefined || overwrite) throw new Error('Export options require the export command.');
  if (positional.length > 1) throw new Error('vellum accepts at most one file or project directory.');
  return Object.freeze({
    kind: 'open',
    ...(positional[0] === undefined ? {} : { path: positional[0] }),
    ...(line === undefined ? {} : { line }),
    ...(editorMode === undefined ? {} : { editorMode }),
    ...(paneArrangement === undefined ? {} : { paneArrangement }),
    ...(strictConfig ? { strictConfig: true as const } : {}),
    help
  });
}

export function commandHelp(): string {
  const width = Math.max(...cliOptionDefinitions.map((option) => (
    `${option.names.join(', ')}${option.valueName === undefined ? '' : ` <${option.valueName}>`}`.length
  )));
  const options = cliOptionDefinitions.map((option) => {
    const signature = `${option.names.join(', ')}${option.valueName === undefined ? '' : ` <${option.valueName}>`}`;
    return `  ${signature.padEnd(width)}  ${option.description}`;
  }).join('\n');
  return [
    'Vellum — project-aware terminal Markdown editor',
    '',
    'Usage:',
    '  vellum [file-or-project-directory] [options]',
    '  vellum - [--preview|--source|--hybrid]',
    '  vellum export <file> --profile <id> [--output <path>] [--overwrite]',
    '  vellum export <directory> --batch --profile <id> [--overwrite]',
    '  vellum export <project-directory> --project-manifest [--overwrite]',
    '  vellum --check-keymap',
    '  vellum --keyboard-report',
    '',
    'Options:',
    options
  ].join('\n');
}

function requiredValue(value: string | undefined, option: string): string {
  if (value === undefined || value.startsWith('-')) throw new Error(`${option} requires a value.`);
  return value;
}
