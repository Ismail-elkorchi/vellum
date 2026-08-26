import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import os from 'node:os';
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
  FileFormat,
  PaneArrangement
} from '../app/types.js';
import { createBufferParser, type BufferParser } from '../markdown/preview.js';
import { createFileTreeState } from '../project/file-tree.js';

const recoverySchemaVersion = 1;

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
  readonly externalFileFingerprint?: ExternalFileFingerprint;
  readonly format: FileFormat;
}

export interface RecoveryRecord {
  readonly schemaVersion: 1;
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

export function defaultRecoveryDirectory(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return path.join(process.env['LOCALAPPDATA'] ?? path.join(os.homedir(), 'AppData', 'Local'), 'Vellum');
  if (platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Vellum');
  return path.join(process.env['XDG_STATE_HOME'] ?? path.join(os.homedir(), '.local', 'state'), 'vellum');
}

export function createRecoveryStore(directory = defaultRecoveryDirectory()): RecoveryStore {
  const filePath = path.join(directory, 'recovery.json');
  return Object.freeze({
    filePath,
    async read() {
      try {
        await access(filePath, constants.R_OK);
      } catch {
        return undefined;
      }
      const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'));
      return validateRecoveryRecord(parsed);
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
        const directoryHandle = await open(directory, 'r');
        try {
          await directoryHandle.sync();
        } finally {
          await directoryHandle.close();
        }
      } finally {
        await handle?.close().catch(() => undefined);
        await rm(temporary, { force: true });
      }
    },
    async delete() {
      await rm(filePath, { force: true });
    }
  });
}

export function recoveryRecordFromState(state: AppState): RecoveryRecord {
  const buffers = state.project.bufferOrder.flatMap((id) => {
    const buffer = state.project.buffers[id];
    if (buffer === undefined) return [];
    const externalFileFingerprint = buffer.externalFileState.kind === 'current'
      ? buffer.externalFileState.fingerprint
      : buffer.externalFileState.kind === 'conflict'
        ? buffer.externalFileState.disk
        : buffer.externalFileState.kind === 'deleted'
          ? buffer.externalFileState.previous
          : undefined;
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
      ...(externalFileFingerprint === undefined ? {} : { externalFileFingerprint }),
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

export interface RecoveredApplicationSeed {
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
      dirty: recovered.currentSourceRevision !== recovered.savedSourceRevision,
      preview: parser.preview(),
      previewScroll: createScrollState({
        offsetRow: recovered.previewScroll.row,
        offsetColumn: recovered.previewScroll.column
      }),
      externalFileState: recovered.externalFileFingerprint === undefined
        ? Object.freeze({ kind: 'untracked' })
        : Object.freeze({ kind: 'current', fingerprint: recovered.externalFileFingerprint }),
      format: recovered.format
    });
  }
  const rootDirectory = record.projectDirectory;
  const state: AppState = Object.freeze({
    project: Object.freeze({
      ...(rootDirectory === undefined ? {} : { rootDirectory }),
      fileTree: createFileTreeState(rootDirectory),
      buffers: Object.freeze(buffers),
      bufferOrder: Object.freeze(record.openBufferOrder.filter((id) => buffers[id] !== undefined)),
      ...(record.activeBuffer === undefined || buffers[record.activeBuffer] === undefined ? {} : { activeBufferId: record.activeBuffer }),
      recentlyClosed: Object.freeze([]),
      recentlyOpenedPaths: Object.freeze(record.buffers.flatMap((buffer) => buffer.path === undefined ? [] : [buffer.path]))
    }),
    editorMode: record.editorMode,
    paneArrangement: record.paneArrangement,
    splitPane: createSplitPaneState(2, record.splitShares),
    commandState: Object.freeze({
      activePane: record.paneArrangement === 'preview' ? 'preview' : 'editor',
      navigation: Object.freeze({ back: Object.freeze([]), forward: Object.freeze([]) })
    }),
    notice: Object.freeze({ status: 'warning', message: 'Unsaved buffers were restored from a recovery record.' })
  });
  return Object.freeze({ state, parsers });
}

function validateRecoveryRecord(value: unknown): RecoveryRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Recovery record must be an object.');
  const object = value as Record<string, unknown>;
  if (object['schemaVersion'] !== recoverySchemaVersion) throw new UnknownRecoverySchemaError(object['schemaVersion']);
  if (!Array.isArray(object['buffers']) || !Array.isArray(object['openBufferOrder'])) throw new TypeError('Recovery record buffers are invalid.');
  if (object['editorMode'] !== 'source' && object['editorMode'] !== 'hybrid') throw new TypeError('Recovery record editor mode is invalid.');
  if (!['editor', 'preview', 'editorPreview'].includes(String(object['paneArrangement']))) throw new TypeError('Recovery record pane arrangement is invalid.');
  for (const buffer of object['buffers']) validateRecoveryBuffer(buffer);
  return value as RecoveryRecord;
}

function validateRecoveryBuffer(value: unknown): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Recovery buffer must be an object.');
  const buffer = value as Record<string, unknown>;
  for (const key of ['id', 'label', 'source']) {
    if (typeof buffer[key] !== 'string') throw new TypeError(`Recovery buffer ${key} is invalid.`);
  }
  for (const key of ['savedSourceRevision', 'currentSourceRevision', 'cursor']) {
    if (!Number.isSafeInteger(buffer[key]) || (buffer[key] as number) < 0) throw new TypeError(`Recovery buffer ${key} is invalid.`);
  }
}
