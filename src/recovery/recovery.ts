import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  createScrollState,
  createTextAreaState,
  createSplitPaneState
} from '@ismail-elkorchi/terminal-ui/behavior';
import { textCaretAt, textDocumentSelectionBetween, textDocumentText } from '@ismail-elkorchi/terminal-ui/text';
import type {
  AppState,
  BufferId,
  BufferState,
  EditorMode,
  ExternalFileFingerprint,
  ExternalFileState,
  FileFormat,
  PaneArrangement
} from '../app/types.js';
import { createBufferParser, type BufferParser } from '../markdown/preview.js';
import { createFileTreeState } from '../project/file-tree.js';
import { flushDirectoryMetadata } from '../files/durability.js';
import { defaultVellumStateDirectory } from '../config/paths.js';

const recoverySchemaVersion = 2;

interface RecoveryBufferRecord {
  readonly id: BufferId;
  readonly path?: string;
  readonly label: string;
  readonly source: string;
  readonly savedSourceRevision: number;
  readonly currentSourceRevision: number;
  readonly cursor: number;
  readonly selection?: { readonly anchor: number; readonly focus: number };
  readonly sourceScroll: { readonly row: number; readonly column: number };
  readonly previewScroll: { readonly row: number; readonly column: number };
  readonly externalFileState: ExternalFileState;
  readonly format: FileFormat;
}

export interface RecoveryRecord {
  readonly schemaVersion: 2;
  readonly projectDirectory?: string;
  readonly buffers: readonly RecoveryBufferRecord[];
  readonly openBufferOrder: readonly BufferId[];
  readonly activeBuffer?: BufferId;
  readonly editorMode: EditorMode;
  readonly paneArrangement: PaneArrangement;
  readonly splitShares: readonly number[];
}

export interface RecoveryStore {
  readonly filePath: string;
  read(): Promise<RecoveryRecord | undefined>;
  write(state: AppState): Promise<void>;
  delete(): Promise<void>;
}

export class UnknownRecoverySchemaError extends Error {
  public constructor(version: unknown) {
    super(`Unsupported recovery schema version: ${String(version)}.`);
    this.name = 'UnknownRecoverySchemaError';
  }
}

export function createRecoveryStore(directory = defaultVellumStateDirectory()): RecoveryStore {
  const filePath = path.join(directory, 'recovery.json');
  return Object.freeze({
    filePath,
    async read() {
      let source: string;
      try {
        source = await readFile(filePath, 'utf8');
      } catch (error) {
        if (isMissingFile(error)) return undefined;
        throw error;
      }
      const parsed: unknown = JSON.parse(source);
      return decodeRecoveryRecord(parsed);
    },
    async write(state: AppState) {
      const record = recoveryRecordFromState(state);
      if (record.buffers.every((buffer) => buffer.currentSourceRevision === buffer.savedSourceRevision)) {
        await this.delete();
        return;
      }
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = path.join(directory, `.recovery-${randomUUID()}.tmp`);
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        handle = await open(temporary, 'wx', 0o600);
        await handle.writeFile(JSON.stringify(record), 'utf8');
        await handle.sync();
        await handle.close();
        handle = undefined;
        await rename(temporary, filePath);
        await flushDirectoryMetadata(directory);
      } finally {
        await handle?.close().catch(() => undefined);
        await rm(temporary, { force: true });
      }
    },
    async delete() {
      try {
        await rm(filePath);
      } catch (error) {
        if (isMissingFile(error)) return;
        throw error;
      }
      await flushDirectoryMetadata(directory);
    }
  });
}

function recoveryRecordFromState(state: AppState): RecoveryRecord {
  const buffers = state.project.bufferOrder.flatMap((id) => {
    const buffer = state.project.buffers[id];
    if (buffer === undefined) return [];
    return [Object.freeze({
      id,
      ...(buffer.path === undefined ? {} : { path: buffer.path }),
      label: buffer.label,
      source: textDocumentText(buffer.editor.document),
      savedSourceRevision: buffer.savedRevision,
      currentSourceRevision: buffer.sourceRevision,
      cursor: buffer.editor.caret.position.offset,
      ...(buffer.editor.selection === undefined ? {} : {
        selection: Object.freeze({
          anchor: buffer.editor.selection.anchor.offset,
          focus: buffer.editor.selection.focus.offset
        })
      }),
      sourceScroll: Object.freeze({ row: buffer.editor.scroll.offsetRow, column: buffer.editor.scroll.offsetColumn }),
      previewScroll: Object.freeze({ row: buffer.previewScroll.offsetRow, column: buffer.previewScroll.offsetColumn }),
      externalFileState: buffer.externalFileState,
      format: buffer.format
    })];
  });
  return Object.freeze({
    schemaVersion: recoverySchemaVersion,
    ...(state.project.rootDirectory === undefined ? {} : { projectDirectory: state.project.rootDirectory }),
    buffers: Object.freeze(buffers),
    openBufferOrder: Object.freeze([...state.project.bufferOrder]),
    ...(state.project.activeBufferId === undefined ? {} : { activeBuffer: state.project.activeBufferId }),
    editorMode: state.editorMode,
    paneArrangement: state.paneArrangement,
    splitShares: Object.freeze([...state.splitPane.shares])
  });
}

