import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isThemeColorToken, themeColor } from '@ismail-elkorchi/terminal-ui/theme';
import type { TerminalColor, TerminalStyle } from '@ismail-elkorchi/terminal-ui/renderer';
import type { MarkdownCalloutKind, MarkdownDiagnosticSeverity } from 'markspan';
import { defaultVellumConfigurationDirectory } from '../config/paths.js';

export interface MarkdownTheme {
  readonly body: TerminalStyle;
  readonly headings: readonly [TerminalStyle, TerminalStyle, TerminalStyle, TerminalStyle, TerminalStyle, TerminalStyle];
  readonly strong: TerminalStyle;
  readonly emphasis: TerminalStyle;
  readonly deleted: TerminalStyle;
  readonly inlineCode: TerminalStyle;
  readonly codeBlock: TerminalStyle;
  readonly codeLanguageLabel: TerminalStyle;
  readonly link: TerminalStyle;
  readonly blockquote: TerminalStyle;
  readonly listMarker: TerminalStyle;
  readonly checkedTask: TerminalStyle;
  readonly uncheckedTask: TerminalStyle;
  readonly tableBorder: TerminalStyle;
  readonly tableHeader: TerminalStyle;
  readonly imageLabel: TerminalStyle;
  readonly htmlPlaceholder: TerminalStyle;
  readonly frontMatter: TerminalStyle;
  readonly callouts: Readonly<Record<MarkdownCalloutKind, TerminalStyle>>;
  readonly math: TerminalStyle;
  readonly diagramFailure: TerminalStyle;
  readonly diagnostics: Readonly<Record<MarkdownDiagnosticSeverity, TerminalStyle>>;
}

export interface MarkdownThemeDiagnostic {
  readonly key: string;
  readonly message: string;
}

const headings = (accent: TerminalStyle, strong: TerminalStyle): MarkdownTheme['headings'] => Object.freeze([
  Object.freeze({ ...accent, bold: true }),
  Object.freeze({ ...strong, bold: true }),
  Object.freeze({ ...accent, bold: true }),
  Object.freeze({ ...strong, bold: true }),
  Object.freeze({ ...strong, italic: true }),
  Object.freeze({ ...strong, italic: true, dim: true })
]);

function builtIn(kind: 'dark' | 'light'): MarkdownTheme {
  const body = Object.freeze({ fg: themeColor('text.default') });
  const strong = Object.freeze({ fg: themeColor('text.strong') });
  const accent = Object.freeze({ fg: themeColor('accent.primary') });
  const inset = Object.freeze({ fg: themeColor('text.default'), bg: themeColor('surface.inset.background') });
  const muted = Object.freeze({ fg: themeColor('text.muted'), dim: true });
  const warning = Object.freeze({ fg: themeColor('status.warning'), bold: true });
  const error = Object.freeze({ fg: themeColor('status.error'), bold: true });
  return Object.freeze({
    body,
    headings: headings(accent, strong),
    strong: Object.freeze({ bold: true }),
    emphasis: Object.freeze({ italic: true }),
    deleted: Object.freeze({ strikethrough: true }),
    inlineCode: Object.freeze({ ...inset, fg: themeColor('accent.primary') }),
    codeBlock: inset,
    codeLanguageLabel: Object.freeze({ ...accent, bold: true, bg: themeColor('surface.bar.background') }),
    link: Object.freeze({ fg: themeColor('link.foreground'), underline: true }),
    blockquote: muted,
    listMarker: accent,
    checkedTask: Object.freeze({ fg: themeColor('status.success'), bold: true }),
    uncheckedTask: muted,
    tableBorder: muted,
    tableHeader: Object.freeze({ fg: themeColor('table.header'), bold: true }),
    imageLabel: Object.freeze({ ...accent, italic: true }),
    htmlPlaceholder: Object.freeze({ ...muted, bg: themeColor('surface.inset.background') }),
    frontMatter: Object.freeze({ ...muted, ...(kind === 'light' ? { italic: true } : {}) }),
    callouts: Object.freeze({
      note: Object.freeze({ fg: themeColor('status.info'), bold: true }),
      tip: Object.freeze({ fg: themeColor('status.success'), bold: true }),
      important: Object.freeze({ ...accent, bold: true }),
      warning,
      caution: error
    }),
    math: Object.freeze({ ...accent, italic: true }),
    diagramFailure: error,
    diagnostics: Object.freeze({ info: accent, warning, error })
  });
}

