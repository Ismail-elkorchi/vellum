import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type {
  AppState,
  BufferId,
  EditorMode,
  ExportState,
  NavigatorMode,
  PaneArrangement
} from '../app/types.js';
import { defaultVellumStateDirectory } from '../config/paths.js';
import { flushDirectoryMetadata } from '../files/durability.js';

const sessionSchemaVersion = 1;

export interface SessionBufferRecord {
  readonly id: BufferId;
  readonly path?: string;
  readonly label: string;
  readonly cursor: number;
  readonly selection?: { readonly anchor: number; readonly focus: number };
  readonly sourceScroll: { readonly row: number; readonly column: number };
  readonly previewScroll: { readonly row: number; readonly column: number };
}

export interface SessionRecord {
  readonly schemaVersion: 1;
  readonly projectDirectory?: string;
  readonly buffers: readonly SessionBufferRecord[];
  readonly openBufferOrder: readonly BufferId[];
  readonly activeBuffer?: BufferId;
  readonly recentlyOpenedPaths: readonly string[];
  readonly recentProjects: readonly string[];
  readonly pinnedProjects: readonly string[];
  readonly expandedDirectories: readonly string[];
  readonly fileTreeFilter: string;
  readonly fileTreeSort: AppState['project']['fileTree']['sort'];
  readonly editorMode: EditorMode;
  readonly paneArrangement: PaneArrangement;
  readonly splitShares: readonly number[];
  readonly navigator: {
    readonly mode: NavigatorMode;
    readonly visible: boolean;
    readonly width: number;
  };
  readonly writingMode: {
    readonly focus: boolean;
    readonly typewriter: boolean;
    readonly distractionFree: boolean;
    readonly typewriterAnchor: number;
  };
  readonly projectSearch: {
    readonly query: string;
    readonly recentQueries: readonly string[];
  };
  readonly exports: ExportState;
  readonly diagnosticPreferences: AppState['diagnosticPreferences'];
}

export interface SessionStore {
  readonly filePath: string;
  read(): Promise<SessionRecord | undefined>;
  write(state: AppState): Promise<void>;
  diagnostics(): readonly string[];
}

export function createSessionStore(directory = defaultVellumStateDirectory()): SessionStore {
  const filePath = path.join(directory, 'session.json');
  const diagnostics: string[] = [];
  return Object.freeze({
    filePath,
    async read() {
      let source: string;
      try {
        source = await readFile(filePath, 'utf8');
      } catch (error) {
        if (isMissingFile(error)) return undefined;
        diagnostics.push(`Session data could not be read: ${errorMessage(error)}`);
        return undefined;
      }
      try {
        return decodeSessionRecord(JSON.parse(source));
      } catch (error) {
        const quarantine = path.join(directory, `session.corrupt-${randomUUID()}.json`);
        try {
          await rename(filePath, quarantine);
          diagnostics.push(`Invalid session data was quarantined at ${quarantine}: ${errorMessage(error)}`);
        } catch (quarantineError) {
          diagnostics.push(`Invalid session data could not be quarantined: ${errorMessage(error)}; ${errorMessage(quarantineError)}`);
        }
        return undefined;
      }
    },
    async write(state: AppState) {
      await writeAtomicJson(directory, filePath, 'session', sessionRecordFromState(state));
    },
    diagnostics() {
      return Object.freeze([...diagnostics]);
    }
  });
}