interface RecoveredApplicationSeed {
  readonly state: AppState;
  readonly parsers: ReadonlyMap<BufferId, BufferParser>;
}

export function recoverApplicationSeed(record: RecoveryRecord): RecoveredApplicationSeed {
  const buffers: Record<BufferId, BufferState> = {};
  const parsers = new Map<BufferId, BufferParser>();
  for (const recovered of record.buffers) {
    const parser = createBufferParser(recovered.source, recovered.currentSourceRevision);
    parsers.set(recovered.id, parser);
    const selection = recovered.selection === undefined
      ? undefined
      : textDocumentSelectionBetween(recovered.selection.anchor, recovered.selection.focus);
    const editor = createTextAreaState({
      value: recovered.source,
      caret: textCaretAt(recovered.cursor),
      ...(selection === undefined ? {} : { selection }),
      scroll: createScrollState({
        offsetRow: recovered.sourceScroll.row,
        offsetColumn: recovered.sourceScroll.column
      })
    });
    buffers[recovered.id] = Object.freeze({
      id: recovered.id,
      ...(recovered.path === undefined ? {} : { path: recovered.path }),
      label: recovered.label,
      editor,
      sourceRevision: recovered.currentSourceRevision,
      savedRevision: recovered.savedSourceRevision,
      preview: parser.preview(),
      previewResourceRevision: 0,
      previewScroll: createScrollState({
        offsetRow: recovered.previewScroll.row,
        offsetColumn: recovered.previewScroll.column
      }),
      externalFileState: recovered.externalFileState,
      format: recovered.format
    });
  }
  const rootDirectory = record.projectDirectory;
  const state: AppState = Object.freeze({
    project: Object.freeze({
      ...(rootDirectory === undefined ? {} : { rootDirectory }),
      fileTree: createFileTreeState(rootDirectory),
      buffers: Object.freeze(buffers),
      bufferOrder: record.openBufferOrder,
      ...(record.activeBuffer === undefined ? {} : { activeBufferId: record.activeBuffer }),
      recentlyClosed: Object.freeze([]),
      recentlyOpenedPaths: Object.freeze(record.buffers.flatMap((buffer) => buffer.path === undefined ? [] : [buffer.path]))
    }),
    editorMode: record.editorMode,
    paneArrangement: record.paneArrangement,
    splitPane: createSplitPaneState(2, record.splitShares),
    commandState: Object.freeze({
      navigation: Object.freeze({ back: Object.freeze([]), forward: Object.freeze([]) })
    }),
    notice: Object.freeze({ status: 'warning', message: 'Unsaved buffers were restored from a recovery record.' })
  });
  return Object.freeze({ state, parsers });
}

