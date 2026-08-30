import { randomUUID } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  createScrollState,
  createCommandInputState,
  commandInputReducer,
  createCommandSuggestions,
  createTextAreaState,
  normalizeScrollState,
  scrollReducer,
  splitPaneReducer,
  textAreaReducer,
  type ScrollRequest,
  type ScrollState,
  type SplitPaneTransition,
  type CommandInputTransition,
  type TextAreaState,
  type TextAreaTransition
} from '@ismail-elkorchi/terminal-ui/behavior';
import type { ScrollGeometry } from '@ismail-elkorchi/terminal-ui/interaction';
import type { TreeTransition } from '@ismail-elkorchi/terminal-ui/behavior';
import {
  defaultTextWidthProfile,
  textCaretAt,
  textDocumentSelectionBetween,
  textDocumentText
} from '@ismail-elkorchi/terminal-ui/text';
import type { RowOffsetMap, TextChangeSet, TextWidthProfile } from '@ismail-elkorchi/terminal-ui/text';
import { createTextAreaRowOffsetMap, type TextAreaDecorations } from '@ismail-elkorchi/terminal-ui/components';
import type { TerminalSize } from '@ismail-elkorchi/terminal-ui/host';
import { walkMarkdown, type MarkdownParseOptions } from 'markspan';
import type {
  AppState,
  BufferId,
  BufferState,
  ClosedBufferRecord,
  ExternalFileFingerprint,
  ExternalFileState,
  FileFormat,
  FilePathDialogState,
  NavigationLocation
} from './types.js';
import { activeBuffer, bufferIsDirty } from './types.js';
import {
  executeCommand as reduceCommand,
  initialAppState,
  commandById,
  type AppUpdate
} from '../commands/registry.js';
import { commandPaletteEntries } from '../commands/palette.js';
import { quickOpenEntries } from '../project/quick-open.js';
import {
  findDocumentMatches,
  replacementChangeSet,
  type DocumentSearchOptions
} from '../search/document-search.js';
import { searchProjectDirectory, type ProjectDirectorySearchOptions } from '../search/project-directory-search.js';
import { documentOutline, type OutlineItem } from '../navigation/outline.js';
import { openExternalMarkdownLink, resolveMarkdownLink } from '../navigation/links.js';
import type { MarkdownPreviewActivation } from '../markdown/render/layout.js';
import {
  builtInExportProfiles,
  validateExportProfiles,
  type ExportProfile
} from '../export/profiles.js';
import { exportProjectDirectory, exportSourceDocument } from '../export/exporter.js';
import {
  automaticMarkdownTransition,
  listIndentTransition,
  markdownCommandTransition,
  type MarkdownCommandOptions
} from '../editing/markdown-editing.js';
import {
  externalFileFingerprint,
  readSourceFile,
  sameExternalFileRevision,
  saveSourceFile
} from '../files/file-system.js';
import {
  commitDirectoryNodes,
  commitIndexedFiles,
  clearDirectoryLoading,
  createFileTreeState,
  indexProjectFiles,
  indexedFilePaths,
  markDirectoryLoading,
  reduceFileTree,
  readDirectoryNodes
} from '../project/file-tree.js';
import { createBufferParser, type BufferParser } from '../markdown/preview.js';
import { compareSourceLines, type DiffLine } from '../files/diff.js';
import {
  location,
  navigateBack,
  navigateForward,
  pushNavigationLocation
} from '../navigation/history.js';
import { extractMarkdownOutline } from 'markspan';
import {
  createPreviewLayoutCache,
  layoutMarkdownPreview,
  type MarkdownPreviewLayout
} from '../markdown/render/layout.js';
import type { MarkdownBlockLayoutCache } from '../markdown/render/cache.js';
import type { MarkdownRenderedBlock } from '../markdown/render/block.js';
import type { MarkdownBlockResources } from '../markdown/render/resources.js';
import {
  vellumBodyGeometry,
  vellumPaneGeometry,
  vellumPreviewDocumentGeometry,
} from './viewport-geometry.js';
import { darkTerminalMarkdownTheme, type MarkdownTheme } from '../markdown/theme.js';
import {
  createHybridTextDecorations,
} from '../markdown/hybrid.js';
import {
  createCodeHighlighter,
  builtInCodeHighlightLanguages,
  type CodeHighlighter,
  type CodeHighlightLanguage,
  type CodeHighlightSettings
} from '../markdown/highlight.js';
import { createMathRenderer, type MathRenderer } from '../markdown/math.js';
import {
  createDiagramRendererRegistry,
  type DiagramRendererDefinition,
  type DiagramRendererRegistry
} from '../markdown/diagram.js';
import {
  createMarkdownImageLoader,
  type MarkdownImageLoader,
  type MarkdownImageResult,
  type MarkdownImageSettings
} from '../markdown/image-loader.js';
import {
  recoverApplicationSeed,
  type RecoveryStore
} from '../recovery/recovery.js';

interface BufferRuntime {
  parser: BufferParser;
  watcher: FSWatcher | undefined;
  readonly pending: Set<AbortController>;
  readonly previewLayouts: MarkdownBlockLayoutCache<MarkdownRenderedBlock>;
  readonly highlighter: CodeHighlighter;
  readonly mathRenderer: MathRenderer;
  readonly diagramRenderers: DiagramRendererRegistry;
  readonly imageLoader: MarkdownImageLoader;
  readonly highlightedCode: Map<number, import('../markdown/render/code.js').HighlightedCode>;
  readonly mathText: Map<number, string>;
  readonly diagramText: Map<number, string>;
  readonly images: Map<number, MarkdownImageResult>;
  resourceRevision: number | undefined;
  readonly activeResourceRevisions: Set<number>;
  readonly resourceRefreshWaiters: Array<{ revision: number; resolve(): void; reject(error: unknown): void }>;
  lastPreviewLayout: MarkdownPreviewLayout | undefined;
  hybridDecorations: HybridDecorationCache | undefined;
}

type PreviewResourceCompletion =
  | { readonly kind: 'highlight'; readonly value: import('../markdown/render/code.js').HighlightedCode }
  | { readonly kind: 'math'; readonly value: string }
  | { readonly kind: 'image'; readonly value: MarkdownImageResult }
  | { readonly kind: 'diagram'; readonly text: string; readonly image?: MarkdownImageResult };

interface HybridDecorationCache {
  readonly document: BufferState['editor']['document'];
  readonly caretOffset: number;
  readonly selectionStart?: number;
  readonly selectionEnd?: number;
  readonly previewIdentity: object;
  readonly decorations: TextAreaDecorations;
}

function hybridDecorationCache(
  buffer: BufferState,
  decorations: TextAreaDecorations,
): HybridDecorationCache {
  const selection = buffer.editor.selection;
  return Object.freeze({
    document: buffer.editor.document,
    caretOffset: buffer.editor.caret.position.offset,
    ...(selection === undefined ? {} : {
      selectionStart: selection.anchor.offset,
      selectionEnd: selection.focus.offset,
    }),
    previewIdentity: buffer.preview.kind === 'ready' ? buffer.preview.identity : buffer.preview,
    decorations,
  });
}

function hybridDecorationCacheMatches(
  cache: HybridDecorationCache | undefined,
  buffer: BufferState,
): cache is HybridDecorationCache {
  const selection = buffer.editor.selection;
  return cache !== undefined
    && cache.document === buffer.editor.document
    && cache.caretOffset === buffer.editor.caret.position.offset
    && cache.selectionStart === selection?.anchor.offset
    && cache.selectionEnd === selection?.focus.offset
    && cache.previewIdentity === (buffer.preview.kind === 'ready' ? buffer.preview.identity : buffer.preview);
}

export interface VellumApplicationOptions {
  readonly parseOptions?: MarkdownParseOptions;
  readonly watchFiles?: boolean;
  readonly createBufferId?: () => BufferId;
  readonly initialState?: AppState;
  readonly recoveryStore?: RecoveryStore;
  readonly recoveryDelayMilliseconds?: number;
  readonly diagramRenderers?: readonly DiagramRendererDefinition[];
  readonly imageSettings?: Partial<MarkdownImageSettings>;
  readonly highlightLanguages?: readonly CodeHighlightLanguage[];
  readonly highlightSettings?: Partial<CodeHighlightSettings>;
  readonly openExternalLink?: (url: URL, signal?: AbortSignal) => Promise<void>;
  readonly exportProfiles?: readonly ExportProfile[];
  readonly markdownTheme?: MarkdownTheme;
}

export type VellumApplicationUpdateReason =
  | 'previewResource'
  | 'externalFileRevision'
  | 'recoveryFailure'
  | 'backgroundFailure';

export interface VellumApplicationUpdate {
  readonly revision: number;
  readonly reason: VellumApplicationUpdateReason;
  readonly bufferId?: BufferId;
}

export interface RuntimeBufferInfo {
  readonly parserIdentity: object;
  readonly pendingEffects: number;
  readonly watched: boolean;
}

export interface VellumApplication {
  state(): AppState;
  subscribe(listener: (update: VellumApplicationUpdate) => void): () => void;
  newBuffer(label?: string, source?: string): BufferId;
  openSource(source: string, label?: string): BufferId;
  openFile(filePath: string, signal?: AbortSignal): Promise<BufferId>;
  openProjectDirectory(directoryPath: string, signal?: AbortSignal): Promise<void>;
  loadFileTreeDirectory(directoryId: string): Promise<void>;
  refreshFileTree(): Promise<void>;
  activateBuffer(bufferId: BufferId): void;
  applyFileTreeTransition(transition: TreeTransition): Promise<void>;
  activateFileTreeNode(nodeId: string): Promise<void>;
  dispatchCommand(commandId: import('./types.js').CommandId): AppUpdate;
  updateFilePathDialog(transition: CommandInputTransition): void;
  submitFilePathDialog(value?: string): Promise<boolean>;
  updateSelectionDialog(transition: CommandInputTransition): void;
  submitSelectionDialog(value?: string): Promise<void>;
  updateDocumentSearch(field: 'query' | 'replacement', transition: CommandInputTransition): void;
  configureDocumentSearch(option: 'regularExpression' | 'caseSensitive' | 'wholeWord' | 'selectionOnly'): void;
  navigateDocumentSearch(direction: 'next' | 'previous'): void;
  replaceDocumentSearch(scope: 'current' | 'all'): void;
  updateProjectDirectorySearch(transition: CommandInputTransition): void;
  runProjectDirectorySearch(options?: ProjectDirectorySearchOptions, signal?: AbortSignal): Promise<void>;
  submitProjectDirectorySearch(value?: string, signal?: AbortSignal): Promise<void>;
  activateProjectDirectorySearchResult(index: number): Promise<void>;
  updateOutline(transition: CommandInputTransition): void;
  submitOutline(value?: string): void;
  updateGoToLine(transition: CommandInputTransition): void;
  submitGoToLine(value?: string): void;
  activatePreview(bufferId: BufferId, target: MarkdownPreviewActivation, signal?: AbortSignal): Promise<void>;
  updateExportProfile(transition: CommandInputTransition): void;
  submitExportProfile(value?: string, signal?: AbortSignal): Promise<void>;
  dismissDialog(): void;
  resizeSplitPane(transition: SplitPaneTransition): void;
  resizeTerminal(previous: TerminalSize, next: TerminalSize, widthProfile: TextWidthProfile): void;
  updatePreviewScroll(bufferId: BufferId, request: ScrollRequest, synchronization?: SynchronizedPaneGeometry): void;
  applyTextAreaTransition(bufferId: BufferId, transition: TextAreaTransition, synchronization?: SynchronizedPaneGeometry): void;
  executeMarkdownCommand(bufferId: BufferId, commandId: import('./types.js').CommandId, options?: MarkdownCommandOptions): void;
  indentList(bufferId: BufferId, outdent: boolean): void;
  saveBuffer(bufferId: BufferId, destination?: string, overwriteConflict?: boolean, signal?: AbortSignal): Promise<boolean>;
  saveAll(signal?: AbortSignal): Promise<boolean>;
  requestCloseBuffer(bufferId: BufferId): boolean;
  resolveDirtyBuffer(action: 'save' | 'discard' | 'cancel', destination?: string): Promise<boolean>;
  reopenRecentlyClosed(): BufferId | undefined;
  requestCloseApplication(): boolean;
  resolveCloseApplication(action: 'saveAll' | 'discardAll' | 'cancel'): Promise<boolean>;
  checkExternalFile(bufferId: BufferId): Promise<boolean>;
  reloadExternalFile(bufferId: BufferId): Promise<boolean>;
  keepBuffer(bufferId: BufferId): void;
  compareExternalFile(bufferId: BufferId, signal?: AbortSignal): Promise<readonly DiffLine[]>;
  overwriteExternalFile(bufferId: BufferId, signal?: AbortSignal): Promise<void>;
  recreateDeletedFile(bufferId: BufferId, signal?: AbortSignal): Promise<void>;
  resolveExternalFileAction(action: 'compare' | 'reloadDisk' | 'keepBuffer' | 'saveAs' | 'overwriteDisk' | 'recreate' | 'closeBuffer', signal?: AbortSignal): Promise<void>;
  navigateTo(bufferId: BufferId, sourceOffset: number, recordHistory?: boolean, selection?: import('markspan').SourceSpan): void;
  navigateHistory(direction: 'back' | 'forward'): void;
  runtimeBufferInfo(bufferId: BufferId): RuntimeBufferInfo | undefined;
  markdownTheme(): MarkdownTheme;
  hybridDecorations(bufferId: BufferId): TextAreaDecorations;
  previewLayout(
    bufferId: BufferId,
    width: number,
    theme?: MarkdownTheme,
    widthProfile?: TextWidthProfile,
  ): MarkdownPreviewLayout | undefined;
  previewViewportLayout(
    bufferId: BufferId,
    width: number,
    rows: number,
    theme?: MarkdownTheme,
    widthProfile?: TextWidthProfile,
  ): MarkdownPreviewLayout | undefined;
  refreshPreviewResources(bufferId: BufferId): Promise<void>;
  persistRecoveryRecord(): Promise<void>;
  dispose(): Promise<void>;
}