export function sessionRecordFromState(state: AppState): SessionRecord {
  const buffers = state.project.bufferOrder.flatMap((id) => {
    const buffer = state.project.buffers[id];
    if (buffer === undefined) return [];
    return [Object.freeze({
      id,
      ...(buffer.path === undefined ? {} : { path: buffer.path }),
      label: buffer.label,
      cursor: buffer.editor.caret.position.offset,
      ...(buffer.editor.selection === undefined ? {} : {
        selection: Object.freeze({
          anchor: buffer.editor.selection.anchor.offset,
          focus: buffer.editor.selection.focus.offset
        })
      }),
      sourceScroll: Object.freeze({
        row: buffer.editor.scroll.offsetRow,
        column: buffer.editor.scroll.offsetColumn
      }),
      previewScroll: Object.freeze({
        row: buffer.previewScroll.offsetRow,
        column: buffer.previewScroll.offsetColumn
      })
    })];
  });
  return Object.freeze({
    schemaVersion: sessionSchemaVersion,
    ...(state.project.rootDirectory === undefined ? {} : { projectDirectory: state.project.rootDirectory }),
    buffers: Object.freeze(buffers),
    openBufferOrder: Object.freeze([...state.project.bufferOrder]),
    ...(state.project.activeBufferId === undefined ? {} : { activeBuffer: state.project.activeBufferId }),
    recentlyOpenedPaths: Object.freeze([...state.project.recentlyOpenedPaths]),
    recentProjects: Object.freeze([...state.project.recentProjects]),
    pinnedProjects: Object.freeze([...state.project.pinnedProjects]),
    expandedDirectories: Object.freeze(state.project.fileTree.expandedIds.filter((id) => (
      state.project.fileTree.nodes[id]?.kind === 'directory'
    ))),
    fileTreeFilter: state.project.fileTree.filter,
    fileTreeSort: state.project.fileTree.sort,
    editorMode: state.editorMode,
    paneArrangement: state.paneArrangement,
    splitShares: Object.freeze([...state.splitPane.shares]),
    navigator: Object.freeze({ ...state.navigator }),
    writingMode: Object.freeze({ ...state.writingMode }),
    projectSearch: Object.freeze({
      query: state.projectSearch.query,
      recentQueries: Object.freeze([...state.projectSearch.recentQueries])
    }),
    exports: Object.freeze({
      history: Object.freeze(state.exports.history.slice(0, 20).map((entry) => entry.status === 'running'
        ? Object.freeze({ ...entry, status: 'cancelled' as const, error: 'Vellum closed during export.' })
        : entry)),
      ...(state.exports.lastRequest === undefined ? {} : { lastRequest: state.exports.lastRequest })
    }),
    diagnosticPreferences: Object.freeze({
      ...state.diagnosticPreferences,
      ignoredRules: Object.freeze([...state.diagnosticPreferences.ignoredRules])
    })
  });
}