function decodeRecoveryRecord(value: unknown): RecoveryRecord {
  const object = objectValue(value, 'Recovery record');
  exactFields(object, [
    'schemaVersion', 'projectDirectory', 'buffers', 'openBufferOrder', 'activeBuffer',
    'editorMode', 'paneArrangement', 'splitShares'
  ], 'Recovery record');
  if (object['schemaVersion'] !== recoverySchemaVersion) throw new UnknownRecoverySchemaError(object['schemaVersion']);
  const projectDirectory = optionalAbsolutePath(object['projectDirectory'], 'Recovery project directory');
  if (!Array.isArray(object['buffers'])) throw new TypeError('Recovery record buffers must be an array.');
  const buffers = Object.freeze(object['buffers'].map(decodeRecoveryBuffer));
  const bufferIds = new Set<string>();
  for (const buffer of buffers) {
    if (bufferIds.has(buffer.id)) throw new TypeError(`Recovery buffer identifier is duplicated: ${buffer.id}`);
    bufferIds.add(buffer.id);
  }
  if (!Array.isArray(object['openBufferOrder']) || !object['openBufferOrder'].every((id) => typeof id === 'string')) {
    throw new TypeError('Recovery open-buffer order must be a string array.');
  }
  const openBufferOrder = Object.freeze([...object['openBufferOrder']] as string[]);
  if (new Set(openBufferOrder).size !== openBufferOrder.length) {
    throw new TypeError('Recovery open-buffer order contains duplicate identifiers.');
  }
  if (openBufferOrder.length !== buffers.length || openBufferOrder.some((id) => !bufferIds.has(id))) {
    throw new TypeError('Recovery open-buffer order must contain every recovery buffer exactly once.');
  }
  const activeBuffer = object['activeBuffer'];
  if (activeBuffer !== undefined && (typeof activeBuffer !== 'string' || !bufferIds.has(activeBuffer))) {
    throw new TypeError('Recovery active buffer is invalid.');
  }
  if ((buffers.length === 0) !== (activeBuffer === undefined)) {
    throw new TypeError('Recovery active buffer must identify one open buffer whenever buffers are present.');
  }
  if (object['editorMode'] !== 'source' && object['editorMode'] !== 'hybrid') {
    throw new TypeError('Recovery record editor mode is invalid.');
  }
  if (object['paneArrangement'] !== 'editor'
    && object['paneArrangement'] !== 'preview'
    && object['paneArrangement'] !== 'editorPreview') {
    throw new TypeError('Recovery record pane arrangement is invalid.');
  }
  if (!Array.isArray(object['splitShares'])
    || object['splitShares'].length !== 2
    || !object['splitShares'].every((share) => typeof share === 'number' && Number.isFinite(share) && share >= 0)
    || object['splitShares'].reduce((sum, share) => sum + (share as number), 0) <= 0) {
    throw new TypeError('Recovery split shares must contain two nonnegative finite values with a positive total.');
  }
  return Object.freeze({
    schemaVersion: recoverySchemaVersion,
    ...(projectDirectory === undefined ? {} : { projectDirectory }),
    buffers,
    openBufferOrder,
    ...(activeBuffer === undefined ? {} : { activeBuffer }),
    editorMode: object['editorMode'],
    paneArrangement: object['paneArrangement'],
    splitShares: Object.freeze([...(object['splitShares'] as number[])])
  });
}

function decodeRecoveryBuffer(value: unknown): RecoveryBufferRecord {
  const buffer = objectValue(value, 'Recovery buffer');
  exactFields(buffer, [
    'id', 'path', 'label', 'source', 'savedSourceRevision', 'currentSourceRevision', 'cursor',
    'selection', 'sourceScroll', 'previewScroll', 'externalFileState', 'format'
  ], 'Recovery buffer');
  const id = nonemptyString(buffer['id'], 'Recovery buffer id');
  const filePath = optionalAbsolutePath(buffer['path'], `Recovery buffer ${id} path`);
  if (typeof buffer['label'] !== 'string' || typeof buffer['source'] !== 'string') {
    throw new TypeError(`Recovery buffer ${id} label and source must be strings.`);
  }
  const savedSourceRevision = nonnegativeInteger(buffer['savedSourceRevision'], `Recovery buffer ${id} saved source revision`);
  const currentSourceRevision = nonnegativeInteger(buffer['currentSourceRevision'], `Recovery buffer ${id} current source revision`);
  if (savedSourceRevision > currentSourceRevision) {
    throw new TypeError(`Recovery buffer ${id} saved source revision exceeds its current source revision.`);
  }
  const cursor = sourceOffset(buffer['cursor'], buffer['source'].length, `Recovery buffer ${id} cursor`);
  const selection = buffer['selection'] === undefined
    ? undefined
    : decodeSelection(buffer['selection'], buffer['source'].length, id);
  const sourceScroll = decodeScroll(buffer['sourceScroll'], `Recovery buffer ${id} source scroll`);
  const previewScroll = decodeScroll(buffer['previewScroll'], `Recovery buffer ${id} preview scroll`);
  const externalFileState = decodeExternalFileState(buffer['externalFileState'], id);
  if ((filePath === undefined) !== (externalFileState.kind === 'untracked')) {
    throw new TypeError(`Recovery buffer ${id} path and external file state are inconsistent.`);
  }
  return Object.freeze({
    id,
    ...(filePath === undefined ? {} : { path: filePath }),
    label: buffer['label'],
    source: buffer['source'],
    savedSourceRevision,
    currentSourceRevision,
    cursor,
    ...(selection === undefined ? {} : { selection }),
    sourceScroll,
    previewScroll,
    externalFileState,
    format: decodeFileFormat(buffer['format'], id)
  });
}

