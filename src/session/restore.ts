import {
  createScrollState,
  createSplitPaneState,
  createTextAreaState
} from '@ismail-elkorchi/terminal-ui/behavior';
import {
  textCaretAt,
  textDocumentSelectionBetween
} from '@ismail-elkorchi/terminal-ui/text';
import { stat } from 'node:fs/promises';
import type { AppState, BufferId, BufferState } from '../app/types.js';
import { readSourceFile } from '../files/file-system.js';
import { createBufferParser, type BufferParser } from '../markdown/preview.js';
import { createFileTreeState } from '../project/file-tree.js';
import { emptyProjectIndex } from '../project/index.js';
import {
  latestRecoverySnapshot,
  type RecoveryJournal,
  type RecoveryBufferRecord
} from '../recovery/recovery.js';
import type { SessionBufferRecord, SessionRecord } from './session.js';

export interface RestoredApplicationSeed {
  readonly state: AppState;
  readonly parsers: ReadonlyMap<BufferId, BufferParser>;
  readonly diagnostics: readonly string[];
}

export async function restoreApplicationSeed(
  session: SessionRecord | undefined,
  recovery: RecoveryJournal | undefined
): Promise<RestoredApplicationSeed> {
  const snapshot = latestRecoverySnapshot(recovery);
  const recoveredById = new Map(snapshot?.buffers.map((buffer) => [buffer.id, buffer]) ?? []);
  const sessionById = new Map(session?.buffers.map((buffer) => [buffer.id, buffer]) ?? []);
  const requestedOrder = [
    ...(session?.openBufferOrder ?? []),
    ...(snapshot?.buffers.map((buffer) => buffer.id).filter((id) => !sessionById.has(id)) ?? [])
  ];
  const buffers: Record<BufferId, BufferState> = {};
  const parsers = new Map<BufferId, BufferParser>();
  const diagnostics: string[] = [];
  const restoredOrder: BufferId[] = [];

  for (const id of requestedOrder) {
    const metadata = sessionById.get(id);
    const recovered = recoveredById.get(id);
    const restored = await restoreBuffer(id, metadata, recovered, diagnostics);
    if (restored === undefined) continue;
    buffers[id] = restored.buffer;
    parsers.set(id, restored.parser);
    restoredOrder.push(id);
  }

  let projectDirectory = session?.projectDirectory;
  if (projectDirectory !== undefined) {
    try {
      if (!(await stat(projectDirectory)).isDirectory()) {
        diagnostics.push(`Session project path is no longer a directory and was skipped: ${projectDirectory}`);
        projectDirectory = undefined;
      }
    } catch (error) {
      diagnostics.push(`Session project directory could not be restored and was skipped: ${projectDirectory}: ${errorMessage(error)}`);
      projectDirectory = undefined;
    }
  }
  const baseFileTree = createFileTreeState(projectDirectory);
  const fileTree = Object.freeze({
    ...baseFileTree,
    filter: session?.fileTreeFilter ?? '',
    sort: session?.fileTreeSort ?? 'foldersFirst'
  });
  const pendingExpansionIds = session?.expandedDirectories ?? [];
  const activeBufferId = session?.activeBuffer !== undefined && buffers[session.activeBuffer] !== undefined
    ? session.activeBuffer
    : restoredOrder[0];
  const recoveredCount = snapshot?.buffers.length ?? 0;
  const state: AppState = Object.freeze({
    project: Object.freeze({
      ...(projectDirectory === undefined ? {} : { rootDirectory: projectDirectory }),
      fileTree: Object.freeze({ ...fileTree, pendingExpansionIds: Object.freeze([...pendingExpansionIds]) }),
      index: emptyProjectIndex(),
      buffers: Object.freeze(buffers),
      bufferOrder: Object.freeze(restoredOrder),
      ...(activeBufferId === undefined ? {} : { activeBufferId }),
      recentlyClosed: Object.freeze([]),
      recentlyOpenedPaths: session?.recentlyOpenedPaths ?? Object.freeze([]),
      unusedAssets: Object.freeze([]),
      recentProjects: session?.recentProjects ?? Object.freeze([]),
      pinnedProjects: session?.pinnedProjects ?? Object.freeze([])
    }),
    editorMode: session?.editorMode ?? 'source',
    paneArrangement: session?.paneArrangement ?? 'editor',
    splitPane: createSplitPaneState(2, session?.splitShares ?? [0.5, 0.5]),
    navigator: session?.navigator ?? Object.freeze({ mode: 'files', visible: true, width: 28 }),
    writingMode: session?.writingMode ?? Object.freeze({
      focus: false,
      typewriter: false,
      distractionFree: false,
      typewriterAnchor: 0.45
    }),
    projectSearch: Object.freeze({
      query: session?.projectSearch.query ?? '',
      recentQueries: session?.projectSearch.recentQueries ?? Object.freeze([]),
      searching: false,
      results: Object.freeze([])
    }),
    diagnostics: Object.freeze({}),
    diagnosticPreferences: session?.diagnosticPreferences ?? Object.freeze({ minimumSeverity: 'info', source: 'all', ignoredRules: Object.freeze([]) }),
    exports: session?.exports ?? Object.freeze({ history: Object.freeze([]) }),
    commandState: Object.freeze({
      navigation: Object.freeze({ back: Object.freeze([]), forward: Object.freeze([]) })
    }),
    configurationDiagnostics: Object.freeze([]),
    ...(recoveredCount === 0 ? {} : {
      notice: Object.freeze({
        status: 'warning' as const,
        message: `${String(recoveredCount)} unsaved buffer${recoveredCount === 1 ? '' : 's'} restored from recovery generation ${String(snapshot?.generation)}.`
      })
    })
  });
  return Object.freeze({ state, parsers, diagnostics: Object.freeze(diagnostics) });
}