function decodeSessionRecord(value: unknown): SessionRecord {
  const record = objectValue(value, 'Session record');
  exactFields(record, [
    'schemaVersion', 'projectDirectory', 'buffers', 'openBufferOrder', 'activeBuffer',
    'recentlyOpenedPaths', 'recentProjects', 'pinnedProjects', 'expandedDirectories', 'fileTreeFilter', 'fileTreeSort', 'editorMode', 'paneArrangement',
    'splitShares', 'navigator', 'writingMode', 'projectSearch', 'exports', 'diagnosticPreferences'
  ], 'Session record');
  if (record['schemaVersion'] !== sessionSchemaVersion) {
    throw new TypeError(`Unsupported session schema version: ${String(record['schemaVersion'])}.`);
  }
  if (!Array.isArray(record['buffers'])) throw new TypeError('Session buffers must be an array.');
  const buffers = Object.freeze(record['buffers'].map(decodeSessionBuffer));
  const ids = new Set(buffers.map((buffer) => buffer.id));
  if (ids.size !== buffers.length) throw new TypeError('Session buffer identifiers must be unique.');
  const openBufferOrder = stringArray(record['openBufferOrder'], 'Session open-buffer order');
  if (new Set(openBufferOrder).size !== openBufferOrder.length
    || openBufferOrder.length !== buffers.length
    || openBufferOrder.some((id) => !ids.has(id))) {
    throw new TypeError('Session open-buffer order must identify every buffer exactly once.');
  }
  const activeBuffer = record['activeBuffer'];
  if (activeBuffer !== undefined && (typeof activeBuffer !== 'string' || !ids.has(activeBuffer))) {
    throw new TypeError('Session active buffer is invalid.');
  }
  if ((buffers.length === 0) !== (activeBuffer === undefined)) {
    throw new TypeError('Session active buffer must identify an open buffer whenever buffers are present.');
  }
  const editorMode = enumValue(record['editorMode'], ['source', 'hybrid'] as const, 'Session editor mode');
  const paneArrangement = enumValue(
    record['paneArrangement'],
    ['editor', 'preview', 'editorPreview'] as const,
    'Session pane arrangement'
  );
  const splitShares = numberPair(record['splitShares'], 'Session split shares');
  const navigator = decodeNavigator(record['navigator']);
  const writingMode = decodeWritingMode(record['writingMode']);
  const exports = decodeExportState(record['exports']);
  const diagnosticPreferences = decodeDiagnosticPreferences(record['diagnosticPreferences']);
  const projectSearch = decodeProjectSearch(record['projectSearch']);
  if (typeof record['fileTreeFilter'] !== 'string') throw new TypeError('Session file-tree filter must be a string.');
  return Object.freeze({
    schemaVersion: sessionSchemaVersion,
    ...optionalPath(record['projectDirectory'], 'Session project directory'),
    buffers,
    openBufferOrder,
    ...(activeBuffer === undefined ? {} : { activeBuffer }),
    recentlyOpenedPaths: stringArray(record['recentlyOpenedPaths'], 'Session recently-opened paths', true),
    recentProjects: stringArray(record['recentProjects'], 'Session recent projects', true),
    pinnedProjects: stringArray(record['pinnedProjects'], 'Session pinned projects', true),
    expandedDirectories: stringArray(record['expandedDirectories'], 'Session expanded directories', true),
    fileTreeFilter: record['fileTreeFilter'],
    fileTreeSort: enumValue(record['fileTreeSort'], ['foldersFirst', 'nameAscending', 'nameDescending'] as const, 'Session file-tree sort'),
    editorMode,
    paneArrangement,
    splitShares,
    navigator,
    writingMode,
    projectSearch,
    exports,
    diagnosticPreferences
  });
}

function decodeProjectSearch(value: unknown): SessionRecord['projectSearch'] {
  const search = objectValue(value, 'Session project search');
  exactFields(search, ['query', 'recentQueries'], 'Session project search');
  if (typeof search['query'] !== 'string') throw new TypeError('Session project search query must be a string.');
  return Object.freeze({
    query: search['query'],
    recentQueries: stringArray(search['recentQueries'], 'Session recent project queries')
  });
}

function decodeDiagnosticPreferences(value: unknown): AppState['diagnosticPreferences'] {
  const preferences = objectValue(value, 'Session diagnostic preferences');
  exactFields(preferences, ['minimumSeverity', 'source', 'ignoredRules'], 'Session diagnostic preferences');
  return Object.freeze({
    minimumSeverity: enumValue(preferences['minimumSeverity'], ['info', 'warning', 'error'] as const, 'Session minimum diagnostic severity'),
    source: enumValue(preferences['source'], ['all', 'parser', 'markdown', 'spelling', 'grammar', 'links', 'assets', 'export'] as const, 'Session diagnostic source'),
    ignoredRules: stringArray(preferences['ignoredRules'], 'Session ignored diagnostic rules')
  });
}