function decodeSelection(
  value: unknown,
  sourceLength: number,
  bufferId: string
): { readonly anchor: number; readonly focus: number } {
  const selection = objectValue(value, `Recovery buffer ${bufferId} selection`);
  exactFields(selection, ['anchor', 'focus'], `Recovery buffer ${bufferId} selection`);
  return Object.freeze({
    anchor: sourceOffset(selection['anchor'], sourceLength, `Recovery buffer ${bufferId} selection anchor`),
    focus: sourceOffset(selection['focus'], sourceLength, `Recovery buffer ${bufferId} selection focus`)
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

function decodeExternalFileState(value: unknown, bufferId: string): ExternalFileState {
  const state = objectValue(value, `Recovery buffer ${bufferId} external file state`);
  if (state['kind'] === 'untracked') {
    exactFields(state, ['kind'], `Recovery buffer ${bufferId} external file state`);
    return Object.freeze({ kind: 'untracked' });
  }
  if (state['kind'] === 'current') {
    exactFields(state, ['kind', 'fingerprint'], `Recovery buffer ${bufferId} external file state`);
    return Object.freeze({ kind: 'current', fingerprint: decodeFingerprint(state['fingerprint'], bufferId) });
  }
  if (state['kind'] === 'conflict') {
    exactFields(state, ['kind', 'disk'], `Recovery buffer ${bufferId} external file state`);
    return Object.freeze({ kind: 'conflict', disk: decodeFingerprint(state['disk'], bufferId) });
  }
  if (state['kind'] === 'deleted') {
    exactFields(state, ['kind', 'previous'], `Recovery buffer ${bufferId} external file state`);
    return Object.freeze({ kind: 'deleted', previous: decodeFingerprint(state['previous'], bufferId) });
  }
  throw new TypeError(`Recovery buffer ${bufferId} external file state kind is invalid.`);
}

function decodeFingerprint(value: unknown, bufferId: string): ExternalFileFingerprint {
  const fingerprint = objectValue(value, `Recovery buffer ${bufferId} external file fingerprint`);
  exactFields(
    fingerprint,
    ['realPath', 'device', 'inode', 'size', 'modifiedNanoseconds', 'contentHash'],
    `Recovery buffer ${bufferId} external file fingerprint`
  );
  const realPath = optionalAbsolutePath(fingerprint['realPath'], `Recovery buffer ${bufferId} external file real path`);
  if (realPath === undefined
    || typeof fingerprint['device'] !== 'string'
    || typeof fingerprint['inode'] !== 'string'
    || typeof fingerprint['modifiedNanoseconds'] !== 'string'
    || typeof fingerprint['contentHash'] !== 'string'
    || !/^\d+$/u.test(fingerprint['device'])
    || !/^\d+$/u.test(fingerprint['inode'])
    || !/^-?\d+$/u.test(fingerprint['modifiedNanoseconds'])
    || !/^[a-f0-9]{64}$/u.test(fingerprint['contentHash'])) {
    throw new TypeError(`Recovery buffer ${bufferId} external file fingerprint is invalid.`);
  }
  return Object.freeze({
    realPath,
    device: fingerprint['device'],
    inode: fingerprint['inode'],
    size: nonnegativeInteger(fingerprint['size'], `Recovery buffer ${bufferId} external file size`),
    modifiedNanoseconds: fingerprint['modifiedNanoseconds'],
    contentHash: fingerprint['contentHash']
  });
}

function decodeFileFormat(value: unknown, bufferId: string): FileFormat {
  const format = objectValue(value, `Recovery buffer ${bufferId} format`);
  exactFields(format, ['bom', 'lineEnding', 'permissionMode'], `Recovery buffer ${bufferId} format`);
  if (typeof format['bom'] !== 'boolean' || (format['lineEnding'] !== 'lf' && format['lineEnding'] !== 'crlf')) {
    throw new TypeError(`Recovery buffer ${bufferId} format is invalid.`);
  }
  const permissionMode = format['permissionMode'];
  if (permissionMode !== undefined
    && (!Number.isSafeInteger(permissionMode) || (permissionMode as number) < 0 || (permissionMode as number) > 0o777)) {
    throw new TypeError(`Recovery buffer ${bufferId} permission mode is invalid.`);
  }
  return Object.freeze({
    bom: format['bom'],
    lineEnding: format['lineEnding'],
    ...(permissionMode === undefined ? {} : { permissionMode: permissionMode as number })
  });
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exactFields(value: Record<string, unknown>, fields: readonly string[], label: string): void {
  const allowed = new Set(fields);
  const unknown = Object.keys(value).filter((field) => !allowed.has(field));
  if (unknown.length > 0) throw new TypeError(`${label} contains unknown fields: ${unknown.join(', ')}.`);
}

function nonemptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a nonempty string.`);
  return value;
}

function optionalAbsolutePath(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new TypeError(`${label} must be an absolute path.`);
  return value;
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError(`${label} must be a nonnegative integer.`);
  return value as number;
}

function sourceOffset(value: unknown, sourceLength: number, label: string): number {
  const offset = nonnegativeInteger(value, label);
  if (offset > sourceLength) throw new TypeError(`${label} exceeds the source document length.`);
  return offset;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'ENOENT';
}