async function restoreBuffer(
  id: BufferId,
  metadata: SessionBufferRecord | undefined,
  recovered: RecoveryBufferRecord | undefined,
  diagnostics: string[]
): Promise<{ readonly buffer: BufferState; readonly parser: BufferParser } | undefined> {
  let source: string;
  let pathValue: string | undefined;
  let label: string;
  let sourceRevision: number;
  let savedRevision: number;
  let externalFileState: BufferState['externalFileState'];
  let format: BufferState['format'];

  if (recovered !== undefined) {
    source = recovered.source;
    pathValue = recovered.path;
    label = recovered.label;
    sourceRevision = recovered.currentSourceRevision;
    savedRevision = recovered.savedSourceRevision;
    externalFileState = recovered.externalFileState;
    format = recovered.format;
  } else if (metadata?.path !== undefined) {
    try {
      const file = await readSourceFile(metadata.path);
      source = file.source;
      pathValue = file.path;
      label = file.label;
      sourceRevision = 0;
      savedRevision = 0;
      externalFileState = Object.freeze({ kind: 'current', fingerprint: file.fingerprint });
      format = file.format;
    } catch (error) {
      diagnostics.push(`Session file could not be restored and was skipped: ${metadata.path}: ${errorMessage(error)}`);
      return undefined;
    }
  } else {
    source = '';
    pathValue = undefined;
    label = metadata?.label ?? 'Untitled';
    sourceRevision = 0;
    savedRevision = 0;
    externalFileState = Object.freeze({ kind: 'untracked' });
    format = Object.freeze({ bom: false, lineEnding: 'lf' });
  }

  const caret = Math.min(metadata?.cursor ?? source.length, source.length);
  const anchor = Math.min(metadata?.selection?.anchor ?? caret, source.length);
  const focus = Math.min(metadata?.selection?.focus ?? caret, source.length);
  const selection = metadata?.selection === undefined
    ? undefined
    : textDocumentSelectionBetween(anchor, focus);
  const editor = createTextAreaState({
    value: source,
    caret: textCaretAt(caret),
    ...(selection === undefined ? {} : { selection }),
    scroll: createScrollState({
      offsetRow: metadata?.sourceScroll.row ?? 0,
      offsetColumn: metadata?.sourceScroll.column ?? 0
    })
  });
  const parser = createBufferParser(source, sourceRevision);
  return Object.freeze({
    parser,
    buffer: Object.freeze({
      id,
      ...(pathValue === undefined ? {} : { path: pathValue }),
      label,
      editor,
      sourceRevision,
      savedRevision,
      preview: parser.preview(),
      previewResourceRevision: 0,
      previewScroll: createScrollState({
        offsetRow: metadata?.previewScroll.row ?? 0,
        offsetColumn: metadata?.previewScroll.column ?? 0
      }),
      externalFileState,
      format
    })
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