function decodeExportState(value: unknown): ExportState {
  const exports = objectValue(value, 'Session exports');
  exactFields(exports, ['history', 'lastRequest'], 'Session exports');
  if (!Array.isArray(exports['history'])) throw new TypeError('Session export history must be an array.');
  const history = Object.freeze(exports['history'].map((entryValue) => {
    const entry = objectValue(entryValue, 'Session export history entry');
    exactFields(entry, [
      'id', 'scope', 'profileId', 'status', 'startedAt', 'elapsedMilliseconds', 'outputPaths',
      'standardError', 'usedUnsavedSource', 'error'
    ], 'Session export history entry');
    const status = enumValue(entry['status'], ['succeeded', 'failed', 'cancelled'] as const, 'Session export status');
    if (typeof entry['startedAt'] !== 'string' || Number.isNaN(Date.parse(entry['startedAt']))) throw new TypeError('Session export start time is invalid.');
    if (typeof entry['standardError'] !== 'string' || typeof entry['usedUnsavedSource'] !== 'boolean') throw new TypeError('Session export details are invalid.');
    if (entry['error'] !== undefined && typeof entry['error'] !== 'string') throw new TypeError('Session export error is invalid.');
    const elapsedMilliseconds = entry['elapsedMilliseconds'];
    if (typeof elapsedMilliseconds !== 'number' || !Number.isFinite(elapsedMilliseconds) || elapsedMilliseconds < 0) throw new TypeError('Session export elapsed time is invalid.');
    return Object.freeze({
      id: nonemptyString(entry['id'], 'Session export id'),
      scope: enumValue(entry['scope'], ['activeBuffer', 'batchDirectory', 'projectManifest'] as const, 'Session export scope'),
      profileId: nonemptyString(entry['profileId'], 'Session export profile'),
      status,
      startedAt: entry['startedAt'],
      elapsedMilliseconds,
      outputPaths: stringArray(entry['outputPaths'], 'Session export output paths', true),
      standardError: entry['standardError'],
      usedUnsavedSource: entry['usedUnsavedSource'],
      ...(entry['error'] === undefined ? {} : { error: entry['error'] as string })
    });
  }));
  const requestValue = exports['lastRequest'];
  const lastRequest = requestValue === undefined ? undefined : objectValue(requestValue, 'Session last export request');
  if (lastRequest !== undefined) exactFields(lastRequest, ['scope', 'profileId'], 'Session last export request');
  return Object.freeze({
    history,
    ...(lastRequest === undefined ? {} : {
      lastRequest: Object.freeze({
        scope: enumValue(lastRequest['scope'], ['activeBuffer', 'batchDirectory', 'projectManifest'] as const, 'Session last export scope'),
        profileId: nonemptyString(lastRequest['profileId'], 'Session last export profile')
      })
    })
  });
}

function decodeSessionBuffer(value: unknown): SessionBufferRecord {
  const buffer = objectValue(value, 'Session buffer');
  exactFields(buffer, ['id', 'path', 'label', 'cursor', 'selection', 'sourceScroll', 'previewScroll'], 'Session buffer');
  const id = nonemptyString(buffer['id'], 'Session buffer id');
  const pathValue = optionalAbsolutePath(buffer['path'], `Session buffer ${id} path`);
  if (typeof buffer['label'] !== 'string') throw new TypeError(`Session buffer ${id} label must be a string.`);
  return Object.freeze({
    id,
    ...(pathValue === undefined ? {} : { path: pathValue }),
    label: buffer['label'],
    cursor: nonnegativeInteger(buffer['cursor'], `Session buffer ${id} cursor`),
    ...(buffer['selection'] === undefined ? {} : { selection: decodeSelection(buffer['selection'], id) }),
    sourceScroll: decodeScroll(buffer['sourceScroll'], `Session buffer ${id} source scroll`),
    previewScroll: decodeScroll(buffer['previewScroll'], `Session buffer ${id} preview scroll`)
  });
}

function decodeNavigator(value: unknown): SessionRecord['navigator'] {
  const navigator = objectValue(value, 'Session navigator');
  exactFields(navigator, ['mode', 'visible', 'width'], 'Session navigator');
  if (typeof navigator['visible'] !== 'boolean') throw new TypeError('Session navigator visibility must be boolean.');
  const width = nonnegativeInteger(navigator['width'], 'Session navigator width');
  if (width < 16 || width > 120) throw new TypeError('Session navigator width must be from 16 through 120 columns.');
  return Object.freeze({
    mode: enumValue(
      navigator['mode'],
      ['files', 'outline', 'search', 'diagnostics', 'backlinks', 'properties', 'export'] as const,
      'Session navigator mode'
    ),
    visible: navigator['visible'],
    width
  });
}

