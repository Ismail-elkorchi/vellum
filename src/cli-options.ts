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
  Object.freeze({ names: Object.freeze(['--overwrite']), description: 'Permit replacement of an existing export output.' })
]);

export interface OpenCliArguments {
  readonly kind: 'open';
  readonly path?: string;
  readonly line?: number;
  readonly editorMode: EditorMode;
  readonly paneArrangement: PaneArrangement;
  readonly help: boolean;
}

export interface ExportCliArguments {
  readonly kind: 'export';
  readonly path: string;
  readonly profileId: string;
  readonly outputPath?: string;
  readonly overwrite: boolean;
  readonly help: boolean;
}

export type CliArguments = OpenCliArguments | ExportCliArguments;

export function parseCliArguments(arguments_: readonly string[]): CliArguments {
  const values = [...arguments_];
  const exportMode = values[0] === 'export';
  if (exportMode) values.shift();
  let help = false;
  let line: number | undefined;
  let profileId: string | undefined;
  let outputPath: string | undefined;
  let overwrite = false;
  let editorMode: EditorMode = 'source';
  let paneArrangement: PaneArrangement = 'editor';
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
  if (exportMode) {
    if (help) return Object.freeze({ kind: 'export', path: positional[0] ?? '', profileId: profileId ?? '', overwrite, help });
    if (positional.length !== 1) throw new Error('vellum export requires exactly one file or project directory.');
    if (profileId === undefined) throw new Error('vellum export requires --profile <id>.');
    if (line !== undefined || presentationOption !== undefined) throw new Error('Editor options cannot be used with vellum export.');
    return Object.freeze({
      kind: 'export',
      path: positional[0] as string,
      profileId,
      ...(outputPath === undefined ? {} : { outputPath }),
      overwrite,
      help
    });
  }
  if (profileId !== undefined || outputPath !== undefined || overwrite) throw new Error('Export options require the export command.');
  if (positional.length > 1) throw new Error('vellum accepts at most one file or project directory.');
  return Object.freeze({
    kind: 'open',
    ...(positional[0] === undefined ? {} : { path: positional[0] }),
    ...(line === undefined ? {} : { line }),
    editorMode,
    paneArrangement,
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
    '  vellum export <file-or-project-directory> --profile <id> [--output <path>] [--overwrite]',
    '',
    'Options:',
    options
  ].join('\n');
}

function requiredValue(value: string | undefined, option: string): string {
  if (value === undefined || value.startsWith('-')) throw new Error(`${option} requires a value.`);
  return value;
}