export interface SynchronizedPaneGeometry {
  readonly editor: { readonly width: number; readonly rows: number };
  readonly preview: { readonly width: number; readonly rows: number };
  readonly widthProfile: TextWidthProfile;
}

const defaultFormat: FileFormat = Object.freeze({ bom: false, lineEnding: 'lf' });

export function createVellumApplication(
  options: VellumApplicationOptions = {}
): VellumApplication {
  return instantiateVellumApplication(options);
}

function instantiateVellumApplication(
  options: VellumApplicationOptions,
  restoredParsers: ReadonlyMap<BufferId, BufferParser> = new Map()
): VellumApplication {
  let state = options.initialState ?? initialAppState();
  const exportProfiles = Object.freeze([...builtInExportProfiles, ...(options.exportProfiles ?? [])]);
  const markdownTheme = options.markdownTheme ?? darkTerminalMarkdownTheme;
  const exportDiagnostics = validateExportProfiles(exportProfiles);
  if (exportDiagnostics.length > 0) {
    throw new Error(exportDiagnostics.map((diagnostic) => `${diagnostic.profileId}: ${diagnostic.message}`).join('\n'));
  }
  const runtimes = new Map<BufferId, BufferRuntime>();
  const directoryReads = new Map<string, AbortController>();
  let projectIndexRead: AbortController | undefined;
  const createId = options.createBufferId ?? randomUUID;
  let disposed = false;
  let recoveryTimer: NodeJS.Timeout | undefined;
  let recoveryWriteQueue = Promise.resolve();
  let applicationRevision = 0;
  const listeners = new Set<(update: VellumApplicationUpdate) => void>();

  const publishApplicationUpdate = (
    reason: VellumApplicationUpdateReason,
    bufferId?: BufferId
  ): void => {
    applicationRevision += 1;
    const update = Object.freeze({
      revision: applicationRevision,
      reason,
      ...(bufferId === undefined ? {} : { bufferId })
    });
    for (const listener of listeners) listener(update);
  };

  const publishFailure = (
    reason: Extract<VellumApplicationUpdateReason, 'recoveryFailure' | 'backgroundFailure'>,
    error: unknown,
    bufferId?: BufferId
  ): void => {
    state = Object.freeze({
      ...state,
      notice: Object.freeze({ status: 'error', message: error instanceof Error ? error.message : String(error) })
    });
    publishApplicationUpdate(reason, bufferId);
  };

  const writeRecovery = async (): Promise<void> => {
    const recoveryStore = options.recoveryStore;
    if (recoveryStore === undefined) return;
    const snapshot = state;
    const operation = recoveryWriteQueue.then(() => recoveryStore.write(snapshot));
    recoveryWriteQueue = operation.catch(() => undefined);
    try {
      await operation;
    } catch (error) {
      if (!disposed) publishFailure('recoveryFailure', error);
      throw error;
    }
  };

  const scheduleRecovery = (): void => {
    if (options.recoveryStore === undefined) return;
    if (recoveryTimer !== undefined) clearTimeout(recoveryTimer);
    recoveryTimer = setTimeout(() => {
      recoveryTimer = undefined;
      void writeRecovery().catch(() => undefined);
    }, options.recoveryDelayMilliseconds ?? 500);
    recoveryTimer.unref();
  };

  const refreshProjectIndex = async (): Promise<void> => {
    projectIndexRead?.abort();
    const controller = new AbortController();
    projectIndexRead = controller;
    const snapshot = state.project.fileTree;
    try {
      const files = await indexProjectFiles(snapshot, controller.signal);
      if (projectIndexRead !== controller || state.project.fileTree.rootIds[0] !== snapshot.rootIds[0]) return;
      state = Object.freeze({
        ...state,
        project: Object.freeze({
          ...state.project,
          fileTree: commitIndexedFiles(state.project.fileTree, files)
        })
      });
    } finally {
      if (projectIndexRead === controller) projectIndexRead = undefined;
    }
  };

  const assertActive = (): void => {
    if (disposed) throw new Error('The Vellum application instance has been disposed.');
  };

  const createRuntime = (parser: BufferParser): BufferRuntime => ({
    parser,
    watcher: undefined,
    pending: new Set(),
    previewLayouts: createPreviewLayoutCache(),
    highlighter: createCodeHighlighter(
      options.highlightLanguages ?? builtInCodeHighlightLanguages(),
      options.highlightSettings
    ),
    mathRenderer: createMathRenderer(),
    diagramRenderers: createDiagramRendererRegistry(options.diagramRenderers ?? []),
    imageLoader: createMarkdownImageLoader(options.imageSettings),
    highlightedCode: new Map(),
    mathText: new Map(),
    diagramText: new Map(),
    images: new Map(),
    resourceRevision: undefined,
    activeResourceRevisions: new Set(),
    resourceRefreshWaiters: [],
    lastPreviewLayout: undefined,
    hybridDecorations: undefined,
  });

  const schedulePreviewResources = (bufferId: BufferId): void => {
    queueMicrotask(() => {
      void api.refreshPreviewResources(bufferId).catch((error) => {
        if (error instanceof Error && error.name === 'AbortError') return;
        if (state.project.buffers[bufferId] === undefined) return;
        publishFailure('backgroundFailure', error, bufferId);
      });
    });
  };

  const selectionSuggestions = (
    dialog: Extract<NonNullable<AppState['dialogState']>, { kind: 'commandPalette' | 'quickOpen' }>,
    command = dialog.command
  ) => {
    const query = command.editor.input.text;
    const entries = dialog.kind === 'commandPalette'
      ? commandPaletteEntries(state, query).map((entry) => ({
          id: entry.commandId,
          label: entry.title,
          description: `${entry.category}${entry.binding === undefined ? '' : ` · ${entry.binding}`}`,
          disabled: !entry.enabled,
          completion: { range: { startOffset: 0, endOffsetExclusive: query.length }, text: entry.commandId }
        }))
      : quickOpenEntries(state.project.fileTree, query, state.project.recentlyOpenedPaths).map((entry) => ({
          id: entry.path,
          label: entry.relativePath,
          completion: { range: { startOffset: 0, endOffsetExclusive: query.length }, text: entry.path }
        }));
    return commandInputReducer(command, { kind: 'setSuggestions', suggestions: createCommandSuggestions(entries) });
  };

  const refreshSelectionDialog = (): void => {
    const dialog = state.dialogState;
    if (dialog?.kind !== 'commandPalette' && dialog?.kind !== 'quickOpen') return;
    state = Object.freeze({
      ...state,
      dialogState: Object.freeze({ ...dialog, command: selectionSuggestions(dialog) })
    });
  };

  const refreshDocumentSearch = (): void => {
    const dialog = state.dialogState;
    const buffer = activeBuffer(state);
    const runtime = buffer === undefined ? undefined : runtimes.get(buffer.id);
    if (dialog?.kind !== 'documentSearch' || buffer === undefined || runtime === undefined) return;
    const selection = dialog.selectionOnly ? dialog.selectionSpan : undefined;
    const options: DocumentSearchOptions = {
      regularExpression: dialog.regularExpression,
      caseSensitive: dialog.caseSensitive,
      wholeWord: dialog.wholeWord,
      ...(selection === undefined ? {} : { selection })
    };
    const result = findDocumentMatches(
      runtime.parser.source(),
      dialog.query.editor.input.text,
      options,
      dialog.replacement?.editor.input.text
    );
    const matches = Object.freeze(result.matches.map((match) => Object.freeze({ start: match.start, end: match.end })));
    const selectedIndex = matches.length === 0 || dialog.selectedIndex === undefined
      ? undefined
      : Math.max(0, Math.min(dialog.selectedIndex, matches.length - 1));
    const next = { ...dialog, matches };
    delete next.selectedIndex;
    delete next.error;
    state = Object.freeze({
      ...state,
      dialogState: Object.freeze({
        ...next,
        ...(selectedIndex === undefined ? {} : { selectedIndex }),
        ...(result.error === undefined ? {} : { error: result.error })
      })
    });
  };

  const refreshOutline = (): void => {
    const dialog = state.dialogState;
    const buffer = activeBuffer(state);
    if (dialog?.kind !== 'outline' || buffer?.preview.kind !== 'ready') return;
    const entries = flattenOutlineItems(documentOutline(
      buffer.preview,
      buffer.editor.caret.position.offset,
      dialog.query.editor.input.text
    ));
    const queryText = dialog.query.editor.input.text;
    const suggestions = createCommandSuggestions(entries.map((entry) => ({
      id: `outline-${String(entry.nodeId)}`,
      label: `${'  '.repeat(Math.max(0, entry.depth - 1))}${entry.title}`,
      description: entry.active ? `Level ${String(entry.depth)} · active heading` : `Level ${String(entry.depth)}`,
      completion: { range: { startOffset: 0, endOffsetExclusive: queryText.length }, text: String(entry.nodeId) }
    })));
    state = Object.freeze({
      ...state,
      dialogState: Object.freeze({
        ...dialog, entries,
        query: commandInputReducer(dialog.query, { kind: 'setSuggestions', suggestions })
      })
    });
  };

  const refreshExportDialog = (): void => {
    const dialog = state.dialogState;
    if (dialog?.kind !== 'exportProfile') return;
    const query = dialog.command.editor.input.text;
    const normalized = query.trim().toLowerCase();
    const suggestions = createCommandSuggestions(exportProfiles
      .filter((profile) => normalized.length === 0 || profile.id.includes(normalized) || profile.label.toLowerCase().includes(normalized))
      .map((profile) => ({
        id: `export-profile-${profile.id}`,
        label: profile.label,
        description: profile.targetFormat,
        completion: { range: { startOffset: 0, endOffsetExclusive: query.length }, text: profile.id }
      })));
    state = Object.freeze({
      ...state,
      dialogState: Object.freeze({
        ...dialog,
        command: commandInputReducer(dialog.command, { kind: 'setSuggestions', suggestions })
      })
    });
  };

  const addBuffer = (input: {
    readonly source: string;
    readonly label: string;
    readonly path?: string;
    readonly format: FileFormat;
    readonly sourceRevision: number;
    readonly savedRevision: number;
    readonly externalFileState: ExternalFileState;
    readonly editor?: TextAreaState;
    readonly previewScroll?: ScrollState;
  }): BufferId => {
    const id = createId();
    if (state.project.buffers[id] !== undefined) throw new Error(`Duplicate buffer identifier: ${id}`);
    if ((input.path === undefined) !== (input.externalFileState.kind === 'untracked')) {
      throw new Error('A buffer path and its external file state must describe the same source document.');
    }
    if (input.editor !== undefined && textDocumentText(input.editor.document) !== input.source) {
      throw new Error('A restored editor must contain the buffer source document.');
    }
    const parser = createBufferParser(input.source, input.sourceRevision, options.parseOptions);
    const buffer: BufferState = Object.freeze({
      id,
      ...(input.path === undefined ? {} : { path: input.path }),
      label: input.label,
      editor: input.editor ?? createTextAreaState({ value: input.source }),
      sourceRevision: input.sourceRevision,
      savedRevision: input.savedRevision,
      preview: parser.preview(),
      previewResourceRevision: 0,
      previewScroll: input.previewScroll ?? createScrollState(),
      externalFileState: input.externalFileState,
      format: input.format
    });
    runtimes.set(id, createRuntime(parser));
    state = Object.freeze({
      ...state,
      project: Object.freeze({
        ...state.project,
        buffers: Object.freeze({ ...state.project.buffers, [id]: buffer }),
        bufferOrder: Object.freeze([...state.project.bufferOrder, id]),
        activeBufferId: id,
        ...(input.path === undefined ? {} : {
          recentlyOpenedPaths: Object.freeze([
            input.path,
            ...state.project.recentlyOpenedPaths.filter((value) => value !== input.path)
          ].slice(0, 100))
        })
      })
    });
    if (input.path !== undefined && options.watchFiles !== false) attachWatcher(id, input.path);
    schedulePreviewResources(id);
    scheduleRecovery();
    return id;
  };

  const replaceBuffer = (buffer: BufferState): void => {
    if (state.project.buffers[buffer.id] === undefined) return;
    state = Object.freeze({
      ...state,
      project: Object.freeze({
        ...state.project,
        buffers: Object.freeze({ ...state.project.buffers, [buffer.id]: Object.freeze(buffer) })
      })
    });
  };

  const commitPreviewResource = (
    bufferId: BufferId,
    sourceRevision: number,
    nodeId: number,
    topLevelNodeId: number | undefined,
    completion: PreviewResourceCompletion,
    controller: AbortController
  ): boolean => {
    const buffer = state.project.buffers[bufferId];
    const runtime = runtimes.get(bufferId);
    if (controller.signal.aborted
      || buffer === undefined
      || runtime === undefined
      || buffer.sourceRevision !== sourceRevision) return false;
    switch (completion.kind) {
      case 'highlight':
        runtime.highlightedCode.set(nodeId, completion.value);
        break;
      case 'math':
        runtime.mathText.set(nodeId, completion.value);
        break;
      case 'image':
        runtime.images.set(nodeId, completion.value);
        break;
      case 'diagram':
        runtime.diagramText.set(nodeId, completion.text);
        if (completion.image !== undefined) runtime.images.set(nodeId, completion.image);
        break;
    }
    if (topLevelNodeId !== undefined) runtime.previewLayouts.delete(topLevelNodeId);
    replaceBuffer(Object.freeze({
      ...buffer,
      previewResourceRevision: buffer.previewResourceRevision + 1
    }));
    publishApplicationUpdate('previewResource', bufferId);
    return true;
  };

  const attachWatcher = (bufferId: BufferId, filePath: string): void => {
    const runtime = runtimes.get(bufferId);
    if (runtime === undefined) return;
    runtime.watcher?.close();
    try {
      runtime.watcher = watch(filePath, { persistent: false }, () => {
        void api.checkExternalFile(bufferId)
          .then((changed) => {
            if (changed && state.project.buffers[bufferId] !== undefined) {
              publishApplicationUpdate('externalFileRevision', bufferId);
            }
          })
          .catch((error: unknown) => {
            if (state.project.buffers[bufferId] !== undefined) publishFailure('backgroundFailure', error, bufferId);
          });
      });
    } catch {
      runtime.watcher = undefined;
    }
  };

  const releaseBuffer = (bufferId: BufferId): void => {
    const runtime = runtimes.get(bufferId);
    if (runtime === undefined) return;
    runtime.watcher?.close();
    for (const controller of runtime.pending) controller.abort();
    runtime.pending.clear();
    runtime.previewLayouts.clear();
    runtime.highlighter.clear();
    runtime.mathRenderer.clear();
    runtime.diagramRenderers.clear();
    runtime.imageLoader.clear();
    runtime.highlightedCode.clear();
    runtime.mathText.clear();
    runtime.diagramText.clear();
    runtime.images.clear();
    runtimes.delete(bufferId);
  };

  const resetSessionScopedPreviewCaches = (runtime: BufferRuntime): void => {
    for (const controller of runtime.pending) controller.abort();
    runtime.pending.clear();
    runtime.previewLayouts.clear();
    runtime.highlightedCode.clear();
    runtime.mathText.clear();
    runtime.diagramText.clear();
    runtime.images.clear();
    runtime.resourceRevision = undefined;
    runtime.lastPreviewLayout = undefined;
    runtime.hybridDecorations = undefined;
  };

  const closeBuffer = (bufferId: BufferId): void => {
    const buffer = state.project.buffers[bufferId];
    if (buffer === undefined) return;
    const record: ClosedBufferRecord = Object.freeze({
      ...(buffer.path === undefined ? {} : { path: buffer.path }),
      label: buffer.label,
      editor: buffer.editor,
      sourceRevision: buffer.sourceRevision,
      savedRevision: buffer.savedRevision,
      previewScroll: buffer.previewScroll,
      externalFileState: buffer.externalFileState,
      format: buffer.format
    });
    const buffers = { ...state.project.buffers };
    delete buffers[bufferId];
    const order = state.project.bufferOrder.filter((id) => id !== bufferId);
    const oldIndex = state.project.bufferOrder.indexOf(bufferId);
    const activeBufferId = state.project.activeBufferId === bufferId
      ? order[Math.min(Math.max(0, oldIndex), Math.max(0, order.length - 1))]
      : state.project.activeBufferId;
    const project = {
      ...state.project,
      buffers: Object.freeze(buffers),
      bufferOrder: Object.freeze(order),
      recentlyClosed: Object.freeze([record, ...state.project.recentlyClosed].slice(0, 20))
    };
    if (activeBufferId === undefined) delete project.activeBufferId;
    else project.activeBufferId = activeBufferId;
    const navigation = state.commandState.navigation;
    state = clearDialog(Object.freeze({
      ...state,
      project: Object.freeze(project),
      commandState: Object.freeze({
        ...state.commandState,
        navigation: Object.freeze({
          back: Object.freeze(navigation.back.filter((entry) => entry.bufferId !== bufferId)),
          forward: Object.freeze(navigation.forward.filter((entry) => entry.bufferId !== bufferId))
        })
      })
    }));
    releaseBuffer(bufferId);
    scheduleRecovery();
  };

  const applyTransition = (
    bufferId: BufferId,
    transition: TextAreaTransition,
    caretOffset?: number
  ): void => {
    const buffer = state.project.buffers[bufferId];
    const runtime = runtimes.get(bufferId);
    if (buffer === undefined || runtime === undefined) return;
    const reduction = textAreaReducer(buffer.editor, transition);
    let editor = reduction.state;
    if (caretOffset !== undefined) {
      editor = textAreaReducer(editor, {
        kind: 'pointer',
        transition: { kind: 'placeCaret', offset: caretOffset }
      }).state;
    }
    if (reduction.changeSet.changes.length === 0) {
      if (editor !== buffer.editor) {
        const nextBuffer = Object.freeze({ ...buffer, editor });
        replaceBuffer(nextBuffer);
        if (!hybridDecorationCacheMatches(runtime.hybridDecorations, nextBuffer)) {
          runtime.hybridDecorations = undefined;
        }
      }
      return;
    }
    const sourceRevision = buffer.sourceRevision + 1;
    const preview = runtime.parser.applyChanges(reduction.changeSet, sourceRevision);
    if (buffer.preview.kind !== 'ready'
      || preview.kind !== 'ready'
      || preview.identity !== buffer.preview.identity) {
      resetSessionScopedPreviewCaches(runtime);
    } else {
      runtime.lastPreviewLayout = undefined;
    }
    const nextBuffer = Object.freeze({
      ...buffer,
      editor,
      sourceRevision,
      preview
    });
    replaceBuffer(nextBuffer);
    const dialog = state.dialogState;
    if (dialog?.kind === 'documentSearch' && dialog.selectionOnly && dialog.selectionSpan !== undefined) {
      state = Object.freeze({
        ...state,
        dialogState: Object.freeze({
          ...dialog,
          selectionSpan: mapSearchSelection(dialog.selectionSpan, reduction.changeSet)
        })
      });
    }
    runtime.hybridDecorations = undefined;
    schedulePreviewResources(bufferId);
    scheduleRecovery();
  };

  const synchronizedEditorMap = (
    bufferId: BufferId,
    synchronization: SynchronizedPaneGeometry,
  ): RowOffsetMap | undefined => {
    const buffer = state.project.buffers[bufferId];
    if (buffer === undefined) return undefined;
    const decorations = state.editorMode === 'hybrid' ? api.hybridDecorations(bufferId) : undefined;
    return createTextAreaRowOffsetMap({
      document: buffer.editor.document,
      terminalWidth: synchronization.editor.width,
      terminalRows: synchronization.editor.rows,
      widthProfile: synchronization.widthProfile,
      ...(decorations === undefined ? {} : { decorations }),
      lineNumbers: { minWidth: 3 },
      wrap: { mode: 'soft' },
      scrollbar: { visible: 'auto' },
    });
  };

  const synchronizeEditorViewport = (
    bufferId: BufferId,
    synchronization: SynchronizedPaneGeometry,
  ): void => {
    let buffer = state.project.buffers[bufferId];
    const editorMap = synchronizedEditorMap(bufferId, synchronization);
    if (buffer === undefined || editorMap === undefined) return;
    let editor = buffer.editor;
    if (editor.revealCaret) {
      const nextState = scrollReducer(editor.scroll, {
        kind: 'itemIntoView',
        itemIndex: editorMap.rowAtSourceOffset(editor.caret.position.offset),
        alignment: 'nearest',
      }, rowMapScrollGeometry(editorMap, synchronization.editor.rows));
      editor = textAreaReducer(editor, {
        kind: 'scroll',
        request: { nextState, source: 'focus', target: 'content' },
      }).state;
    } else {
      const nextState = scrollReducer(
        editor.scroll,
        { kind: 'setOffset' },
        rowMapScrollGeometry(editorMap, synchronization.editor.rows),
      );
      if (nextState !== editor.scroll) {
        editor = textAreaReducer(editor, {
          kind: 'scroll',
          request: { nextState, source: 'focus', target: 'content' },
        }).state;
      }
    }
    const previewMap = api.previewViewportLayout(
      bufferId,
      synchronization.preview.width,
      synchronization.preview.rows,
      markdownTheme,
      synchronization.widthProfile,
    )?.rowOffsetMap;
    buffer = state.project.buffers[bufferId];
    if (buffer === undefined) return;
    const previewScroll = previewMap === undefined
      ? buffer.previewScroll
      : synchronizePaneScroll(
          editor.scroll,
          { map: editorMap, viewportRows: synchronization.editor.rows },
          buffer.previewScroll,
          { map: previewMap, viewportRows: synchronization.preview.rows },
        );
    if (editor !== buffer.editor || previewScroll !== buffer.previewScroll) {
      replaceBuffer({ ...buffer, editor, previewScroll });
    }
  };

  const api: VellumApplication = {
    state: () => state,
    subscribe(listener) {
      assertActive();
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    newBuffer(label = 'untitled.md', source = '') {
      assertActive();
      const sourceRevision = source.length === 0 ? 0 : 1;
      return addBuffer({
        source, label, format: defaultFormat, sourceRevision, savedRevision: 0,
        externalFileState: Object.freeze({ kind: 'untracked' })
      });
    },
    openSource(source, label = 'standard-input.md') {
      assertActive();
      const sourceRevision = source.length === 0 ? 0 : 1;
      return addBuffer({
        source, label, format: defaultFormat, sourceRevision, savedRevision: 0,
        externalFileState: Object.freeze({ kind: 'untracked' })
      });
    },
    async openFile(filePath, signal) {
      assertActive();
      const file = await readSourceFile(filePath, signal);
      assertActive();
      const existing = Object.values(state.project.buffers).find((buffer) => {
        const external = buffer.externalFileState;
        return buffer.path === file.path
          || (external.kind === 'current' && external.fingerprint.realPath === file.realPath)
          || (external.kind === 'conflict' && external.disk.realPath === file.realPath);
      });
      if (existing !== undefined) {
        api.activateBuffer(existing.id);
        const existingFingerprint = existing.externalFileState.kind === 'untracked'
          ? undefined
          : externalFileStateFingerprint(existing.externalFileState);
        if (existingFingerprint === undefined || !sameExternalFileRevision(existingFingerprint, file.fingerprint)) {
          await api.checkExternalFile(existing.id);
        }
        return existing.id;
      }
      return addBuffer({
        source: file.source,
        path: file.path,
        label: file.label,
        format: file.format,
        sourceRevision: 0,
        savedRevision: 0,
        externalFileState: Object.freeze({ kind: 'current', fingerprint: file.fingerprint })
      });
    },
    async openProjectDirectory(directoryPath, signal) {
      assertActive();
      signal?.throwIfAborted();
      const exact = path.resolve(directoryPath);
      const resolved = await realpath(exact);
      assertActive();
      if (!(await stat(resolved)).isDirectory()) throw new Error(`The project directory is not a directory: ${exact}`);
      for (const controller of directoryReads.values()) controller.abort();
      directoryReads.clear();
      projectIndexRead?.abort();
      state = Object.freeze({
        ...state,
        project: Object.freeze({
          ...state.project,
          rootDirectory: exact,
          fileTree: createFileTreeState(exact, state.project.fileTree.exclusionPatterns)
        })
      });
      await Promise.all([api.loadFileTreeDirectory(exact), refreshProjectIndex()]);
    },
    async loadFileTreeDirectory(directoryId) {
      assertActive();
      directoryReads.get(directoryId)?.abort();
      const controller = new AbortController();
      directoryReads.set(directoryId, controller);
      const snapshot = state.project.fileTree;
      state = Object.freeze({
        ...state,
        project: Object.freeze({ ...state.project, fileTree: markDirectoryLoading(snapshot, directoryId) })
      });
      try {
        const children = await readDirectoryNodes(snapshot, directoryId, controller.signal);
        if (directoryReads.get(directoryId) !== controller) return;
        state = Object.freeze({
          ...state,
          project: Object.freeze({
            ...state.project,
            fileTree: commitDirectoryNodes(state.project.fileTree, directoryId, children)
          })
        });
      } catch (error) {
        if (directoryReads.get(directoryId) === controller) {
          state = Object.freeze({
            ...state,
            project: Object.freeze({
              ...state.project,
              fileTree: clearDirectoryLoading(state.project.fileTree, directoryId)
            })
          });
        }
        throw error;
      } finally {
        if (directoryReads.get(directoryId) === controller) directoryReads.delete(directoryId);
      }
    },
    async refreshFileTree() {
      const root = state.project.rootDirectory;
      if (root === undefined) return;
      await Promise.all([api.loadFileTreeDirectory(root), refreshProjectIndex()]);
    },
    activateBuffer(bufferId) {
      assertActive();
      if (state.project.buffers[bufferId] === undefined || state.project.activeBufferId === bufferId) return;
      state = Object.freeze({
        ...state,
        project: Object.freeze({ ...state.project, activeBufferId: bufferId })
      });
    },
    async applyFileTreeTransition(transition) {
      assertActive();
      const next = reduceFileTree(state.project.fileTree, transition);
      state = Object.freeze({
        ...state,
        project: Object.freeze({ ...state.project, fileTree: next })
      });
      const activeId = next.activeId;
      if (activeId !== undefined && next.expandedIds.includes(activeId)) {
        const node = next.nodes[activeId];
        if (node?.kind === 'directory' && !node.loaded && !node.loading) await api.loadFileTreeDirectory(activeId);
      }
    },
    async activateFileTreeNode(nodeId) {
      const node = state.project.fileTree.nodes[nodeId];
      if (node === undefined) return;
      if (node.kind === 'file') {
        await api.openFile(node.path);
      } else {
        await api.applyFileTreeTransition({ kind: 'toggle', id: nodeId });
      }
    },
    dispatchCommand(commandId) {
      assertActive();
      const update = reduceCommand(state, commandId);
      state = update.state;
      for (const effect of update.effects) {
        if (effect.kind === 'newFile') api.newBuffer();
        else if (effect.kind === 'reopenClosed') api.reopenRecentlyClosed();
        else if (effect.kind === 'closeBuffer' && state.project.activeBufferId !== undefined) {
          api.requestCloseBuffer(state.project.activeBufferId);
        } else if (effect.kind === 'textEdit' && state.project.activeBufferId !== undefined) {
          api.executeMarkdownCommand(state.project.activeBufferId, effect.commandId);
        } else if (effect.kind === 'navigate') {
          executeNavigationEffect(api, effect.commandId);
        }
      }
      refreshSelectionDialog();
      refreshOutline();
      refreshExportDialog();
      return Object.freeze({ state, effects: update.effects });
    },
    updateFilePathDialog(transition) {
      const dialog = state.dialogState;
      if (dialog?.kind !== 'filePath') return;
      state = Object.freeze({
        ...state,
        dialogState: Object.freeze({
          ...dialog,
          command: commandInputReducer(dialog.command, transition)
        })
      });
    },
    async submitFilePathDialog(value) {
      const dialog = state.dialogState;
      if (dialog?.kind !== 'filePath') return false;
      const entered = value ?? dialog.command.editor.input.text;
      if (entered.trim().length === 0) {
        state = Object.freeze({
          ...state,
          dialogState: Object.freeze({ ...dialog, error: 'Enter a path.' })
        });
        return false;
      }
      try {
        if (dialog.operation === 'openFile') await api.openFile(entered);
        else if (dialog.operation === 'openProjectDirectory') await api.openProjectDirectory(entered);
        else {
          const id = dialog.afterSave?.kind === 'closeBuffer'
            ? dialog.afterSave.bufferId
            : dialog.afterSave?.kind === 'closeApplication' || dialog.afterSave?.kind === 'saveAll'
              ? dialog.afterSave.bufferIds.find((bufferId) => state.project.buffers[bufferId]?.path === undefined)
              : state.project.activeBufferId;
          if (id !== undefined && !await api.saveBuffer(id, entered)) return false;
        }
        if (dialog.afterSave?.kind === 'closeBuffer') {
          closeBuffer(dialog.afterSave.bufferId);
          await api.persistRecoveryRecord();
        } else if (dialog.afterSave?.kind === 'closeApplication') {
          const remaining = dialog.afterSave.bufferIds.filter((bufferId) => {
            const buffer = state.project.buffers[bufferId];
            return buffer !== undefined && bufferIsDirty(buffer);
          });
          const nextUnsaved = remaining.find((bufferId) => state.project.buffers[bufferId]?.path === undefined);
          if (nextUnsaved !== undefined) {
            state = Object.freeze({
              ...state,
              project: Object.freeze({ ...state.project, activeBufferId: nextUnsaved }),
              dialogState: saveAsDialog(Object.freeze({ kind: 'closeApplication', bufferIds: Object.freeze(remaining) }))
            });
            return false;
          }
          state = clearDialog(state);
          if (!await api.saveAll()) return false;
          for (const bufferId of [...state.project.bufferOrder]) closeBuffer(bufferId);
          await api.persistRecoveryRecord();
          return true;
        } else if (dialog.afterSave?.kind === 'saveAll') {
          const remaining = dialog.afterSave.bufferIds.filter((bufferId) => {
            const buffer = state.project.buffers[bufferId];
            return buffer !== undefined && bufferIsDirty(buffer);
          });
          const nextUnsaved = remaining.find((bufferId) => state.project.buffers[bufferId]?.path === undefined);
          if (nextUnsaved !== undefined) {
            state = Object.freeze({
              ...state,
              project: Object.freeze({ ...state.project, activeBufferId: nextUnsaved }),
              dialogState: saveAsDialog(Object.freeze({ kind: 'saveAll', bufferIds: Object.freeze(remaining) }))
            });
            return false;
          }
          state = clearDialog(state);
          await api.saveAll();
        } else {
          state = clearDialog(state);
        }
      } catch (error) {
        state = Object.freeze({
          ...state,
          dialogState: Object.freeze({
            ...dialog,
            error: error instanceof Error ? error.message : String(error)
          })
        });
      }
      return false;
    },
    updateSelectionDialog(transition) {
      const dialog = state.dialogState;
      if (dialog?.kind !== 'commandPalette' && dialog?.kind !== 'quickOpen') return;
      const nextCommand = commandInputReducer(dialog.command, transition);
      const withoutError = { ...dialog, command: nextCommand };
      delete withoutError.error;
      const nextDialog = Object.freeze(withoutError);
      state = Object.freeze({ ...state, dialogState: nextDialog });
      state = Object.freeze({
        ...state,
        dialogState: Object.freeze({ ...nextDialog, command: selectionSuggestions(nextDialog) })
      });
    },
    async submitSelectionDialog(value) {
      const dialog = state.dialogState;
      if (dialog?.kind !== 'commandPalette' && dialog?.kind !== 'quickOpen') return;
      if (dialog.kind === 'commandPalette') {
        const candidate = value === undefined ? undefined : commandById(value);
        if (candidate !== undefined && !candidate.enabled(state)) {
          state = Object.freeze({
            ...state,
            dialogState: Object.freeze({ ...dialog, error: 'The selected command is not available in the current context.' })
          });
          return;
        }
        const entry = candidate ?? commandPaletteEntries(state, dialog.command.editor.input.text).find((item) => item.enabled);
        if (entry === undefined) {
          state = Object.freeze({ ...state, dialogState: Object.freeze({ ...dialog, error: 'No enabled command matches the query.' }) });
          return;
        }
        const commandId = 'commandId' in entry ? entry.commandId : entry.id;
        state = clearDialog(state);
        api.dispatchCommand(commandId);
        return;
      }
      const paths = indexedFilePaths(state.project.fileTree);
      const candidate = value !== undefined && paths.includes(value)
        ? value
        : quickOpenEntries(state.project.fileTree, dialog.command.editor.input.text, state.project.recentlyOpenedPaths)[0]?.path;
      if (candidate === undefined) {
        state = Object.freeze({ ...state, dialogState: Object.freeze({ ...dialog, error: 'No file matches the query.' }) });
        return;
      }
      try {
        await api.openFile(candidate);
        state = clearDialog(state);
      } catch (error) {
        state = Object.freeze({
          ...state,
          dialogState: Object.freeze({ ...dialog, error: error instanceof Error ? error.message : String(error) })
        });
      }
    },
    updateDocumentSearch(field, transition) {
      const dialog = state.dialogState;
      if (dialog?.kind !== 'documentSearch') return;
      if (field === 'replacement' && dialog.replacement === undefined) return;
      const command = commandInputReducer(field === 'query' ? dialog.query : dialog.replacement as NonNullable<typeof dialog.replacement>, transition);
      state = Object.freeze({
        ...state,
        dialogState: Object.freeze({ ...dialog, [field]: command })
      });
      refreshDocumentSearch();
    },
    configureDocumentSearch(option) {
      const dialog = state.dialogState;
      if (dialog?.kind !== 'documentSearch') return;
      if (option === 'selectionOnly') {
        if (dialog.selectionOnly) {
          const next = { ...dialog, selectionOnly: false };
          delete next.selectionSpan;
          state = Object.freeze({ ...state, dialogState: Object.freeze(next) });
        } else {
          const buffer = activeBuffer(state);
          const selection = buffer?.editor.selection;
          const start = selection === undefined ? 0 : Math.min(selection.anchor.offset, selection.focus.offset);
          const end = selection === undefined ? 0 : Math.max(selection.anchor.offset, selection.focus.offset);
          if (selection === undefined || start === end) {
            state = Object.freeze({
              ...state,
              dialogState: Object.freeze({ ...dialog, error: 'Select a nonempty source range before enabling selection-only search.' })
            });
            return;
          }
          state = Object.freeze({
            ...state,
            dialogState: Object.freeze({ ...dialog, selectionOnly: true, selectionSpan: Object.freeze({ start, end }) })
          });
        }
      } else {
        state = Object.freeze({ ...state, dialogState: Object.freeze({ ...dialog, [option]: !dialog[option] }) });
      }
      refreshDocumentSearch();
    },
    navigateDocumentSearch(direction) {
      const dialog = state.dialogState;
      const buffer = activeBuffer(state);
      if (dialog?.kind !== 'documentSearch' || buffer === undefined) return;
      const selectedIndex = dialog.matches.length === 0
        ? undefined
        : dialog.selectedIndex === undefined
          ? direction === 'next' ? 0 : dialog.matches.length - 1
          : (dialog.selectedIndex + (direction === 'next' ? 1 : -1) + dialog.matches.length) % dialog.matches.length;
      const match = selectedIndex === undefined ? undefined : dialog.matches[selectedIndex];
      if (match === undefined || selectedIndex === undefined) return;
      api.navigateTo(buffer.id, match.start);
      applyTransition(buffer.id, {
        kind: 'pointer', transition: { kind: 'endSelection', anchor: match.start, offset: match.end }
      });
      const current = state.dialogState;
      if (current?.kind === 'documentSearch') state = Object.freeze({ ...state, dialogState: Object.freeze({ ...current, selectedIndex }) });
    },
    replaceDocumentSearch(scope) {
      const dialog = state.dialogState;
      const buffer = activeBuffer(state);
      const runtime = buffer === undefined ? undefined : runtimes.get(buffer.id);
      if (dialog?.kind !== 'documentSearch' || dialog.replacement === undefined || buffer === undefined || runtime === undefined) return;
      const selection = dialog.selectionOnly ? dialog.selectionSpan : undefined;
      const found = findDocumentMatches(runtime.parser.source(), dialog.query.editor.input.text, {
        regularExpression: dialog.regularExpression,
        caseSensitive: dialog.caseSensitive,
        wholeWord: dialog.wholeWord,
        ...(selection === undefined ? {} : { selection })
      }, dialog.replacement.editor.input.text);
      if (found.error !== undefined) {
        state = Object.freeze({ ...state, dialogState: Object.freeze({ ...dialog, error: found.error }) });
        return;
      }
      const changes = replacementChangeSet(found, scope === 'all' ? undefined : dialog.selectedIndex ?? 0);
      applyTransition(buffer.id, { kind: 'applyChanges', changeSet: changes });
      refreshDocumentSearch();
    },
    updateProjectDirectorySearch(transition) {
      const dialog = state.dialogState;
      if (dialog?.kind !== 'projectDirectorySearch') return;
      const query = commandInputReducer(dialog.query, transition);
      state = Object.freeze({ ...state, dialogState: Object.freeze({ ...dialog, query }) });
    },
    async runProjectDirectorySearch(searchOptions = {}, signal = new AbortController().signal) {
      const dialog = state.dialogState;
      if (dialog?.kind !== 'projectDirectorySearch') return;
      const query = dialog.query.editor.input.text;
      const indexedFiles = state.project.fileTree.indexedFiles;
      state = Object.freeze({ ...state, dialogState: Object.freeze({ ...dialog, searching: true, results: Object.freeze([]) }) });
      try {
        const results = await searchProjectDirectory(state.project.fileTree, query, searchOptions, signal);
        if (state.dialogState?.kind !== 'projectDirectorySearch') return;
        if (state.dialogState.query.editor.input.text !== query || state.project.fileTree.indexedFiles !== indexedFiles) {
          state = Object.freeze({
            ...state,
            dialogState: Object.freeze({ ...state.dialogState, searching: false, results: Object.freeze([]) })
          });
          return;
        }
        const queryText = state.dialogState.query.editor.input.text;
        const suggestions = createCommandSuggestions(results.map((result, index) => ({
          id: `project-result-${String(index)}`,
          label: `${path.relative(state.project.rootDirectory ?? '', result.path)}:${String(result.line)}:${String(result.column)}`,
          description: result.context,
          completion: { range: { startOffset: 0, endOffsetExclusive: queryText.length }, text: String(index) }
        })));
        state = Object.freeze({
          ...state,
          dialogState: Object.freeze({
            ...state.dialogState, searching: false, results,
            query: commandInputReducer(state.dialogState.query, { kind: 'setSuggestions', suggestions })
          })
        });
      } catch (error) {
        if (signal.aborted) throw error;
        if (state.dialogState?.kind !== 'projectDirectorySearch') return;
        state = Object.freeze({
          ...state,
          dialogState: Object.freeze({
            ...state.dialogState, searching: false,
            error: error instanceof Error ? error.message : String(error)
          })
        });
      }
    },
    async submitProjectDirectorySearch(value, signal) {
      const dialog = state.dialogState;
      if (dialog?.kind !== 'projectDirectorySearch') return;
      const index = value === undefined || !/^\d+$/u.test(value) ? undefined : Number(value);
      if (index !== undefined && dialog.results[index] !== undefined) {
        await api.activateProjectDirectorySearchResult(index);
        return;
      }
      await api.runProjectDirectorySearch({}, signal);
    },
    async activateProjectDirectorySearchResult(index) {
      const dialog = state.dialogState;
      const result = dialog?.kind === 'projectDirectorySearch' ? dialog.results[index] : undefined;
      if (result === undefined) return;
      const id = await api.openFile(result.path);
      state = clearDialog(state);
      api.navigateTo(id, result.span.start);
      applyTransition(id, {
        kind: 'pointer', transition: { kind: 'endSelection', anchor: result.span.start, offset: result.span.end }
      });
    },
    updateOutline(transition) {
      const dialog = state.dialogState;
      if (dialog?.kind !== 'outline') return;
      state = Object.freeze({
        ...state,
        dialogState: Object.freeze({ ...dialog, query: commandInputReducer(dialog.query, transition) })
      });
      refreshOutline();
    },
    submitOutline(value) {
      const dialog = state.dialogState;
      if (dialog?.kind !== 'outline') return;
      const nodeId = value !== undefined && /^\d+$/u.test(value) ? Number(value) : dialog.entries[0]?.nodeId;
      const entry = dialog.entries.find((candidate) => candidate.nodeId === nodeId);
      const buffer = activeBuffer(state);
      if (entry === undefined || buffer === undefined) return;
      state = clearDialog(state);
      api.navigateTo(buffer.id, entry.sourceOffset);
    },
    updateGoToLine(transition) {
      const dialog = state.dialogState;
      if (dialog?.kind !== 'goToLine') return;
      const next = { ...dialog, command: commandInputReducer(dialog.command, transition) };
      delete next.error;
      state = Object.freeze({ ...state, dialogState: Object.freeze(next) });
    },
    submitGoToLine(value) {
      const dialog = state.dialogState;
      const buffer = activeBuffer(state);
      if (dialog?.kind !== 'goToLine' || buffer?.preview.kind !== 'ready') return;
      const raw = (value ?? dialog.command.editor.input.text).trim();
      const line = Number(raw);
      if (!Number.isSafeInteger(line) || line < 1 || line > buffer.preview.snapshot.document.sourceIndex.lineCount) {
        state = Object.freeze({
          ...state,
          dialogState: Object.freeze({ ...dialog, error: `Enter a line from 1 to ${String(buffer.preview.snapshot.document.sourceIndex.lineCount)}.` })
        });
        return;
      }
      const sourceOffset = buffer.preview.snapshot.document.sourceIndex.lineSpan(line - 1).start;
      state = clearDialog(state);
      api.navigateTo(buffer.id, sourceOffset);
    },
    async activatePreview(bufferId, target, signal) {
      const buffer = state.project.buffers[bufferId];
      if (buffer === undefined) return;
      api.navigateTo(bufferId, target.sourceSpan.start);
      const activation = target.activation;
      if (activation === undefined) return;
      if (activation.kind === 'footnote') {
        api.navigateTo(bufferId, activation.definitionSpan.start);
        return;
      }
      const currentTree = buffer.preview.kind === 'ready' ? buffer.preview.snapshot.document.tree : undefined;
      const resolved = resolveMarkdownLink(activation.destination, buffer.path, currentTree);
      if (resolved.kind === 'external') {
        await (options.openExternalLink ?? openExternalMarkdownLink)(resolved.url, signal);
        return;
      }
      let targetBuffer = resolved.path === undefined
        ? state.project.buffers[bufferId]
        : Object.values(state.project.buffers).find((candidate) => candidate.path !== undefined && path.resolve(candidate.path) === path.resolve(resolved.path as string));
      if (targetBuffer === undefined && resolved.path !== undefined) {
        const targetId = await api.openFile(resolved.path, signal);
        targetBuffer = state.project.buffers[targetId];
      }
      if (targetBuffer === undefined) return;
      const targetTree = targetBuffer.preview.kind === 'ready' ? targetBuffer.preview.snapshot.document.tree : undefined;
      const destination = resolveMarkdownLink(activation.destination, buffer.path, targetTree);
      if (destination.kind === 'source') api.navigateTo(targetBuffer.id, destination.sourceOffset ?? 0);
    },
    updateExportProfile(transition) {
      const dialog = state.dialogState;
      if (dialog?.kind !== 'exportProfile') return;
      const next = { ...dialog, command: commandInputReducer(dialog.command, transition) };
      delete next.error;
      state = Object.freeze({ ...state, dialogState: Object.freeze(next) });
      refreshExportDialog();
    },
    async submitExportProfile(value, signal) {
      const dialog = state.dialogState;
      if (dialog?.kind !== 'exportProfile') return;
      const entered = value ?? dialog.command.editor.input.text;
      const normalized = entered.trim().toLowerCase();
      const profile = exportProfiles.find((candidate) => candidate.id === entered)
        ?? exportProfiles.find((candidate) => candidate.id.includes(normalized) || candidate.label.toLowerCase().includes(normalized));
      if (profile === undefined) {
        state = Object.freeze({ ...state, dialogState: Object.freeze({ ...dialog, error: 'Select an export profile.' }) });
        return;
      }
      try {
        if (dialog.scope === 'activeBuffer') {
          const buffer = activeBuffer(state);
          if (buffer?.path === undefined) throw new Error('Save the active buffer before exporting it.');
          if (bufferIsDirty(buffer)) throw new Error('Save the active buffer before exporting its current source document.');
          await exportSourceDocument(buffer.path, profile, { ...(signal === undefined ? {} : { signal }) });
        } else {
          const root = state.project.rootDirectory;
          if (root === undefined) throw new Error('Open a project directory before exporting it.');
          await exportProjectDirectory(root, profile, { ...(signal === undefined ? {} : { signal }) });
        }
        state = Object.freeze({
          ...clearDialog(state),
          notice: Object.freeze({ status: 'success', message: `Export completed with the ${profile.label} profile.` })
        });
      } catch (error) {
        if (signal?.aborted === true) throw error;
        state = Object.freeze({
          ...state,
          dialogState: Object.freeze({ ...dialog, error: error instanceof Error ? error.message : String(error) })
        });
      }
    },
    dismissDialog() {
      state = clearDialog(state);
    },
    resizeSplitPane(transition) {
      const splitPane = splitPaneReducer(state.splitPane, transition, {
        constraints: Object.freeze([{ minShare: 0.2, maxShare: 0.8 }, { minShare: 0.2, maxShare: 0.8 }])
      });
      if (splitPane !== state.splitPane) state = Object.freeze({ ...state, splitPane });
    },
    resizeTerminal(previous, next, widthProfile) {
      const previousBody = vellumBodyGeometry(state, previous);
      const nextBody = vellumBodyGeometry(state, next);
      const previousPanes = vellumPaneGeometry(state, previousBody.bodyWidth, previousBody.contentRows);
      const nextPanes = vellumPaneGeometry(state, nextBody.bodyWidth, nextBody.contentRows);
      for (const bufferId of state.project.bufferOrder) {
        const buffer = state.project.buffers[bufferId];
        if (buffer === undefined) continue;
        let editor = buffer.editor;
        let previewScroll = buffer.previewScroll;
        if (previousPanes.editor !== undefined && nextPanes.editor !== undefined) {
          const decorations = state.editorMode === 'hybrid' ? api.hybridDecorations(bufferId) : undefined;
          const previousMap = createTextAreaRowOffsetMap({
            document: buffer.editor.document,
            terminalWidth: previousPanes.editor.width,
            terminalRows: previousPanes.editor.rows,
            widthProfile,
            ...(decorations === undefined ? {} : { decorations }),
            lineNumbers: { minWidth: 3 },
            wrap: { mode: 'soft' },
            scrollbar: { visible: 'auto' }
          });
          const nextMap = createTextAreaRowOffsetMap({
            document: buffer.editor.document,
            terminalWidth: nextPanes.editor.width,
            terminalRows: nextPanes.editor.rows,
            widthProfile,
            ...(decorations === undefined ? {} : { decorations }),
            lineNumbers: { minWidth: 3 },
            wrap: { mode: 'soft' },
            scrollbar: { visible: 'auto' }
          });
          editor = Object.freeze({
            ...buffer.editor,
            scroll: synchronizePaneScroll(
              buffer.editor.scroll,
              { map: previousMap, viewportRows: previousPanes.editor.rows },
              buffer.editor.scroll,
              { map: nextMap, viewportRows: nextPanes.editor.rows },
            )
          });
        }
        if (previousPanes.preview !== undefined && nextPanes.preview !== undefined) {
          const previousMap = api.previewViewportLayout(
            bufferId,
            previousPanes.preview.width,
            previousPanes.preview.rows,
            markdownTheme,
            widthProfile
          )?.rowOffsetMap;
          const nextMap = api.previewViewportLayout(
            bufferId,
            nextPanes.preview.width,
            nextPanes.preview.rows,
            markdownTheme,
            widthProfile
          )?.rowOffsetMap;
          if (previousMap !== undefined && nextMap !== undefined) {
            previewScroll = synchronizePaneScroll(
              buffer.previewScroll,
              { map: previousMap, viewportRows: previousPanes.preview.rows },
              buffer.previewScroll,
              { map: nextMap, viewportRows: nextPanes.preview.rows },
            );
          }
        }
        replaceBuffer(Object.freeze({ ...buffer, editor, previewScroll }));
      }
      scheduleRecovery();
    },
    updatePreviewScroll(bufferId, request, synchronization) {
      const buffer = state.project.buffers[bufferId];
      if (buffer === undefined) return;
      if (synchronization === undefined) {
        replaceBuffer({ ...buffer, previewScroll: request.nextState });
        return;
      }
      const editorMap = synchronizedEditorMap(bufferId, synchronization);
      const previewMap = api.previewViewportLayout(
        bufferId,
        synchronization.preview.width,
        synchronization.preview.rows,
        markdownTheme,
        synchronization.widthProfile,
      )?.rowOffsetMap;
      if (editorMap === undefined || previewMap === undefined) return;
      const previewScroll = normalizeScrollState(
        request.nextState,
        rowMapScrollGeometry(previewMap, synchronization.preview.rows),
      );
      const nextState = synchronizePaneScroll(
        previewScroll,
        { map: previewMap, viewportRows: synchronization.preview.rows },
        buffer.editor.scroll,
        { map: editorMap, viewportRows: synchronization.editor.rows },
      );
      const editor = textAreaReducer(buffer.editor, {
        kind: 'scroll',
        request: { nextState, source: request.source, target: 'content' },
      }).state;
      replaceBuffer({ ...buffer, editor, previewScroll });
    },
    applyTextAreaTransition(bufferId, transition, synchronization) {
      assertActive();
      const buffer = state.project.buffers[bufferId];
      const runtime = runtimes.get(bufferId);
      if (buffer === undefined || runtime === undefined) return;
      const automatic = transition.kind === 'edit'
        ? automaticMarkdownTransition(buffer, transition.operation, runtime.parser.source())
        : undefined;
      if (automatic?.action === undefined && automatic?.caretOffset !== undefined) {
        applyTransition(bufferId, {
          kind: 'pointer', transition: { kind: 'placeCaret', offset: automatic.caretOffset }
        });
      } else {
        applyTransition(bufferId, automatic?.action ?? transition, automatic?.caretOffset);
      }
      if (synchronization !== undefined) synchronizeEditorViewport(bufferId, synchronization);
    },
    executeMarkdownCommand(bufferId, commandId, commandOptions) {
      assertActive();
      const buffer = state.project.buffers[bufferId];
      const runtime = runtimes.get(bufferId);
      if (buffer === undefined || runtime === undefined) return;
      const transition = markdownCommandTransition(buffer, commandId, commandOptions, runtime.parser.source());
      if (transition.action !== undefined) applyTransition(bufferId, transition.action, transition.caretOffset);
      else if (transition.caretOffset !== undefined) applyTransition(bufferId, {
        kind: 'pointer',
        transition: { kind: 'placeCaret', offset: transition.caretOffset }
      });
    },
    indentList(bufferId, outdent) {
      const buffer = state.project.buffers[bufferId];
      const runtime = runtimes.get(bufferId);
      if (buffer === undefined || runtime === undefined) return;
      const transition = listIndentTransition(buffer, outdent, runtime.parser.source());
      if (transition.action !== undefined) applyTransition(bufferId, transition.action, transition.caretOffset);
    },
    async saveBuffer(bufferId, destination, overwriteConflict = false, signal) {
      assertActive();
      const snapshot = state.project.buffers[bufferId];
      if (snapshot === undefined) return false;
      const target = destination ?? snapshot.path;
      if (target === undefined) throw new Error('A destination path is required for an unsaved buffer.');
      const savingSamePath = destination === undefined || path.resolve(target) === snapshot.path;
      if (savingSamePath && snapshot.externalFileState.kind === 'conflict' && !overwriteConflict) {
        state = Object.freeze({ ...state, dialogState: Object.freeze({ kind: 'externalConflict', bufferId }) });
        return false;
      }
      const expected = savingSamePath && snapshot.externalFileState.kind === 'current'
        ? snapshot.externalFileState.fingerprint
        : undefined;
      const savedRevision = snapshot.sourceRevision;
      const file = await saveSourceFile(target, textDocumentText(snapshot.editor.document), {
        format: snapshot.format,
        ...(expected === undefined ? {} : { expectedFingerprint: expected }),
        overwriteExisting: overwriteConflict,
        ...(signal === undefined ? {} : { signal })
      });
      assertActive();
      const current = state.project.buffers[bufferId];
      if (current !== undefined) {
        replaceBuffer({
          ...current,
          path: file.path,
          label: file.label,
          savedRevision,
          externalFileState: Object.freeze({ kind: 'current', fingerprint: file.fingerprint }),
          format: file.format
        });
        if (current.path !== file.path) attachWatcher(bufferId, file.path);
      }
      await api.refreshFileTree();
      await api.persistRecoveryRecord();
      return true;
    },
    async saveAll(signal) {
      const dirty = state.project.bufferOrder.filter((bufferId) => {
        const buffer = state.project.buffers[bufferId];
        return buffer !== undefined && bufferIsDirty(buffer);
      });
      const unsaved = dirty.find((bufferId) => state.project.buffers[bufferId]?.path === undefined);
      if (unsaved !== undefined) {
        state = Object.freeze({
          ...state,
          project: Object.freeze({ ...state.project, activeBufferId: unsaved }),
          dialogState: saveAsDialog(Object.freeze({ kind: 'saveAll', bufferIds: Object.freeze(dirty) }))
        });
        return false;
      }
      for (const bufferId of dirty) {
        signal?.throwIfAborted();
        if (!await api.saveBuffer(bufferId, undefined, false, signal)) return false;
      }
      return true;
    },
    requestCloseBuffer(bufferId) {
      const buffer = state.project.buffers[bufferId];
      if (buffer === undefined) return true;
      if (bufferIsDirty(buffer)) {
        state = Object.freeze({
          ...state,
          dialogState: Object.freeze({ kind: 'dirtyBuffer', bufferIds: Object.freeze([bufferId]), closeApplication: false })
        });
        return false;
      }
      closeBuffer(bufferId);
      return true;
    },
    async resolveDirtyBuffer(action, destination) {
      const dialog = state.dialogState;
      if (dialog?.kind !== 'dirtyBuffer' || dialog.closeApplication) return false;
      const bufferId = dialog.bufferIds[0];
      if (bufferId === undefined || action === 'cancel') {
        state = clearDialog(state);
        return false;
      }
      if (action === 'save' && destination === undefined && state.project.buffers[bufferId]?.path === undefined) {
        state = Object.freeze({ ...state, dialogState: saveAsDialog(Object.freeze({ kind: 'closeBuffer', bufferId })) });
        return false;
      }
      if (action === 'save' && !await api.saveBuffer(bufferId, destination)) return false;
      closeBuffer(bufferId);
      await api.persistRecoveryRecord();
      return true;
    },
    reopenRecentlyClosed() {
      const record = state.project.recentlyClosed[0];
      if (record === undefined) return undefined;
      state = Object.freeze({
        ...state,
        project: Object.freeze({ ...state.project, recentlyClosed: Object.freeze(state.project.recentlyClosed.slice(1)) })
      });
      const source = textDocumentText(record.editor.document);
      const id = addBuffer({
        source,
        label: record.label,
        ...(record.path === undefined ? {} : { path: record.path }),
        format: record.format,
        sourceRevision: record.sourceRevision,
        savedRevision: record.savedRevision,
        externalFileState: record.externalFileState,
        editor: record.editor,
        previewScroll: record.previewScroll
      });
      return id;
    },
    requestCloseApplication() {
      const dirty = state.project.bufferOrder.filter((id) => {
        const buffer = state.project.buffers[id];
        return buffer !== undefined && bufferIsDirty(buffer);
      });
      if (dirty.length === 0) return true;
      state = Object.freeze({
        ...state,
        dialogState: Object.freeze({ kind: 'dirtyBuffer', bufferIds: Object.freeze(dirty), closeApplication: true })
      });
      return false;
    },
    async resolveCloseApplication(action) {
      const dialog = state.dialogState;
      if (dialog?.kind !== 'dirtyBuffer' || !dialog.closeApplication || action === 'cancel') {
        state = clearDialog(state);
        return false;
      }
      if (action === 'saveAll') {
        const unsaved = dialog.bufferIds.find((bufferId) => state.project.buffers[bufferId]?.path === undefined);
        if (unsaved !== undefined) {
          state = Object.freeze({
            ...state,
            project: Object.freeze({ ...state.project, activeBufferId: unsaved }),
            dialogState: saveAsDialog(Object.freeze({ kind: 'closeApplication', bufferIds: dialog.bufferIds }))
          });
          return false;
        }
        if (!await api.saveAll()) return false;
      }
      for (const bufferId of [...state.project.bufferOrder]) closeBuffer(bufferId);
      await api.persistRecoveryRecord();
      return true;
    },
    async checkExternalFile(bufferId) {
      const snapshot = state.project.buffers[bufferId];
      if (snapshot?.path === undefined || snapshot.externalFileState.kind === 'untracked') return false;
      const observedPath = snapshot.path;
      const currentFingerprint = await externalFileFingerprint(observedPath);
      let buffer = state.project.buffers[bufferId];
      if (buffer?.path !== observedPath || buffer.externalFileState.kind === 'untracked') return false;
      const previous = externalFileStateFingerprint(buffer.externalFileState);
      if (currentFingerprint === undefined) {
        await api.refreshFileTree();
        buffer = state.project.buffers[bufferId];
        if (buffer?.path !== observedPath || buffer.externalFileState.kind === 'untracked') return false;
        const latestPrevious = externalFileStateFingerprint(buffer.externalFileState);
        const renamed = await findRenamedPath(state.project.fileTree, latestPrevious);
        if (renamed !== undefined) {
          const renamedFingerprint = await externalFileFingerprint(renamed);
          buffer = state.project.buffers[bufferId];
          if (renamedFingerprint !== undefined && buffer?.path === observedPath) {
            replaceBuffer({
              ...buffer,
              path: renamed,
              label: path.basename(renamed),
              externalFileState: Object.freeze({ kind: 'current', fingerprint: renamedFingerprint })
            });
            state = Object.freeze({
              ...state,
              project: Object.freeze({
                ...state.project,
                recentlyOpenedPaths: Object.freeze(state.project.recentlyOpenedPaths.map((candidate) => (
                  candidate === observedPath ? renamed : candidate
                )))
              })
            });
            attachWatcher(bufferId, renamed);
            return true;
          }
        }
        buffer = state.project.buffers[bufferId];
        if (buffer?.path !== observedPath || buffer.externalFileState.kind === 'untracked') return false;
        replaceBuffer({
          ...buffer,
          externalFileState: Object.freeze({ kind: 'deleted', previous: externalFileStateFingerprint(buffer.externalFileState) })
        });
        state = Object.freeze({ ...state, dialogState: Object.freeze({ kind: 'externalConflict', bufferId }) });
        return true;
      }
      if (sameExternalFileRevision(currentFingerprint, previous)) {
        if (buffer.externalFileState.kind !== 'deleted') return false;
        replaceBuffer({ ...buffer, externalFileState: Object.freeze({ kind: 'current', fingerprint: currentFingerprint }) });
        if (state.dialogState?.kind === 'externalConflict' && state.dialogState.bufferId === bufferId) {
          state = clearDialog(state);
        }
        return true;
      }
      if (bufferIsDirty(buffer)) {
        replaceBuffer({ ...buffer, externalFileState: Object.freeze({ kind: 'conflict', disk: currentFingerprint }) });
        state = Object.freeze({ ...state, dialogState: Object.freeze({ kind: 'externalConflict', bufferId }) });
        return true;
      }
      return api.reloadExternalFile(bufferId);
    },
    async reloadExternalFile(bufferId) {
      const snapshot = state.project.buffers[bufferId];
      const runtime = runtimes.get(bufferId);
      if (snapshot?.path === undefined || runtime === undefined) return false;
      const file = await readSourceFile(snapshot.path);
      const buffer = state.project.buffers[bufferId];
      if (buffer?.path !== snapshot.path || runtimes.get(bufferId) !== runtime) return false;
      if (buffer.sourceRevision !== snapshot.sourceRevision) {
        if (!bufferIsDirty(buffer)
          && buffer.externalFileState.kind === 'current'
          && sameExternalFileRevision(buffer.externalFileState.fingerprint, file.fingerprint)) {
          return false;
        }
        replaceBuffer({ ...buffer, externalFileState: Object.freeze({ kind: 'conflict', disk: file.fingerprint }) });
        state = Object.freeze({ ...state, dialogState: Object.freeze({ kind: 'externalConflict', bufferId }) });
        return true;
      }
      const revision = snapshot.sourceRevision + 1;
      const caret = Math.min(snapshot.editor.caret.position.offset, file.source.length);
      const selection = snapshot.editor.selection === undefined
        ? undefined
        : textDocumentSelectionBetween(
            Math.min(snapshot.editor.selection.anchor.offset, file.source.length),
            Math.min(snapshot.editor.selection.focus.offset, file.source.length)
          );
      const editor = createTextAreaState({
        value: file.source,
        caret: textCaretAt(caret),
        ...(selection === undefined ? {} : { selection }),
        scroll: snapshot.editor.scroll
      });
      const preview = runtime.parser.replaceSource(file.source, revision);
      resetSessionScopedPreviewCaches(runtime);
      replaceBuffer({
        ...buffer,
        editor,
        sourceRevision: revision,
        savedRevision: revision,
        preview,
        externalFileState: Object.freeze({ kind: 'current', fingerprint: file.fingerprint }),
        format: file.format
      });
      const dialog = state.dialogState;
      if (dialog?.kind === 'documentSearch' && dialog.selectionOnly) {
        const nextDialog = {
          ...dialog,
          selectionOnly: false,
          matches: Object.freeze([]),
          error: 'Selection-only search was disabled because the source document was reloaded.'
        };
        delete nextDialog.selectionSpan;
        delete nextDialog.selectedIndex;
        state = Object.freeze({ ...state, dialogState: Object.freeze(nextDialog) });
      }
      schedulePreviewResources(bufferId);
      scheduleRecovery();
      return true;
    },
    keepBuffer(bufferId) {
      const buffer = state.project.buffers[bufferId];
      if (buffer?.externalFileState.kind !== 'conflict') return;
      state = clearDialog(state);
    },
    async compareExternalFile(bufferId, signal) {
      const buffer = state.project.buffers[bufferId];
      if (buffer?.path === undefined) throw new Error('The buffer has no external file.');
      const disk = await readSourceFile(buffer.path, signal);
      return compareSourceLines(textDocumentText(buffer.editor.document), disk.source, signal);
    },
    async overwriteExternalFile(bufferId, signal) {
      await api.saveBuffer(bufferId, undefined, true, signal);
      state = clearDialog(state);
    },
    async recreateDeletedFile(bufferId, signal) {
      const buffer = state.project.buffers[bufferId];
      if (buffer?.path === undefined || buffer.externalFileState.kind !== 'deleted') return;
      await api.saveBuffer(bufferId, buffer.path, true, signal);
      state = clearDialog(state);
    },
    async resolveExternalFileAction(action, signal) {
      const dialog = state.dialogState;
      if (dialog?.kind !== 'externalConflict') return;
      const buffer = state.project.buffers[dialog.bufferId];
      if (buffer === undefined) {
        state = clearDialog(state);
        return;
      }
      if (action === 'compare') {
        const comparison = await api.compareExternalFile(buffer.id, signal);
        state = Object.freeze({ ...state, dialogState: Object.freeze({ ...dialog, comparison }) });
      } else if (action === 'reloadDisk') {
        await api.reloadExternalFile(buffer.id);
        state = clearDialog(state);
      } else if (action === 'keepBuffer') {
        api.keepBuffer(buffer.id);
      } else if (action === 'saveAs') {
        state = Object.freeze({
          ...clearDialog(state),
          dialogState: Object.freeze({
            kind: 'filePath', operation: 'saveAs',
            command: createCommandInputState({ value: '', suggestions: createCommandSuggestions([]) })
          })
        });
      } else if (action === 'overwriteDisk') {
        await api.overwriteExternalFile(buffer.id, signal);
      } else if (action === 'recreate') {
        await api.recreateDeletedFile(buffer.id, signal);
      } else {
        api.requestCloseBuffer(buffer.id);
      }
    },
    navigateTo(bufferId, sourceOffset, recordHistory = true, selection) {
      const target = state.project.buffers[bufferId];
      if (target === undefined) return;
      const current = activeBuffer(state);
      if (recordHistory && current !== undefined) {
        state = pushNavigationLocation(state, navigationLocation(current));
      }
      const bounded = Math.max(0, Math.min(textDocumentText(target.editor.document).length, Math.floor(sourceOffset)));
      const editor = textAreaReducer(target.editor, {
        kind: 'pointer',
        transition: selection === undefined
          ? { kind: 'placeCaret', offset: bounded }
          : {
              kind: 'extendSelection',
              anchor: Math.max(0, Math.min(textDocumentText(target.editor.document).length, selection.start)),
              offset: Math.max(0, Math.min(textDocumentText(target.editor.document).length, selection.end))
            }
      }).state;
      const runtime = runtimes.get(bufferId);
      const previewScroll = runtime?.lastPreviewLayout === undefined
        ? target.previewScroll
        : scrollReducer(target.previewScroll, {
            kind: 'setOffset', rows: runtime.lastPreviewLayout.rowOffsetMap.rowAtSourceOffset(bounded)
          });
      replaceBuffer({ ...target, editor, previewScroll });
      api.activateBuffer(bufferId);
    },
    navigateHistory(direction) {
      const current = activeBuffer(state);
      if (current === undefined) return;
      const here = navigationLocation(current);
      const result = direction === 'back' ? navigateBack(state, here) : navigateForward(state, here);
      state = result.state;
      if (result.destination !== undefined) {
        api.navigateTo(
          result.destination.bufferId,
          result.destination.sourceOffset,
          false,
          result.destination.selection
        );
      }
    },
    runtimeBufferInfo(bufferId) {
      const runtime = runtimes.get(bufferId);
      return runtime === undefined ? undefined : Object.freeze({
        parserIdentity: runtime.parser.identity,
        pendingEffects: runtime.pending.size,
        watched: runtime.watcher !== undefined
      });
    },
    markdownTheme() {
      return markdownTheme;
    },
    hybridDecorations(bufferId) {
      const buffer = state.project.buffers[bufferId];
      const runtime = runtimes.get(bufferId);
      if (buffer === undefined || runtime === undefined) {
        throw new Error(`Unknown buffer runtime: ${bufferId}`);
      }
      if (hybridDecorationCacheMatches(runtime.hybridDecorations, buffer)) {
        return runtime.hybridDecorations.decorations;
      }
      const decorations = createHybridTextDecorations(buffer, markdownTheme);
      runtime.hybridDecorations = hybridDecorationCache(buffer, decorations);
      return decorations;
    },
    previewLayout(
      bufferId,
      width,
      theme = markdownTheme,
      widthProfile = defaultTextWidthProfile,
    ) {
      const buffer = state.project.buffers[bufferId];
      const runtime = runtimes.get(bufferId);
      if (buffer?.preview.kind !== 'ready' || runtime === undefined) return undefined;
      const resources: MarkdownBlockResources = {
        highlightedCode: runtime.highlightedCode,
        mathText: runtime.mathText,
        diagramText: runtime.diagramText,
        images: runtime.images,
        diagnostics: buffer.preview.snapshot.document.diagnostics
      };
      const layout = layoutMarkdownPreview(
        buffer.preview.snapshot.document.tree,
        width,
        theme,
        widthProfile,
        runtime.previewLayouts,
        resources
      );
      runtime.lastPreviewLayout = layout;
      return layout;
    },
    previewViewportLayout(
      bufferId,
      width,
      rows,
      theme = markdownTheme,
      widthProfile = defaultTextWidthProfile,
    ) {
      const initialGeometry = vellumPreviewDocumentGeometry(width);
      const initial = api.previewLayout(bufferId, initialGeometry.contentWidth, theme, widthProfile);
      if (initial === undefined || initial.rows.length <= rows || width <= 1) return initial;
      const scrollableGeometry = vellumPreviewDocumentGeometry(width - 1);
      return scrollableGeometry.contentWidth === initialGeometry.contentWidth
        ? initial
        : api.previewLayout(bufferId, scrollableGeometry.contentWidth, theme, widthProfile);
    },
    async refreshPreviewResources(bufferId) {
      const buffer = state.project.buffers[bufferId];
      const runtime = runtimes.get(bufferId);
      if (buffer?.preview.kind !== 'ready' || runtime === undefined) return;
      if (runtime.resourceRevision === buffer.sourceRevision) {
        if (!runtime.activeResourceRevisions.has(buffer.sourceRevision)) return;
        await new Promise<void>((resolve, reject) => runtime.resourceRefreshWaiters.push({
          revision: buffer.sourceRevision,
          resolve,
          reject
        }));
        return;
      }
      runtime.resourceRevision = buffer.sourceRevision;
      runtime.activeResourceRevisions.add(buffer.sourceRevision);
      for (const pending of runtime.pending) pending.abort();
      runtime.pending.clear();
      const controller = new AbortController();
      runtime.pending.add(controller);
      const revision = buffer.sourceRevision;
      const topLevelNodeById = new Map<number, number>();
      const nodes = buffer.preview.snapshot.document.tree.children.flatMap((topLevel) => (
        [...walkMarkdown(topLevel)].map(({ node }) => {
          topLevelNodeById.set(node.id, topLevel.id);
          return node;
        })
      ));
      const activeNodeIds = new Set(nodes.map((node) => node.id));
      retainResourceEntries(runtime.highlightedCode, activeNodeIds);
      retainResourceEntries(runtime.mathText, activeNodeIds);
      retainResourceEntries(runtime.diagramText, activeNodeIds);
      retainResourceEntries(runtime.images, activeNodeIds);
      const resourceNodes = nodes.filter((node) => (
        node.kind === 'mathBlock'
        || node.kind === 'mathInline'
        || node.kind === 'image'
        || node.kind === 'codeBlock' && node.language !== null
      ));
      let refreshFailure: unknown;
      let workers: readonly Promise<void>[] = Object.freeze([]);
      try {
        let nextResource = 0;
        workers = Array.from({ length: Math.min(4, resourceNodes.length) }, async () => {
          while (nextResource < resourceNodes.length) {
            const node = resourceNodes[nextResource];
            nextResource += 1;
            if (node === undefined) continue;
            controller.signal.throwIfAborted();
            if (node.kind === 'codeBlock' && node.language !== null) {
              if (node.language.trim().toLowerCase() === 'mermaid') {
                try {
                  const diagram = await runtime.diagramRenderers.render('mermaid', node.value, controller.signal);
                  if (diagram !== undefined) {
                    const image = runtime.imageLoader.decode(diagram.bytes, 'Mermaid diagram', diagram.contentType);
                    commitPreviewResource(
                      bufferId,
                      revision,
                      node.id,
                      topLevelNodeById.get(node.id),
                      {
                        kind: 'diagram',
                        text: image.kind === 'failed' ? `Diagram rendering failed.\n${node.value}` : 'Mermaid diagram',
                        image
                      },
                      controller
                    );
                  }
                } catch (error) {
                  if (controller.signal.aborted) throw error;
                  commitPreviewResource(
                    bufferId,
                    revision,
                    node.id,
                    topLevelNodeById.get(node.id),
                    { kind: 'diagram', text: `Diagram rendering failed.\n${node.value}` },
                    controller
                  );
                }
              } else {
                const highlighted = await runtime.highlighter.highlight(node.language, node.value, controller.signal);
                if (highlighted !== undefined) {
                  commitPreviewResource(
                    bufferId,
                    revision,
                    node.id,
                    topLevelNodeById.get(node.id),
                    { kind: 'highlight', value: highlighted },
                    controller
                  );
                }
              }
            } else if (node.kind === 'mathBlock' || node.kind === 'mathInline') {
              let renderedText: string;
              try {
                const rendered = await runtime.mathRenderer.render(node.value, controller.signal);
                renderedText = rendered.text;
              } catch (error) {
                if (controller.signal.aborted) throw error;
                renderedText = `Math rendering failed: ${node.value}`;
              }
              commitPreviewResource(
                bufferId,
                revision,
                node.id,
                topLevelNodeById.get(node.id),
                { kind: 'math', value: renderedText },
                controller
              );
            } else if (node.kind === 'image') {
              const result = await runtime.imageLoader.load(node.destination, buffer.path, controller.signal);
              commitPreviewResource(
                bufferId,
                revision,
                node.id,
                topLevelNodeById.get(node.id),
                { kind: 'image', value: result },
                controller
              );
            }
          }
        });
        await Promise.all(workers);
      } catch (error) {
        if (!controller.signal.aborted) {
          refreshFailure = error;
          controller.abort(error);
        }
        await Promise.allSettled(workers);
        if (refreshFailure !== undefined) throw refreshFailure;
      } finally {
        runtime.pending.delete(controller);
        runtime.activeResourceRevisions.delete(revision);
        if (refreshFailure !== undefined && runtime.resourceRevision === revision) {
          runtime.resourceRevision = undefined;
        }
        const waiters = runtime.resourceRefreshWaiters.filter((waiter) => waiter.revision === revision);
        runtime.resourceRefreshWaiters.splice(
          0,
          runtime.resourceRefreshWaiters.length,
          ...runtime.resourceRefreshWaiters.filter((waiter) => waiter.revision !== revision)
        );
        for (const waiter of waiters) {
          if (refreshFailure === undefined) waiter.resolve();
          else waiter.reject(refreshFailure);
        }
      }
    },
    async persistRecoveryRecord() {
      assertActive();
      if (recoveryTimer !== undefined) {
        clearTimeout(recoveryTimer);
        recoveryTimer = undefined;
      }
      await writeRecovery();
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      if (recoveryTimer !== undefined) {
        clearTimeout(recoveryTimer);
        recoveryTimer = undefined;
      }
      for (const controller of directoryReads.values()) controller.abort();
      directoryReads.clear();
      projectIndexRead?.abort();
      projectIndexRead = undefined;
      for (const id of [...runtimes.keys()]) releaseBuffer(id);
      listeners.clear();
      await writeRecovery();
    }
  };

  for (const buffer of Object.values(state.project.buffers)) {
    const parser = restoredParsers.get(buffer.id)
      ?? createBufferParser(textDocumentText(buffer.editor.document), buffer.sourceRevision, options.parseOptions);
    runtimes.set(buffer.id, createRuntime(parser));
    schedulePreviewResources(buffer.id);
  }
  return Object.freeze(api);
}

export async function restoreVellumApplication(
  store: RecoveryStore,
  options: Omit<VellumApplicationOptions, 'initialState' | 'recoveryStore'> = {}
): Promise<VellumApplication> {
  const record = await store.read();
  if (record === undefined) return createVellumApplication({ ...options, recoveryStore: store });
  const recovered = recoverApplicationSeed(record);
  const application = instantiateVellumApplication(
    { ...options, recoveryStore: store, initialState: recovered.state },
    recovered.parsers
  );
  try {
    if (recovered.state.project.rootDirectory !== undefined) await application.refreshFileTree();
  } catch (error) {
    await application.dispose();
    throw error;
  }
  return application;
}

function navigationLocation(buffer: BufferState): NavigationLocation {
  const selection = buffer.editor.selection;
  if (selection === undefined) return location(buffer.id, buffer.editor.caret.position.offset);
  const start = Math.min(selection.anchor.offset, selection.focus.offset);
  const end = Math.max(selection.anchor.offset, selection.focus.offset);
  return location(buffer.id, buffer.editor.caret.position.offset, Object.freeze({ start, end }));
}

function saveAsDialog(afterSave: NonNullable<FilePathDialogState['afterSave']>): FilePathDialogState {
  return Object.freeze({
    kind: 'filePath',
    operation: 'saveAs',
    command: createCommandInputState({ value: '', suggestions: createCommandSuggestions([]) }),
    afterSave
  });
}

function clearDialog(value: AppState): AppState {
  const mutable = { ...value };
  delete mutable.dialogState;
  return Object.freeze(mutable);
}

async function findRenamedPath(
  fileTree: AppState['project']['fileTree'],
  previous: ExternalFileFingerprint
): Promise<string | undefined> {
  for (const filePath of indexedFilePaths(fileTree)) {
    try {
      const metadata = await stat(await realpath(filePath), { bigint: true });
      if (metadata.dev.toString() === previous.device && metadata.ino.toString() === previous.inode) return filePath;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT')) throw error;
    }
  }
  return undefined;
}

function executeNavigationEffect(application: VellumApplication, commandId: import('./types.js').CommandId): void {
  if (commandId === 'navigate.back' || commandId === 'navigate.forward') {
    application.navigateHistory(commandId === 'navigate.back' ? 'back' : 'forward');
    return;
  }
  if (commandId !== 'navigate.nextHeading' && commandId !== 'navigate.previousHeading') return;
  const state = application.state();
  const buffer = activeBuffer(state);
  if (buffer?.preview.kind !== 'ready') return;
  const headings = flattenOutline(extractMarkdownOutline(buffer.preview.snapshot.document.tree));
  const caret = buffer.editor.caret.position.offset;
  const destination = commandId === 'navigate.nextHeading'
    ? headings.find((entry) => entry.span.start > caret)
    : headings.toReversed().find((entry) => entry.span.start < caret);
  if (destination !== undefined) application.navigateTo(buffer.id, destination.span.start);
}

function flattenOutline(
  entries: ReturnType<typeof extractMarkdownOutline>
): ReturnType<typeof extractMarkdownOutline> {
  return entries.flatMap((entry) => [entry, ...flattenOutline(entry.children)]);
}

function retainResourceEntries<Value>(entries: Map<number, Value>, activeNodeIds: ReadonlySet<number>): void {
  for (const nodeId of entries.keys()) if (!activeNodeIds.has(nodeId)) entries.delete(nodeId);
}

interface ScrollPaneMap {
  readonly map: RowOffsetMap;
  readonly viewportRows: number;
}

function rowMapScrollGeometry(map: RowOffsetMap, viewportRows: number): ScrollGeometry {
  return Object.freeze({
    contentRows: map.rowCount,
    contentColumns: 0,
    viewportRows: Math.max(0, Math.floor(viewportRows)),
    viewportColumns: 0,
  });
}

function synchronizePaneScroll(
  originScroll: ScrollState,
  origin: ScrollPaneMap,
  targetScroll: ScrollState,
  target: ScrollPaneMap,
): ScrollState {
  const originGeometry = rowMapScrollGeometry(origin.map, origin.viewportRows);
  const targetGeometry = rowMapScrollGeometry(target.map, target.viewportRows);
  const normalizedOrigin = normalizeScrollState(originScroll, originGeometry);
  const originBottom = Math.max(0, originGeometry.contentRows - originGeometry.viewportRows);
  const targetBottom = Math.max(0, targetGeometry.contentRows - targetGeometry.viewportRows);
  const targetRow = normalizedOrigin.offsetRow === 0
    ? 0
    : normalizedOrigin.offsetRow === originBottom
      ? targetBottom
      : target.map.rowAtSourceOffset(
          sourceOffsetAtScrollRow(origin.map, normalizedOrigin.offsetRow),
        );
  return scrollReducer(
    targetScroll,
    { kind: 'setOffset', rows: targetRow },
    targetGeometry,
  );
}

function sourceOffsetAtScrollRow(map: RowOffsetMap, row: number): number {
  return map.sourceOffsetAtRow(Math.max(0, Math.min(map.rowCount - 1, row)));
}

function externalFileStateFingerprint(
  value: Exclude<ExternalFileState, { readonly kind: 'untracked' }>
): ExternalFileFingerprint {
  return value.kind === 'current'
    ? value.fingerprint
    : value.kind === 'conflict'
      ? value.disk
      : value.previous;
}

function mapSearchSelection(selection: import('markspan').SourceSpan, changeSet: TextChangeSet): import('markspan').SourceSpan {
  return Object.freeze({
    start: mapSourceOffset(selection.start, changeSet, 'left'),
    end: mapSourceOffset(selection.end, changeSet, 'right')
  });
}

function mapSourceOffset(
  offset: number,
  changeSet: TextChangeSet,
  affinity: 'left' | 'right'
): number {
  let delta = 0;
  for (const change of changeSet.changes) {
    if (offset < change.startOffset || (offset === change.startOffset && affinity === 'left')) break;
    const replacedLength = change.endOffsetExclusive - change.startOffset;
    if (offset > change.endOffsetExclusive || (offset === change.endOffsetExclusive && affinity === 'right')) {
      delta += change.insertedText.length - replacedLength;
      continue;
    }
    return change.startOffset + delta + (affinity === 'right' ? change.insertedText.length : 0);
  }
  return offset + delta;
}

function flattenOutlineItems(entries: readonly OutlineItem[]): readonly Omit<OutlineItem, 'children'>[] {
  return Object.freeze(entries.flatMap((entry) => {
    const { children, ...item } = entry;
    return [Object.freeze(item), ...flattenOutlineItems(children)];
  }));
}