function decodeWritingMode(value: unknown): SessionRecord['writingMode'] {
  const writing = objectValue(value, 'Session writing mode');
  exactFields(writing, ['focus', 'typewriter', 'distractionFree', 'typewriterAnchor'], 'Session writing mode');
  if (typeof writing['focus'] !== 'boolean'
    || typeof writing['typewriter'] !== 'boolean'
    || typeof writing['distractionFree'] !== 'boolean'
    || typeof writing['typewriterAnchor'] !== 'number'
    || !Number.isFinite(writing['typewriterAnchor'])
    || writing['typewriterAnchor'] < 0
    || writing['typewriterAnchor'] > 1) {
    throw new TypeError('Session writing mode is invalid.');
  }
  return Object.freeze({
    focus: writing['focus'],
    typewriter: writing['typewriter'],
    distractionFree: writing['distractionFree'],
    typewriterAnchor: writing['typewriterAnchor']
  });
}

function decodeSelection(value: unknown, id: string): { readonly anchor: number; readonly focus: number } {
  const selection = objectValue(value, `Session buffer ${id} selection`);
  exactFields(selection, ['anchor', 'focus'], `Session buffer ${id} selection`);
  return Object.freeze({
    anchor: nonnegativeInteger(selection['anchor'], `Session buffer ${id} selection anchor`),
    focus: nonnegativeInteger(selection['focus'], `Session buffer ${id} selection focus`)
  });
}

function decodeScroll(value: unknown, label: string): { readonly row: number; readonly column: number } {
  const scroll = objectValue(value, label);
  exactFields(scroll, ['row', 'column'], label);
  return Object.freeze({
    row: nonnegativeInteger(scroll['row'], `${label} row`),
    column: nonnegativeInteger(scroll['column'], `${label} column`)
  });
}

async function writeAtomicJson(directory: string, filePath: string, prefix: string, value: unknown): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${prefix}-${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(value), 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, filePath);
    await flushDirectoryMetadata(directory);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true });
  }
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function exactFields(value: Record<string, unknown>, allowedFields: readonly string[], label: string): void {
  const allowed = new Set(allowedFields);
  const unknown = Object.keys(value).filter((field) => !allowed.has(field));
  if (unknown.length > 0) throw new TypeError(`${label} contains unknown fields: ${unknown.join(', ')}.`);
}

function enumValue<const TValue extends string>(value: unknown, allowed: readonly TValue[], label: string): TValue {
  if (typeof value !== 'string' || !allowed.includes(value as TValue)) throw new TypeError(`${label} is invalid.`);
  return value as TValue;
}

function numberPair(value: unknown, label: string): readonly number[] {
  if (!Array.isArray(value)
    || value.length !== 2
    || !value.every((entry) => typeof entry === 'number' && Number.isFinite(entry) && entry >= 0)
    || value.reduce((sum, entry) => sum + Number(entry), 0) <= 0) {
    throw new TypeError(`${label} must contain two nonnegative finite values with a positive total.`);
  }
  return Object.freeze([Number(value[0]), Number(value[1])]);
}

function stringArray(value: unknown, label: string, absolute = false): readonly string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string' && (!absolute || path.isAbsolute(entry)))) {
    throw new TypeError(`${label} must be ${absolute ? 'an absolute-path' : 'a string'} array.`);
  }
  return Object.freeze([...value] as string[]);
}

function nonemptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a nonempty string.`);
  return value;
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new TypeError(`${label} must be a nonnegative integer.`);
  return Number(value);
}

function optionalAbsolutePath(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new TypeError(`${label} must be an absolute path.`);
  return value;
}

function optionalPath(value: unknown, label: string): { readonly projectDirectory?: string } {
  const resolved = optionalAbsolutePath(value, label);
  return resolved === undefined ? Object.freeze({}) : Object.freeze({ projectDirectory: resolved });
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