export const darkTerminalMarkdownTheme = builtIn('dark');
export const lightTerminalMarkdownTheme = builtIn('light');

export function defaultUserMarkdownThemePath(platform: NodeJS.Platform = process.platform): string {
  return path.join(defaultVellumConfigurationDirectory(platform), 'markdown-theme.json');
}

export async function loadUserMarkdownTheme(
  filePath = defaultUserMarkdownThemePath(),
  base: MarkdownTheme = darkTerminalMarkdownTheme
): Promise<{ readonly theme: MarkdownTheme; readonly diagnostics: readonly MarkdownThemeDiagnostic[] }> {
  let source: string;
  try {
    source = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return Object.freeze({ theme: base, diagnostics: Object.freeze([]) });
    }
    return Object.freeze({
      theme: base,
      diagnostics: Object.freeze([{
        key: '',
        message: `Markdown theme could not be loaded: ${error instanceof Error ? error.message : String(error)}`
      }])
    });
  }
  try {
    return validateMarkdownTheme(JSON.parse(source) as unknown, base);
  } catch (error) {
    return Object.freeze({
      theme: base,
      diagnostics: Object.freeze([{
        key: '',
        message: `Markdown theme JSON is invalid: ${error instanceof Error ? error.message : String(error)}`
      }])
    });
  }
}

const themeKeys = new Set(Object.keys(darkTerminalMarkdownTheme));
const styleKeys = new Set(['fg', 'bg', 'bold', 'dim', 'italic', 'underline', 'inverse', 'hidden', 'strikethrough']);

export function validateMarkdownTheme(
  value: unknown,
  base: MarkdownTheme = darkTerminalMarkdownTheme
): { readonly theme: MarkdownTheme; readonly diagnostics: readonly MarkdownThemeDiagnostic[] } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return Object.freeze({
      theme: base,
      diagnostics: Object.freeze([{ key: '', message: 'A Markdown theme must be an object.' }])
    });
  }
  const diagnostics: MarkdownThemeDiagnostic[] = [];
  const supplied = value as Record<string, unknown>;
  for (const key of Object.keys(supplied)) {
    if (!themeKeys.has(key)) diagnostics.push(Object.freeze({ key, message: `Unknown Markdown theme key: ${key}` }));
  }
  const scalarKeys = [...themeKeys].filter((key) => !['headings', 'callouts', 'diagnostics'].includes(key));
  const merged: Record<string, unknown> = { ...base };
  for (const key of scalarKeys) {
    if (supplied[key] !== undefined) merged[key] = styleValue(supplied[key], base[key as keyof MarkdownTheme] as TerminalStyle, key, diagnostics);
  }
  if (supplied['headings'] !== undefined) {
    if (!Array.isArray(supplied['headings']) || supplied['headings'].length !== 6) {
      diagnostics.push(Object.freeze({ key: 'headings', message: 'Markdown theme headings must contain six styles.' }));
    } else {
      merged['headings'] = Object.freeze(supplied['headings'].map((style, index) => (
        styleValue(style, base.headings[index] ?? base.body, `headings.${String(index + 1)}`, diagnostics)
      ))) as MarkdownTheme['headings'];
    }
  }
  merged['callouts'] = nestedStyles(supplied['callouts'], base.callouts, 'callouts', diagnostics);
  merged['diagnostics'] = nestedStyles(supplied['diagnostics'], base.diagnostics, 'diagnostics', diagnostics);
  return Object.freeze({
    theme: Object.freeze(merged) as unknown as MarkdownTheme,
    diagnostics: Object.freeze(diagnostics)
  });
}

function nestedStyles<TKey extends string>(
  supplied: unknown,
  base: Readonly<Record<TKey, TerminalStyle>>,
  owner: string,
  diagnostics: MarkdownThemeDiagnostic[]
): Readonly<Record<TKey, TerminalStyle>> {
  if (supplied === undefined) return base;
  if (supplied === null || typeof supplied !== 'object' || Array.isArray(supplied)) {
    diagnostics.push(Object.freeze({ key: owner, message: `Markdown theme ${owner} must be an object.` }));
    return base;
  }
  const values = supplied as Record<string, unknown>;
  for (const key of Object.keys(values)) {
    if (!(key in base)) diagnostics.push(Object.freeze({ key: `${owner}.${key}`, message: `Unknown Markdown theme key: ${owner}.${key}` }));
  }
  return Object.freeze(Object.fromEntries(Object.entries(base).map(([key, style]) => [
    key,
    values[key] === undefined
      ? style as TerminalStyle
      : styleValue(values[key], style as TerminalStyle, `${owner}.${key}`, diagnostics)
  ]))) as Readonly<Record<TKey, TerminalStyle>>;
}

function styleValue(
  value: unknown,
  base: TerminalStyle,
  key: string,
  diagnostics: MarkdownThemeDiagnostic[]
): TerminalStyle {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    diagnostics.push(Object.freeze({ key, message: `Markdown theme ${key} must be a terminal style object.` }));
    return base;
  }
  const record = value as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...base };
  for (const unsupported of Object.keys(record).filter((candidate) => !styleKeys.has(candidate))) {
    diagnostics.push(Object.freeze({ key: `${key}.${unsupported}`, message: `Unknown terminal style key: ${unsupported}` }));
  }
  for (const flag of ['bold', 'dim', 'italic', 'underline', 'inverse', 'hidden', 'strikethrough']) {
    const supplied = record[flag];
    if (supplied !== undefined && typeof supplied !== 'boolean') {
      diagnostics.push(Object.freeze({ key: `${key}.${flag}`, message: `Markdown theme ${key}.${flag} must be boolean.` }));
    } else if (supplied !== undefined) merged[flag] = supplied;
  }
  const foreground = styleColor(record['fg'], base.fg, `${key}.fg`, diagnostics);
  const background = styleColor(record['bg'], base.bg, `${key}.bg`, diagnostics);
  if (foreground === undefined) delete merged['fg'];
  else merged['fg'] = foreground;
  if (background === undefined) delete merged['bg'];
  else merged['bg'] = background;
  return Object.freeze(merged) as TerminalStyle;
}

function styleColor(
  value: unknown,
  base: TerminalColor | undefined,
  key: string,
  diagnostics: MarkdownThemeDiagnostic[]
): TerminalColor | undefined {
  if (value === undefined) return base;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    diagnostics.push(Object.freeze({ key, message: `Markdown theme ${key} must be a terminal color object.` }));
    return base;
  }
  const color = value as Record<string, unknown>;
  const kind = color['kind'];
  const fields = kind === 'default' ? ['kind']
    : kind === 'ansi' ? ['kind', 'value']
      : kind === 'rgb' ? ['kind', 'r', 'g', 'b']
        : kind === 'theme' ? ['kind', 'token'] : [];
  if (fields.length === 0 || Object.keys(color).some((field) => !fields.includes(field))) {
    diagnostics.push(Object.freeze({ key, message: `Markdown theme ${key} contains an invalid terminal color.` }));
    return base;
  }
  if (kind === 'default') return Object.freeze({ kind });
  if (kind === 'ansi' && byte(color['value'])) return Object.freeze({ kind, value: color['value'] });
  if (kind === 'rgb' && byte(color['r']) && byte(color['g']) && byte(color['b'])) {
    return Object.freeze({ kind, r: color['r'], g: color['g'], b: color['b'] });
  }
  if (kind === 'theme' && isThemeColorToken(color['token'])) return themeColor(color['token']);
  diagnostics.push(Object.freeze({ key, message: `Markdown theme ${key} contains an invalid terminal color.` }));
  return base;
}

function byte(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 255;
}
