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
  createTextChangeSet,
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
  ExportHistoryEntry,
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
import { batchExportDirectory, exportDocument, type ExportResult } from '../export/exporter.js';
import { exportProjectManifest, loadProjectManifest } from '../export/project.js';
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
  clearDirectoryLoading,
  createFileTreeState,
  cycleFileTreeSort,
  markDirectoryLoading,
  reduceFileTree,
  readDirectoryNodes,
  setFileTreeFilter
} from '../project/file-tree.js';
import {
  buildProjectIndex,
  emptyProjectIndex,
  overlayOpenBuffers,
  updateProjectIndexPaths,
  type ProjectIndexSettings
} from '../project/index.js';
import { createBufferParser, type BufferParser } from '../markdown/preview.js';
import { compareSourceLines, type DiffLine } from '../files/diff.js';
import {
  copyTextToClipboard,
  createProjectDirectory as createProjectDirectoryOnDisk,
  createProjectFile as createProjectFileOnDisk,
  duplicateProjectPath as duplicateProjectPathOnDisk,
  executeProjectFileTransaction,
  moveProjectPath as moveProjectPathOnDisk,
  planProjectMoveLinkChanges,
  revealProjectPath,
  resolveProjectPath,
  trashProjectPath
} from '../files/project-operations.js';
import {
  findUnusedAssets,
  importAssetFile,
  importClipboardImage,
  markdownAssetReference
} from '../files/assets.js';
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
import type { CodeHighlighter, CodeHighlightLanguage, CodeHighlightSettings } from '../markdown/highlight.js';
import type { MathRenderer, MathRenderProvider, MathRenderSettings } from '../markdown/math.js';
import type { DiagramRendererDefinition, DiagramRendererRegistry } from '../markdown/diagram.js';
import {
  type MarkdownImageLoader,
  type MarkdownImageResult,
  type MarkdownImageSettings
} from '../markdown/image-loader.js';
import {
  createPreviewResourcePool,
  type PreviewResourcePool,
  type PreviewResourcePoolStats
} from '../markdown/resource-pool.js';
import {
  type RecoveryJournal,
  type RecoveryStore
} from '../recovery/recovery.js';
import type { SessionRecord, SessionStore } from '../session/session.js';
import { restoreApplicationSeed } from '../session/restore.js';
import {
  builtInDiagnosticProviders,
  addPersonalDictionaryWord,
  collectDiagnostics,
  exportDiagnosticProvider,
  type DiagnosticProvider,
  type WordDictionary
} from '../diagnostics/service.js';
import { defaultVellumConfigurationDirectory } from '../config/paths.js';

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
  diagnosticController: AbortController | undefined;
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
  readonly focusMode: boolean;
  readonly resourceRevision: number;
  readonly widthProfile: TextWidthProfile;
  readonly decorations: TextAreaDecorations;
}

function hybridDecorationCache(
  buffer: BufferState,
  decorations: TextAreaDecorations,
  focusMode: boolean,
  widthProfile: TextWidthProfile,
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
    focusMode,
    resourceRevision: buffer.previewResourceRevision,
    widthProfile,
    decorations,
  });
}

function hybridDecorationCacheMatches(
  cache: HybridDecorationCache | undefined,
  buffer: BufferState,
  focusMode: boolean,
  widthProfile: TextWidthProfile,
): cache is HybridDecorationCache {
  const selection = buffer.editor.selection;
  return cache !== undefined
    && cache.document === buffer.editor.document
    && cache.caretOffset === buffer.editor.caret.position.offset
    && cache.selectionStart === selection?.anchor.offset
    && cache.selectionEnd === selection?.focus.offset
    && cache.focusMode === focusMode
    && cache.resourceRevision === buffer.previewResourceRevision
    && cache.widthProfile === widthProfile
    && cache.previewIdentity === (buffer.preview.kind === 'ready' ? buffer.preview.identity : buffer.preview);
}

export interface VellumApplicationOptions {
  readonly parseOptions?: MarkdownParseOptions;
  readonly watchFiles?: boolean;
  readonly createBufferId?: () => BufferId;
  readonly initialState?: AppState;
  readonly sessionStore?: SessionStore;
  readonly recoveryStore?: RecoveryStore;
  readonly recoveryJournal?: RecoveryJournal;
  readonly sessionRecord?: SessionRecord;
  readonly persistenceDelayMilliseconds?: number;
  readonly startupDiagnostics?: readonly import('./types.js').ConfigurationDiagnostic[];
  readonly projectIndexSettings?: Partial<ProjectIndexSettings>;
  readonly diagnosticProviders?: readonly DiagnosticProvider[];
  readonly wordDictionary?: WordDictionary;
  readonly personalDictionaryPath?: string;
  readonly diagramRenderers?: readonly DiagramRendererDefinition[];
  readonly imageSettings?: Partial<MarkdownImageSettings>;
  readonly mathSettings?: Partial<MathRenderSettings>;
  readonly mathProviders?: readonly MathRenderProvider[];
  readonly highlightLanguages?: readonly CodeHighlightLanguage[];
  readonly highlightSettings?: Partial<CodeHighlightSettings>;
  readonly openExternalLink?: (url: URL, signal?: AbortSignal) => Promise<void>;
  readonly exportProfiles?: readonly ExportProfile[];
  readonly markdownTheme?: MarkdownTheme;
  readonly previewResourcePool?: PreviewResourcePool;
}

export type VellumApplicationUpdateReason =
  | 'previewResource'
  | 'externalFileRevision'
  | 'projectIndex'
  | 'diagnostics'
  | 'export'
  | 'persistenceFailure'
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
  createProjectFile(requestedPath: string, source?: string): Promise<BufferId>;
  createProjectDirectory(requestedPath: string): Promise<string>;
  moveProjectEntry(sourcePath: string, destinationPath: string, updateLinks?: boolean): Promise<void>;
  duplicateProjectEntry(sourcePath: string, destinationPath: string): Promise<void>;
  trashProjectEntry(requestedPath: string): Promise<void>;
  copyProjectPath(requestedPath: string, relative: boolean): Promise<void>;
  importProjectAsset(sourcePath: string, assetDirectory?: string): Promise<string>;
  importClipboardAsset(assetDirectory?: string): Promise<string>;
  refreshUnusedAssets(): Promise<readonly string[]>;
  refreshProjectEntry(requestedPath: string): Promise<void>;
  revealProjectEntry(requestedPath: string): Promise<void>;
  setProjectTreeFilter(filter: string): void;
  cycleProjectTreeSort(): void;
  toggleProjectPin(): void;
  dispatchCommand(commandId: import('./types.js').CommandId): AppUpdate;
  updateFilePathDialog(transition: CommandInputTransition): void;
  submitFilePathDialog(value?: string, signal?: AbortSignal): Promise<boolean>;
  updateSelectionDialog(transition: CommandInputTransition): void;
  submitSelectionDialog(value?: string, signal?: AbortSignal): Promise<void>;
  restoreRecoveryGeneration(generation: number, signal?: AbortSignal): Promise<void>;
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
  runProjectManifestExport(signal?: AbortSignal): Promise<void>;
  repeatLastExport(signal?: AbortSignal): Promise<void>;
  cancelExport(): void;
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
  previewResourceStats(): PreviewResourcePoolStats;
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
  refreshDiagnostics(bufferId: BufferId): Promise<void>;
  applyDiagnosticFix(bufferId: BufferId, diagnosticId: string, fixIndex?: number): void;
  navigateDiagnostic(bufferId: BufferId, direction: 'next' | 'previous'): void;
  applyCurrentDiagnosticFix(): void;
  ignoreCurrentDiagnosticRule(): void;
  cycleDiagnosticSeverity(): void;
  cycleDiagnosticSource(): void;
  refreshProjectDiagnostics(): Promise<void>;
  addCurrentWordToDictionary(): Promise<void>;
  persistState(): Promise<void>;
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
  if ((options.startupDiagnostics?.length ?? 0) > 0) {
    state = Object.freeze({
      ...state,
      configurationDiagnostics: Object.freeze([
        ...state.configurationDiagnostics,
        ...(options.startupDiagnostics ?? [])
      ]),
      notice: Object.freeze({
        status: 'warning',
        message: `${String(options.startupDiagnostics?.length ?? 0)} configuration or restoration diagnostic${options.startupDiagnostics?.length === 1 ? '' : 's'} available.`
      })
    });
  }
  if ((options.recoveryJournal?.snapshots.length ?? 0) > 1) {
    state = Object.freeze({
      ...state,
      dialogState: Object.freeze({
        kind: 'recoverySelection',
        command: createCommandInputState({ value: '', suggestions: createCommandSuggestions([]) }),
        entries: Object.freeze((options.recoveryJournal?.snapshots ?? []).toReversed().map((snapshot) => Object.freeze({
          id: String(snapshot.generation),
          label: `Generation ${String(snapshot.generation)} · ${snapshot.timestamp}`,
          detail: snapshot.buffers.map((buffer) => `${buffer.label} (${String(buffer.source.length)} UTF-16 units)`).join(', '),
          generation: snapshot.generation
        })))
      })
    });
  }
  const exportProfiles = Object.freeze([...builtInExportProfiles, ...(options.exportProfiles ?? [])]);
  const diagnosticProviders = options.diagnosticProviders ?? Object.freeze([
    ...builtInDiagnosticProviders(options.wordDictionary),
    exportDiagnosticProvider(exportProfiles)
  ]);
  const markdownTheme = options.markdownTheme ?? darkTerminalMarkdownTheme;
  const personalDictionaryPath = options.personalDictionaryPath
    ?? path.join(defaultVellumConfigurationDirectory(), 'personal-dictionary.txt');
  const ownsPreviewResourcePool = options.previewResourcePool === undefined;
  const previewResourcePool = options.previewResourcePool ?? createPreviewResourcePool({
    ...(options.diagramRenderers === undefined ? {} : { diagramRenderers: options.diagramRenderers }),
    ...(options.imageSettings === undefined ? {} : { imageSettings: options.imageSettings }),
    ...(options.highlightLanguages === undefined ? {} : { highlightLanguages: options.highlightLanguages }),
    ...(options.highlightSettings === undefined ? {} : { highlightSettings: options.highlightSettings }),
    ...(options.mathSettings === undefined ? {} : { mathSettings: options.mathSettings }),
    ...(options.mathProviders === undefined ? {} : { mathProviders: options.mathProviders })
  });
  const exportDiagnostics = validateExportProfiles(exportProfiles);
  if (exportDiagnostics.length > 0) {
    throw new Error(exportDiagnostics.map((diagnostic) => `${diagnostic.profileId}: ${diagnostic.message}`).join('\n'));
  }
  const runtimes = new Map<BufferId, BufferRuntime>();
  const directoryReads = new Map<string, AbortController>();
  const saveQueues = new Map<BufferId, Promise<void>>();
  const projectWatchers = new Map<string, FSWatcher>();
  let projectIndexRead: AbortController | undefined;
  let projectSearchRead: AbortController | undefined;
  let projectIndexTask: Promise<void> | undefined;
  let projectWatchTimer: NodeJS.Timeout | undefined;
  const pendingProjectIndexPaths = new Set<string>();
  let forceFullProjectIndexRefresh = false;
  const createId = options.createBufferId ?? randomUUID;
  let disposed = false;
  let persistenceTimer: NodeJS.Timeout | undefined;
  let persistenceWriteQueue = Promise.resolve();
  let applicationRevision = 0;
  let currentTerminalSize: TerminalSize = Object.freeze({ columns: 80, rows: 24 });
  let currentWidthProfile: TextWidthProfile = defaultTextWidthProfile;
  let exportController: AbortController | undefined;
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
    reason: Extract<VellumApplicationUpdateReason, 'persistenceFailure' | 'backgroundFailure'>,
    error: unknown,
    bufferId?: BufferId
  ): void => {
    state = Object.freeze({
      ...state,
      notice: Object.freeze({ status: 'error', message: error instanceof Error ? error.message : String(error) })
    });
    publishApplicationUpdate(reason, bufferId);
  };

  const writePersistence = async (): Promise<void> => {
    if (options.sessionStore === undefined && options.recoveryStore === undefined) return;
    const snapshot = state;
    const operation = persistenceWriteQueue.then(async () => {
      await options.sessionStore?.write(snapshot);
      await options.recoveryStore?.write(snapshot);
    });
    persistenceWriteQueue = operation.catch(() => undefined);
    try {
      await operation;
    } catch (error) {
      if (!disposed) publishFailure('persistenceFailure', error);
      throw error;
    }
  };

  const schedulePersistence = (): void => {
    if (options.sessionStore === undefined && options.recoveryStore === undefined) return;
    if (persistenceTimer !== undefined) clearTimeout(persistenceTimer);
    persistenceTimer = setTimeout(() => {
      persistenceTimer = undefined;
      void writePersistence().catch(() => undefined);
    }, options.persistenceDelayMilliseconds ?? 500);
    persistenceTimer.unref();
  };

  const projectSearchSourceIdentity = (): string => JSON.stringify({
    rootDirectory: state.project.rootDirectory,
    indexRevision: state.project.index.revision,
    dirtyBuffers: state.project.bufferOrder.flatMap((id) => {
      const buffer = state.project.buffers[id];
      return buffer === undefined || buffer.path === undefined || !bufferIsDirty(buffer)
        ? []
        : [[id, buffer.path, buffer.sourceRevision]];
    })
  });

  const cancelProjectSearchRead = (): void => {
    projectSearchRead?.abort(new DOMException('Project search superseded.', 'AbortError'));
    projectSearchRead = undefined;
  };

  const stopProjectSearch = (): void => {
    const dialog = state.dialogState;
    state = dialog?.kind === 'projectDirectorySearch'
      ? Object.freeze({
          ...state,
          projectSearch: Object.freeze({ ...state.projectSearch, searching: false }),
          dialogState: Object.freeze({ ...dialog, searching: false })
        })
      : Object.freeze({
          ...state,
          projectSearch: Object.freeze({ ...state.projectSearch, searching: false })
        });
  };

  const invalidateProjectSearchResults = (): void => {
    cancelProjectSearchRead();
    const nextSearch = { ...state.projectSearch, searching: false, results: Object.freeze([]) };
    delete nextSearch.error;
    const dialog = state.dialogState;
    state = dialog?.kind === 'projectDirectorySearch'
      ? Object.freeze({
          ...state,
          projectSearch: Object.freeze(nextSearch),
          dialogState: Object.freeze({
            ...dialog,
            searching: false,
            results: Object.freeze([]),
            query: commandInputReducer(dialog.query, {
              kind: 'setSuggestions',
              suggestions: createCommandSuggestions([])
            })
          })
        })
      : Object.freeze({ ...state, projectSearch: Object.freeze(nextSearch) });
  };

  const refreshProjectIndex = async (): Promise<void> => {
    const root = state.project.rootDirectory;
    if (root === undefined) return;
    projectIndexRead?.abort();
    const controller = new AbortController();
    projectIndexRead = controller;
    const previous = state.project.index;
    state = Object.freeze({
      ...state,
      project: Object.freeze({
        ...state.project,
        index: Object.freeze({ ...previous, indexing: true })
      })
    });
    try {
      const built = await buildProjectIndex(root, previous, options.projectIndexSettings, controller.signal);
      if (projectIndexRead !== controller || state.project.rootDirectory !== root) return;
      state = Object.freeze({
        ...state,
        project: Object.freeze({
          ...state.project,
          index: built.state
        })
      });
      invalidateProjectSearchResults();
      if (options.watchFiles !== false) replaceProjectWatchers(built.directories);
      for (const bufferId of state.project.bufferOrder) scheduleDiagnostics(bufferId);
      schedulePersistence();
      publishApplicationUpdate('projectIndex');
    } catch (error) {
      if (controller.signal.aborted) return;
      state = Object.freeze({
        ...state,
        project: Object.freeze({
          ...state.project,
          index: Object.freeze({
            ...state.project.index,
            indexing: false,
            lastError: error instanceof Error ? error.message : String(error)
          })
        })
      });
      throw error;
    } finally {
      if (projectIndexRead === controller) projectIndexRead = undefined;
    }
  };

  const refreshProjectIndexPaths = async (changedPaths: readonly string[]): Promise<void> => {
    const root = state.project.rootDirectory;
    if (root === undefined || changedPaths.length === 0) return;
    projectIndexRead?.abort();
    const controller = new AbortController();
    projectIndexRead = controller;
    const previous = state.project.index;
    state = Object.freeze({
      ...state,
      project: Object.freeze({
        ...state.project,
        index: Object.freeze({ ...previous, indexing: true })
      })
    });
    let requiresFullRefresh = false;
    try {
      const next = await updateProjectIndexPaths(
        root,
        previous,
        changedPaths,
        options.projectIndexSettings,
        controller.signal
      );
      if (projectIndexRead !== controller || state.project.rootDirectory !== root) return;
      if (next === undefined) {
        requiresFullRefresh = true;
      } else {
        state = Object.freeze({
          ...state,
          project: Object.freeze({ ...state.project, index: next })
        });
        invalidateProjectSearchResults();
        for (const changedPath of changedPaths) {
          let missing = false;
          try {
            await stat(changedPath);
          } catch (error) {
            if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') missing = true;
            else throw error;
          }
          if (!missing) continue;
          for (const [directory, watcher] of projectWatchers) {
            if (!pathIsWithin(changedPath, directory)) continue;
            watcher.close();
            projectWatchers.delete(directory);
          }
        }
        for (const bufferId of state.project.bufferOrder) scheduleDiagnostics(bufferId);
        schedulePersistence();
        publishApplicationUpdate('projectIndex');
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      state = Object.freeze({
        ...state,
        project: Object.freeze({
          ...state.project,
          index: Object.freeze({
            ...state.project.index,
            indexing: false,
            lastError: error instanceof Error ? error.message : String(error)
          })
        })
      });
      throw error;
    } finally {
      if (projectIndexRead === controller) projectIndexRead = undefined;
    }
    if (requiresFullRefresh && !disposed && state.project.rootDirectory === root) await refreshProjectIndex();
  };

  const trackProjectIndexTask = (task: Promise<void>): Promise<void> => {
    projectIndexTask = task;
    void task.finally(() => {
      if (projectIndexTask === task) projectIndexTask = undefined;
    }).catch(() => undefined);
    return task;
  };

  const startProjectIndexRefresh = (): Promise<void> => {
    return trackProjectIndexTask(refreshProjectIndex());
  };

  const startProjectIndexPathRefresh = (changedPaths: readonly string[]): Promise<void> => {
    return trackProjectIndexTask(refreshProjectIndexPaths(changedPaths));
  };

  const replaceProjectWatchers = (directories: readonly string[]): void => {
    const wanted = new Set(directories);
    for (const [directory, watcher] of projectWatchers) {
      if (wanted.has(directory)) continue;
      watcher.close();
      projectWatchers.delete(directory);
    }
    for (const directory of wanted) {
      if (projectWatchers.has(directory)) continue;
      try {
        const watcher = watch(directory, { persistent: false }, (_eventType, filename) => {
          if (filename === null) {
            forceFullProjectIndexRefresh = true;
          } else {
            const changedPath = path.join(directory, filename.toString());
            pendingProjectIndexPaths.add(changedPath);
            const basename = path.basename(changedPath);
            if (basename === '.gitignore' || basename === '.ignore') forceFullProjectIndexRefresh = true;
          }
          if (projectWatchTimer !== undefined) clearTimeout(projectWatchTimer);
          projectWatchTimer = setTimeout(() => {
            projectWatchTimer = undefined;
            const changedPaths = Object.freeze([...pendingProjectIndexPaths]);
            pendingProjectIndexPaths.clear();
            const fullRefresh = forceFullProjectIndexRefresh;
            forceFullProjectIndexRefresh = false;
            const task = fullRefresh ? startProjectIndexRefresh() : startProjectIndexPathRefresh(changedPaths);
            void task.catch((error) => publishFailure('backgroundFailure', error));
          }, 50);
          projectWatchTimer.unref();
        });
        watcher.on('error', (error) => publishFailure('backgroundFailure', error));
        projectWatchers.set(directory, watcher);
      } catch (error) {
        publishFailure('backgroundFailure', error);
      }
    }
  };

  const refreshChangedProjectPaths = async (changedPaths: readonly string[]): Promise<void> => {
    const root = state.project.rootDirectory;
    if (root === undefined) return;
    const paths = Object.freeze([...new Set(changedPaths
      .map((candidate) => path.resolve(candidate))
      .filter((candidate) => candidate !== root && pathIsWithin(root, candidate)))]);
    if (paths.length === 0) return;
    const directories = new Set(paths.map((candidate) => path.dirname(candidate)));
    const treeRefreshes = [...directories].flatMap((directory) => {
      const node = state.project.fileTree.nodes[directory];
      return node?.kind === 'directory' && node.loaded ? [api.loadFileTreeDirectory(directory)] : [];
    });
    const requiresNewWatcher = options.watchFiles !== false
      && [...directories].some((directory) => !projectWatchers.has(directory));
    await Promise.all([
      ...treeRefreshes,
      requiresNewWatcher ? startProjectIndexRefresh() : startProjectIndexPathRefresh(paths)
    ]);
  };

  const assertActive = (): void => {
    if (disposed) throw new Error('The Vellum application instance has been disposed.');
  };

  const createRuntime = (parser: BufferParser): BufferRuntime => ({
    parser,
    watcher: undefined,
    pending: new Set(),
    previewLayouts: createPreviewLayoutCache(),
    highlighter: previewResourcePool.highlighter,
    mathRenderer: previewResourcePool.mathRenderer,
    diagramRenderers: previewResourcePool.diagramRenderers,
    imageLoader: previewResourcePool.imageLoader,
    highlightedCode: new Map(),
    mathText: new Map(),
    diagramText: new Map(),
    images: new Map(),
    resourceRevision: undefined,
    activeResourceRevisions: new Set(),
    resourceRefreshWaiters: [],
    lastPreviewLayout: undefined,
    hybridDecorations: undefined,
    diagnosticController: undefined,
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

  const scheduleDiagnostics = (bufferId: BufferId): void => {
    queueMicrotask(() => {
      void api.refreshDiagnostics(bufferId).catch((error) => {
        if (error instanceof Error && error.name === 'AbortError') return;
        if (state.project.buffers[bufferId] === undefined) return;
        publishFailure('backgroundFailure', error, bufferId);
      });
    });
  };

  const selectionSuggestions = (
    dialog: Extract<NonNullable<AppState['dialogState']>, { kind: 'commandPalette' | 'quickOpen' | 'completion' | 'recentProject' | 'recoverySelection' }>,
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
      : dialog.kind === 'quickOpen'
        ? quickOpenEntries(state.project.index, query, state.project.recentlyOpenedPaths).map((entry) => ({
          id: entry.path,
          label: entry.relativePath,
          completion: { range: { startOffset: 0, endOffsetExclusive: query.length }, text: entry.path }
        }))
        : dialog.entries.filter((entry) => entry.label.toLowerCase().includes(query.toLowerCase())).map((entry) => ({
          id: entry.id,
          label: entry.label,
          description: entry.detail,
          completion: { range: { startOffset: 0, endOffsetExclusive: query.length }, text: entry.id }
        }));
    return commandInputReducer(command, { kind: 'setSuggestions', suggestions: createCommandSuggestions(entries) });
  };

  const refreshSelectionDialog = (): void => {
    const dialog = state.dialogState;
    if (dialog?.kind !== 'commandPalette' && dialog?.kind !== 'quickOpen' && dialog?.kind !== 'completion' && dialog?.kind !== 'recentProject' && dialog?.kind !== 'recoverySelection') return;
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
        description: `${profile.reader.name} → ${profile.writer.name}`,
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
    scheduleDiagnostics(id);
    schedulePersistence();
    return id;
  };

  const replaceBuffer = (buffer: BufferState): void => {
    const previous = state.project.buffers[buffer.id];
    if (previous === undefined) return;
    state = Object.freeze({
      ...state,
      project: Object.freeze({
        ...state.project,
        buffers: Object.freeze({ ...state.project.buffers, [buffer.id]: Object.freeze(buffer) })
      })
    });
    if (previous.editor.document !== buffer.editor.document || previous.path !== buffer.path) {
      invalidateProjectSearchResults();
    }
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
    runtime.diagnosticController?.abort();
    for (const controller of runtime.pending) controller.abort();
    runtime.pending.clear();
    runtime.previewLayouts.clear();
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
    const diagnostics = { ...state.diagnostics };
    delete diagnostics[bufferId];
    state = clearDialog(Object.freeze({
      ...state,
      diagnostics: Object.freeze(diagnostics),
      project: Object.freeze(project),
      commandState: Object.freeze({
        ...state.commandState,
        navigation: Object.freeze({
          back: Object.freeze(navigation.back.filter((entry) => entry.bufferId !== bufferId)),
          forward: Object.freeze(navigation.forward.filter((entry) => entry.bufferId !== bufferId))
        })
      })
    }));
    invalidateProjectSearchResults();
    releaseBuffer(bufferId);
    schedulePersistence();
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
        if (!hybridDecorationCacheMatches(runtime.hybridDecorations, nextBuffer, state.writingMode.focus, currentWidthProfile)) {
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
    scheduleDiagnostics(bufferId);
    schedulePersistence();
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

  const anchorTypewriterViewport = (bufferId: BufferId): void => {
    if (!state.writingMode.typewriter) return;
    const buffer = state.project.buffers[bufferId];
    if (buffer === undefined) return;
    const body = vellumBodyGeometry(state, currentTerminalSize);
    const panes = vellumPaneGeometry(state, body.bodyWidth, body.contentRows);
    const editorPane = panes.editor;
    if (editorPane === undefined) return;
    const decorations = state.editorMode === 'hybrid' ? api.hybridDecorations(bufferId) : undefined;
    const map = createTextAreaRowOffsetMap({
      document: buffer.editor.document,
      terminalWidth: editorPane.width,
      terminalRows: editorPane.rows,
      widthProfile: currentWidthProfile,
      ...(decorations === undefined ? {} : { decorations }),
      lineNumbers: { minWidth: 3 },
      wrap: { mode: 'soft' },
      scrollbar: { visible: 'auto' }
    });
    const caretRow = map.rowAtSourceOffset(buffer.editor.caret.position.offset);
    const offsetRow = Math.max(0, caretRow - Math.floor((editorPane.rows - 1) * state.writingMode.typewriterAnchor));
    const editor = textAreaReducer(buffer.editor, {
      kind: 'scroll',
      request: {
        nextState: Object.freeze({ ...buffer.editor.scroll, offsetRow, followTail: false }),
        source: 'focus',
        target: 'content'
      }
    }).state;
    replaceBuffer({ ...buffer, editor });
  };

  const insertTextAtSelection = (bufferId: BufferId, insertedText: string): void => {
    const buffer = state.project.buffers[bufferId];
    if (buffer === undefined) return;
    const selection = buffer.editor.selection;
    const start = selection === undefined
      ? buffer.editor.caret.position.offset
      : Math.min(selection.anchor.offset, selection.focus.offset);
    const end = selection === undefined
      ? start
      : Math.max(selection.anchor.offset, selection.focus.offset);
    applyTransition(bufferId, {
      kind: 'applyChanges',
      changeSet: createTextChangeSet([{
        startOffset: start,
        endOffsetExclusive: end,
        insertedText
      }])
    }, start + insertedText.length);
    anchorTypewriterViewport(bufferId);
  };

  const blockResources = (buffer: BufferState, runtime: BufferRuntime): MarkdownBlockResources => {
    const tableOfContents = new Map<number, string>();
    if (buffer.preview.kind === 'ready') {
      const source = runtime.parser.source();
      const headings = [...walkMarkdown(buffer.preview.snapshot.document.tree)].flatMap(({ node }) => node.kind === 'heading'
        ? [`${'  '.repeat(node.depth - 1)}• ${source.slice(node.contentSpan.start, node.contentSpan.end).trim()}`]
        : []);
      for (const { node } of walkMarkdown(buffer.preview.snapshot.document.tree)) {
        if (node.kind === 'paragraph' && /^\s*\[(?:toc|_toc_)\]\s*$/iu.test(source.slice(node.span.start, node.span.end))) {
          tableOfContents.set(node.id, headings.join('\n') || 'Table of contents is empty.');
        }
      }
    }
    return Object.freeze({
      highlightedCode: runtime.highlightedCode,
      mathText: runtime.mathText,
      diagramText: runtime.diagramText,
      images: runtime.images,
      tableOfContents,
      diagnostics: buffer.preview.kind === 'ready' ? buffer.preview.snapshot.document.diagnostics : Object.freeze([])
    });
  };

  const visibleDiagnosticsFor = (bufferId: BufferId): readonly import('./types.js').VellumDiagnostic[] => {
    const ranks = { info: 0, warning: 1, error: 2 } as const;
    return (state.diagnostics[bufferId] ?? []).filter((diagnostic) => (
      ranks[diagnostic.severity] >= ranks[state.diagnosticPreferences.minimumSeverity]
      && (state.diagnosticPreferences.source === 'all' || diagnostic.source === state.diagnosticPreferences.source)
      && !state.diagnosticPreferences.ignoredRules.includes(diagnostic.rule)
    ));
  };

  const currentDiagnostic = (requireFix = false) => {
    const buffer = activeBuffer(state);
    if (buffer === undefined) return undefined;
    const diagnostics = visibleDiagnosticsFor(buffer.id).filter((diagnostic) => !requireFix || diagnostic.fixes.length > 0);
    const caret = buffer.editor.caret.position.offset;
    return diagnostics.find((diagnostic) => diagnostic.span.start <= caret && diagnostic.span.end >= caret)
      ?? diagnostics.find((diagnostic) => diagnostic.span.start >= caret)
      ?? diagnostics[0];
  };

  const liveExportSources = (): ReadonlyMap<string, { readonly source: string; readonly unsaved: boolean }> => new Map(
    Object.values(state.project.buffers).flatMap((buffer) => buffer.path === undefined ? [] : [[
      path.resolve(buffer.path),
      Object.freeze({ source: textDocumentText(buffer.editor.document), unsaved: bufferIsDirty(buffer) })
    ] as const])
  );

  const replaceExportHistoryEntry = (entry: ExportHistoryEntry, active: boolean): void => {
    state = Object.freeze({
      ...state,
      exports: Object.freeze({
        ...state.exports,
        ...(active ? { activeId: entry.id } : {}),
        history: Object.freeze([
          entry,
          ...state.exports.history.filter((candidate) => candidate.id !== entry.id)
        ].slice(0, 50))
      })
    });
    if (!active) {
      const exports = { ...state.exports };
      delete exports.activeId;
      state = Object.freeze({ ...state, exports: Object.freeze(exports) });
    }
    publishApplicationUpdate('export');
  };

  const executeExportRequest = async (
    scope: ExportHistoryEntry['scope'],
    profile: ExportProfile | undefined,
    signal?: AbortSignal,
    overwrite = false
  ): Promise<readonly ExportResult[]> => {
    if (exportController !== undefined) throw new Error('Another export is already running.');
    if (scope !== 'projectManifest' && profile === undefined) throw new Error('An export profile is required.');
    const controller = new AbortController();
    exportController = controller;
    const abort = (): void => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted === true) abort();
    const id = randomUUID();
    const startedAt = new Date().toISOString();
    const started = performance.now();
    const profileId = profile?.id ?? 'manifest';
    const running: ExportHistoryEntry = Object.freeze({
      id,
      scope,
      profileId,
      status: 'running',
      startedAt,
      outputPaths: Object.freeze([]),
      standardError: '',
      usedUnsavedSource: false
    });
    state = Object.freeze({
      ...state,
      navigator: Object.freeze({ ...state.navigator, mode: 'export', visible: true }),
      exports: Object.freeze({
        ...state.exports,
        activeId: id,
        lastRequest: Object.freeze({ scope, profileId }),
        history: Object.freeze([running, ...state.exports.history].slice(0, 50))
      })
    });
    publishApplicationUpdate('export');
    try {
      let results: readonly ExportResult[];
      if (scope === 'activeBuffer') {
        const buffer = activeBuffer(state);
        if (buffer === undefined) throw new Error('Open a buffer before exporting it.');
        const baseDirectory = buffer.path === undefined
          ? state.project.rootDirectory ?? process.cwd()
          : path.dirname(buffer.path);
        results = Object.freeze([await exportDocument(Object.freeze({
          kind: 'buffer',
          source: textDocumentText(buffer.editor.document),
          label: buffer.label,
          baseDirectory,
          ...(buffer.path === undefined ? {} : { path: buffer.path }),
          unsaved: bufferIsDirty(buffer) || buffer.path === undefined
        }), profile as ExportProfile, { signal: controller.signal, overwrite })]);
      } else if (scope === 'batchDirectory') {
        const root = state.project.rootDirectory;
        if (root === undefined) throw new Error('Open a project directory before batch export.');
        results = await batchExportDirectory(root, profile as ExportProfile, liveExportSources(), { signal: controller.signal, overwrite });
      } else {
        const root = state.project.rootDirectory;
        if (root === undefined) throw new Error('Open a project directory before exporting its manifest.');
        const manifest = await loadProjectManifest(root);
        results = await exportProjectManifest(
          root,
          manifest,
          exportProfiles,
          liveExportSources(),
          { signal: controller.signal, overwrite },
          (progress) => {
            state = Object.freeze({
              ...state,
              notice: Object.freeze({
                status: 'warning',
                message: `Exporting ${progress.profileId}: ${String(progress.completed)}/${String(progress.total)} profiles.`
              })
            });
            publishApplicationUpdate('export');
          }
        );
      }
      replaceExportHistoryEntry(Object.freeze({
        ...running,
        status: 'succeeded',
        elapsedMilliseconds: performance.now() - started,
        outputPaths: Object.freeze(results.map((result) => result.outputPath)),
        standardError: results.map((result) => result.standardError).filter((value) => value.length > 0).join('\n'),
        usedUnsavedSource: results.some((result) => result.usedUnsavedSource)
      }), false);
      state = Object.freeze({
        ...state,
        notice: Object.freeze({
          status: 'success',
          message: `Export completed${results.some((result) => result.usedUnsavedSource) ? ' from current unsaved source' : ''}: ${String(results.length)} output${results.length === 1 ? '' : 's'}.`
        })
      });
      return results;
    } catch (error) {
      const cancelled = controller.signal.aborted;
      replaceExportHistoryEntry(Object.freeze({
        ...running,
        status: cancelled ? 'cancelled' : 'failed',
        elapsedMilliseconds: performance.now() - started,
        outputPaths: Object.freeze([]),
        standardError: '',
        usedUnsavedSource: false,
        error: error instanceof Error ? error.message : String(error)
      }), false);
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
      if (exportController === controller) exportController = undefined;
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
      const realDirectory = await realpath(exact);
      assertActive();
      if (!(await stat(realDirectory)).isDirectory()) throw new Error(`The project directory is not a directory: ${exact}`);
      for (const controller of directoryReads.values()) controller.abort();
      directoryReads.clear();
      projectIndexRead?.abort();
      if (projectWatchTimer !== undefined) {
        clearTimeout(projectWatchTimer);
        projectWatchTimer = undefined;
      }
      pendingProjectIndexPaths.clear();
      forceFullProjectIndexRefresh = false;
      for (const watcher of projectWatchers.values()) watcher.close();
      projectWatchers.clear();
      state = Object.freeze({
        ...state,
        project: Object.freeze({
          ...state.project,
          rootDirectory: exact,
          fileTree: createFileTreeState(exact, state.project.fileTree.exclusionPatterns),
          index: emptyProjectIndex(),
          recentProjects: Object.freeze([exact, ...state.project.recentProjects.filter((candidate) => candidate !== exact)].slice(0, 20))
        })
      });
      invalidateProjectSearchResults();
      await api.loadFileTreeDirectory(exact);
      void startProjectIndexRefresh().catch((error) => publishFailure('backgroundFailure', error));
      schedulePersistence();
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
      await Promise.all([api.loadFileTreeDirectory(root), startProjectIndexRefresh()]);
    },
    activateBuffer(bufferId) {
      assertActive();
      if (state.project.buffers[bufferId] === undefined || state.project.activeBufferId === bufferId) return;
      state = Object.freeze({
        ...state,
        project: Object.freeze({ ...state.project, activeBufferId: bufferId })
      });
      schedulePersistence();
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
      schedulePersistence();
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
    async createProjectFile(requestedPath, source = '') {
      const root = state.project.rootDirectory;
      if (root === undefined) throw new Error('Open a project before creating a project file.');
      const created = await createProjectFileOnDisk(root, requestedPath, source);
      await refreshChangedProjectPaths([created]);
      const id = await api.openFile(created);
      state = Object.freeze({ ...state, notice: Object.freeze({ status: 'success', message: `Created ${path.relative(root, created)}.` }) });
      schedulePersistence();
      return id;
    },
    async createProjectDirectory(requestedPath) {
      const root = state.project.rootDirectory;
      if (root === undefined) throw new Error('Open a project before creating a directory.');
      const created = await createProjectDirectoryOnDisk(root, requestedPath);
      await refreshChangedProjectPaths([created]);
      state = Object.freeze({ ...state, notice: Object.freeze({ status: 'success', message: `Created ${path.relative(root, created)}.` }) });
      schedulePersistence();
      return created;
    },
    async moveProjectEntry(sourcePath, destinationPath, updateLinks = true) {
      const root = state.project.rootDirectory;
      if (root === undefined) throw new Error('Open a project before moving a project entry.');
      const source = resolveProjectPath(root, sourcePath);
      const destination = resolveProjectPath(root, destinationPath);
      const overlaidIndex = overlayOpenBuffers(state.project.index, Object.values(state.project.buffers).map((buffer) => ({
        ...(buffer.path === undefined ? {} : { path: buffer.path }),
        source: textDocumentText(buffer.editor.document)
      })));
      const changes = updateLinks ? planProjectMoveLinkChanges(root, overlaidIndex, source, destination) : Object.freeze([]);
      const changesByPath = new Map<string, typeof changes>();
      for (const change of changes) {
        const previous = changesByPath.get(change.documentPath) ?? Object.freeze([]);
        changesByPath.set(change.documentPath, Object.freeze([...previous, change]));
      }
      const openByOldPath = new Map(Object.values(state.project.buffers).flatMap((buffer) => (
        buffer.path === undefined ? [] : [[buffer.path, buffer] as const]
      )));
      for (const [oldPath, buffer] of openByOldPath) {
        if (remapMovedPath(oldPath, source, destination) === oldPath && !changesByPath.has(oldPath)) continue;
        if (buffer.externalFileState.kind === 'conflict' || buffer.externalFileState.kind === 'deleted') {
          throw new Error(`Resolve the external file state before moving ${oldPath}.`);
        }
      }
      const preparedWrites = new Map<string, {
        readonly source: string;
        readonly original: Awaited<ReturnType<typeof readSourceFile>>;
      }>();
      for (const [documentPath, documentChanges] of changesByPath) {
        const openBuffer = openByOldPath.get(documentPath);
        if (openBuffer !== undefined && bufferIsDirty(openBuffer)) continue;
        const file = await readSourceFile(documentPath);
        if (openBuffer?.externalFileState.kind === 'current'
          && !sameExternalFileRevision(file.fingerprint, openBuffer.externalFileState.fingerprint)) {
          throw new Error(`The file changed externally before the project move: ${documentPath}`);
        }
        const indexed = overlaidIndex.documents[documentPath];
        if (openBuffer === undefined && indexed?.contentHash !== file.fingerprint.contentHash) {
          throw new Error(`The project index is stale for ${documentPath}; refresh the project before moving files.`);
        }
        const baseSource = openBuffer === undefined ? file.source : textDocumentText(openBuffer.editor.document);
        preparedWrites.set(documentPath, Object.freeze({
          source: applyProjectLinkChanges(baseSource, documentChanges),
          original: file
        }));
      }
      const watchedBufferIds = new Set<string>();
      for (const [oldPath, buffer] of openByOldPath) {
        if (remapMovedPath(oldPath, source, destination) === oldPath && !changesByPath.has(oldPath)) continue;
        const runtime = runtimes.get(buffer.id);
        runtime?.watcher?.close();
        if (runtime !== undefined) runtime.watcher = undefined;
        watchedBufferIds.add(buffer.id);
      }
      const committedFiles = new Map<string, Awaited<ReturnType<typeof readSourceFile>>>();
      try {
        await executeProjectFileTransaction(async (transaction) => {
          await moveProjectPathOnDisk(root, source, destination);
          transaction.addRollback(async () => {
            await moveProjectPathOnDisk(root, destination, source);
          });
          for (const [oldPath, prepared] of preparedWrites) {
            const target = remapMovedPath(oldPath, source, destination);
            const current = await readSourceFile(target);
            const saved = await saveSourceFile(target, prepared.source, {
              expectedFingerprint: current.fingerprint,
              format: current.format
            });
            committedFiles.set(target, saved);
            transaction.addRollback(async () => {
              await saveSourceFile(target, prepared.original.source, {
                expectedFingerprint: saved.fingerprint,
                format: prepared.original.format
              });
            });
          }
          for (const oldPath of openByOldPath.keys()) {
            const futurePath = remapMovedPath(oldPath, source, destination);
            if (futurePath === oldPath && !changesByPath.has(oldPath)) continue;
            const current = committedFiles.get(futurePath) ?? await readSourceFile(futurePath);
            committedFiles.set(futurePath, current);
          }
        });
      } catch (error) {
        for (const bufferId of watchedBufferIds) {
          const buffer = state.project.buffers[bufferId];
          if (buffer?.path !== undefined && options.watchFiles !== false) attachWatcher(bufferId, buffer.path);
        }
        throw error;
      }
      for (const [oldPath, documentChanges] of changesByPath) {
        const original = openByOldPath.get(oldPath);
        if (original === undefined) continue;
        const wasDirty = bufferIsDirty(original);
        applyTransition(original.id, {
          kind: 'applyChanges',
          changeSet: createTextChangeSet(documentChanges.map((change) => ({
            startOffset: change.start,
            endOffsetExclusive: change.end,
            insertedText: change.replacement
          })))
        });
        if (!wasDirty) {
          const current = state.project.buffers[original.id];
          const futurePath = remapMovedPath(oldPath, source, destination);
          const saved = committedFiles.get(futurePath);
          if (current !== undefined && saved !== undefined) {
            replaceBuffer({
              ...current,
              savedRevision: current.sourceRevision,
              externalFileState: Object.freeze({ kind: 'current', fingerprint: saved.fingerprint })
            });
          }
        }
      }
      for (const [oldPath, original] of openByOldPath) {
        const current = state.project.buffers[original.id];
        if (current === undefined) continue;
        const futurePath = remapMovedPath(oldPath, source, destination);
        const file = committedFiles.get(futurePath);
        if (futurePath !== oldPath || file !== undefined) {
          const fingerprint = file?.fingerprint ?? await externalFileFingerprint(futurePath);
          if (fingerprint === undefined) throw new Error(`The moved buffer path cannot be read: ${futurePath}`);
          replaceBuffer({
            ...current,
            path: futurePath,
            label: path.basename(futurePath),
            externalFileState: Object.freeze({ kind: 'current', fingerprint })
          });
        }
        if (watchedBufferIds.has(original.id) && options.watchFiles !== false) attachWatcher(original.id, futurePath);
      }
      state = Object.freeze({
        ...state,
        project: Object.freeze({
          ...state.project,
          recentlyOpenedPaths: Object.freeze(state.project.recentlyOpenedPaths.map((candidate) => (
            remapMovedPath(candidate, source, destination)
          ))),
          recentlyClosed: Object.freeze(state.project.recentlyClosed.map((record) => (
            record.path === undefined
              ? record
              : Object.freeze({ ...record, path: remapMovedPath(record.path, source, destination) })
          )))
        }),
        notice: Object.freeze({
          status: 'success',
          message: `Moved ${path.relative(root, source)} to ${path.relative(root, destination)}${changes.length === 0 ? '.' : ` and updated ${String(changes.length)} link${changes.length === 1 ? '' : 's'}.`}`
        })
      });
      await refreshChangedProjectPaths([source, destination]);
      schedulePersistence();
    },
    async duplicateProjectEntry(sourcePath, destinationPath) {
      const root = state.project.rootDirectory;
      if (root === undefined) throw new Error('Open a project before duplicating a project entry.');
      const duplicated = await duplicateProjectPathOnDisk(root, sourcePath, destinationPath);
      await refreshChangedProjectPaths([duplicated]);
      state = Object.freeze({ ...state, notice: Object.freeze({ status: 'success', message: `Duplicated ${path.relative(root, duplicated)}.` }) });
    },
    async trashProjectEntry(requestedPath) {
      const root = state.project.rootDirectory;
      if (root === undefined) throw new Error('Open a project before moving an entry to trash.');
      const target = resolveProjectPath(root, requestedPath);
      const affected = Object.values(state.project.buffers).filter((buffer) => (
        buffer.path !== undefined && pathIsWithin(target, buffer.path)
      ));
      if (affected.some(bufferIsDirty)) throw new Error('Save or close dirty buffers below this project entry before moving it to trash.');
      await trashProjectPath(root, target);
      for (const buffer of affected) closeBuffer(buffer.id);
      await refreshChangedProjectPaths([target]);
      state = Object.freeze({ ...state, notice: Object.freeze({ status: 'success', message: `Moved ${path.relative(root, target)} to trash.` }) });
      schedulePersistence();
    },
    async copyProjectPath(requestedPath, relative) {
      const root = state.project.rootDirectory;
      if (root === undefined) throw new Error('Open a project before copying a project path.');
      const target = resolveProjectPath(root, requestedPath);
      const value = relative ? path.relative(root, target) : target;
      await copyTextToClipboard(value);
      state = Object.freeze({ ...state, notice: Object.freeze({ status: 'success', message: `Copied ${value}.` }) });
    },
    async importProjectAsset(sourcePath, assetDirectory = 'assets') {
      const root = state.project.rootDirectory;
      const buffer = activeBuffer(state);
      if (root === undefined) throw new Error('Open a project before importing an asset.');
      if (buffer?.path === undefined) throw new Error('Save the active document before importing an asset.');
      const imported = await importAssetFile(root, sourcePath, assetDirectory);
      const reference = markdownAssetReference(buffer.path, imported.path);
      insertTextAtSelection(buffer.id, reference);
      await refreshChangedProjectPaths([imported.path]);
      state = Object.freeze({
        ...state,
        notice: Object.freeze({ status: 'success', message: `Imported ${path.relative(root, imported.path)}.` })
      });
      return imported.path;
    },
    async importClipboardAsset(assetDirectory = 'assets') {
      const root = state.project.rootDirectory;
      const buffer = activeBuffer(state);
      if (root === undefined) throw new Error('Open a project before importing a clipboard image.');
      if (buffer?.path === undefined) throw new Error('Save the active document before importing a clipboard image.');
      const imported = await importClipboardImage(root, assetDirectory);
      insertTextAtSelection(buffer.id, markdownAssetReference(buffer.path, imported.path));
      await refreshChangedProjectPaths([imported.path]);
      state = Object.freeze({
        ...state,
        notice: Object.freeze({ status: 'success', message: `Imported ${path.relative(root, imported.path)} from the clipboard.` })
      });
      return imported.path;
    },
    async refreshUnusedAssets() {
      const root = state.project.rootDirectory;
      if (root === undefined) throw new Error('Open a project before checking assets.');
      const unusedAssets = await findUnusedAssets(root, overlayOpenBuffers(
        state.project.index,
        Object.values(state.project.buffers).map((buffer) => ({
          ...(buffer.path === undefined ? {} : { path: buffer.path }),
          source: textDocumentText(buffer.editor.document)
        }))
      ));
      state = Object.freeze({
        ...state,
        navigator: Object.freeze({ ...state.navigator, mode: 'diagnostics', visible: true }),
        project: Object.freeze({ ...state.project, unusedAssets }),
        notice: Object.freeze({
          status: unusedAssets.length === 0 ? 'success' : 'warning',
          message: unusedAssets.length === 0 ? 'No unused image assets found.' : `${String(unusedAssets.length)} unused image asset${unusedAssets.length === 1 ? '' : 's'} found.`
        })
      });
      return unusedAssets;
    },
    async refreshProjectEntry(requestedPath) {
      const root = state.project.rootDirectory;
      if (root === undefined) throw new Error('Open a project before refreshing its files.');
      const target = requestedPath === root ? root : resolveProjectPath(root, requestedPath);
      const node = state.project.fileTree.nodes[target];
      const directory = node?.kind === 'file' ? node.parentId ?? root : target;
      if (state.project.fileTree.nodes[directory]?.kind !== 'directory') throw new Error(`The selected project directory is unavailable: ${directory}`);
      await Promise.all([api.loadFileTreeDirectory(directory), startProjectIndexRefresh()]);
      state = Object.freeze({ ...state, notice: Object.freeze({ status: 'success', message: `Refreshed ${path.relative(root, directory) || path.basename(root)}.` }) });
    },
    async revealProjectEntry(requestedPath) {
      const root = state.project.rootDirectory;
      if (root === undefined) throw new Error('Open a project before revealing its files.');
      await revealProjectPath(root, requestedPath);
    },
    setProjectTreeFilter(filter) {
      state = Object.freeze({
        ...state,
        project: Object.freeze({ ...state.project, fileTree: setFileTreeFilter(state.project.fileTree, filter) })
      });
      schedulePersistence();
    },
    cycleProjectTreeSort() {
      const fileTree = cycleFileTreeSort(state.project.fileTree);
      state = Object.freeze({
        ...state,
        project: Object.freeze({ ...state.project, fileTree }),
        notice: Object.freeze({ status: 'success', message: `Project files sorted by ${fileTree.sort}.` })
      });
      schedulePersistence();
    },
    toggleProjectPin() {
      const root = state.project.rootDirectory;
      if (root === undefined) return;
      const pinned = state.project.pinnedProjects.includes(root);
      const pinnedProjects = pinned
        ? state.project.pinnedProjects.filter((candidate) => candidate !== root)
        : [root, ...state.project.pinnedProjects];
      state = Object.freeze({
        ...state,
        project: Object.freeze({ ...state.project, pinnedProjects: Object.freeze(pinnedProjects) }),
        notice: Object.freeze({ status: 'success', message: `${pinned ? 'Unpinned' : 'Pinned'} ${path.basename(root)}.` })
      });
      schedulePersistence();
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
        } else if (effect.kind === 'cancelExport') {
          api.cancelExport();
        } else if (effect.kind === 'cycleFileTreeSort') {
          api.cycleProjectTreeSort();
        } else if (effect.kind === 'pinProject') {
          api.toggleProjectPin();
        } else if (effect.kind === 'diagnosticAction') {
          if (effect.action === 'applyFix') api.applyCurrentDiagnosticFix();
          else if (effect.action === 'ignoreRule') api.ignoreCurrentDiagnosticRule();
          else if (effect.action === 'cycleSeverity') api.cycleDiagnosticSeverity();
          else api.cycleDiagnosticSource();
        }
      }
      refreshSelectionDialog();
      refreshOutline();
      refreshExportDialog();
      schedulePersistence();
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
    async submitFilePathDialog(value, signal) {
      const dialog = state.dialogState;
      if (dialog?.kind !== 'filePath') return false;
      signal?.throwIfAborted();
      const entered = value ?? dialog.command.editor.input.text;
      if (entered.trim().length === 0 && dialog.operation !== 'filterProjectTree') {
        state = Object.freeze({
          ...state,
          dialogState: Object.freeze({ ...dialog, error: 'Enter a path.' })
        });
        return false;
      }
      try {
        if (dialog.operation === 'filterProjectTree') api.setProjectTreeFilter(entered);
        else if (dialog.operation === 'openFile') await api.openFile(entered, signal);
        else if (dialog.operation === 'openProjectDirectory') await api.openProjectDirectory(entered, signal);
        else if (dialog.operation === 'createProjectFile') await api.createProjectFile(entered);
        else if (dialog.operation === 'createProjectDirectory') await api.createProjectDirectory(entered);
        else if (dialog.operation === 'importAsset') await api.importProjectAsset(entered);
        else if (dialog.operation === 'renameProjectEntry' || dialog.operation === 'moveProjectEntry') {
          if (dialog.projectSourcePath === undefined) throw new Error('The selected project entry is no longer available.');
          const destination = dialog.operation === 'renameProjectEntry' && !entered.includes('/') && !entered.includes('\\')
            ? path.join(path.dirname(dialog.projectSourcePath), entered)
            : entered;
          await api.moveProjectEntry(dialog.projectSourcePath, destination, true);
        } else if (dialog.operation === 'duplicateProjectEntry') {
          if (dialog.projectSourcePath === undefined) throw new Error('The selected project entry is no longer available.');
          await api.duplicateProjectEntry(dialog.projectSourcePath, entered);
        }
        else {
          const id = dialog.afterSave?.kind === 'closeBuffer'
            ? dialog.afterSave.bufferId
            : dialog.afterSave?.kind === 'closeApplication' || dialog.afterSave?.kind === 'saveAll'
              ? dialog.afterSave.bufferIds.find((bufferId) => state.project.buffers[bufferId]?.path === undefined)
              : state.project.activeBufferId;
          if (id !== undefined && !await api.saveBuffer(id, entered, false, signal)) return false;
        }
        signal?.throwIfAborted();
        if (state.dialogState !== dialog) return false;
        if (dialog.afterSave?.kind === 'closeBuffer') {
          closeBuffer(dialog.afterSave.bufferId);
          await api.persistState();
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
          if (!await api.saveAll(signal)) return false;
          for (const bufferId of [...state.project.bufferOrder]) closeBuffer(bufferId);
          await api.persistState();
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
          await api.saveAll(signal);
        } else {
          state = clearDialog(state);
        }
      } catch (error) {
        if (signal?.aborted === true) throw error;
        if (state.dialogState === dialog) {
          state = Object.freeze({
            ...state,
            dialogState: Object.freeze({
              ...dialog,
              error: error instanceof Error ? error.message : String(error)
            })
          });
        }
      }
      return false;
    },
    updateSelectionDialog(transition) {
      const dialog = state.dialogState;
      if (dialog?.kind !== 'commandPalette' && dialog?.kind !== 'quickOpen' && dialog?.kind !== 'completion' && dialog?.kind !== 'recentProject' && dialog?.kind !== 'recoverySelection') return;
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
    async submitSelectionDialog(value, signal) {
      const dialog = state.dialogState;
      if (dialog?.kind !== 'commandPalette' && dialog?.kind !== 'quickOpen' && dialog?.kind !== 'completion' && dialog?.kind !== 'recentProject' && dialog?.kind !== 'recoverySelection') return;
      signal?.throwIfAborted();
      if (dialog.kind === 'recoverySelection') {
        const query = dialog.command.editor.input.text.toLocaleLowerCase();
        const entry = dialog.entries.find((candidate) => candidate.id === value)
          ?? dialog.entries.find((candidate) => candidate.label.toLocaleLowerCase().includes(query));
        if (entry === undefined) {
          state = Object.freeze({ ...state, dialogState: Object.freeze({ ...dialog, error: 'Select a recovery generation.' }) });
          return;
        }
        await api.restoreRecoveryGeneration(entry.generation, signal);
        return;
      }
      if (dialog.kind === 'recentProject') {
        const query = dialog.command.editor.input.text.toLocaleLowerCase();
        const entry = dialog.entries.find((candidate) => candidate.id === value)
          ?? dialog.entries.find((candidate) => candidate.label.toLocaleLowerCase().includes(query));
        if (entry === undefined) {
          state = Object.freeze({ ...state, dialogState: Object.freeze({ ...dialog, error: 'No recent project matches the query.' }) });
          return;
        }
        try {
          await api.openProjectDirectory(entry.id, signal);
          if (state.dialogState === dialog) state = clearDialog(state);
        } catch (error) {
          if (signal?.aborted === true) throw error;
          if (state.dialogState === dialog) {
            state = Object.freeze({ ...state, dialogState: Object.freeze({ ...dialog, error: error instanceof Error ? error.message : String(error) }) });
          }
        }
        return;
      }
      if (dialog.kind === 'completion') {
        const query = dialog.command.editor.input.text.toLowerCase();
        const entry = dialog.entries.find((candidate) => candidate.id === value)
          ?? dialog.entries.find((candidate) => candidate.label.toLowerCase().includes(query));
        if (entry === undefined) {
          state = Object.freeze({ ...state, dialogState: Object.freeze({ ...dialog, error: 'No completion matches the query.' }) });
          return;
        }
        if (state.project.buffers[dialog.bufferId] === undefined) {
          state = clearDialog(state);
          return;
        }
        applyTransition(dialog.bufferId, {
          kind: 'applyChanges',
          changeSet: createTextChangeSet([{
            startOffset: entry.range.start,
            endOffsetExclusive: entry.range.end,
            insertedText: entry.replacement
          }])
        });
        state = clearDialog(state);
        return;
      }
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
      await projectIndexTask;
      signal?.throwIfAborted();
      if (state.dialogState !== dialog) return;
      const paths = state.project.index.orderedPaths;
      const candidate = value !== undefined && paths.includes(value)
        ? value
        : quickOpenEntries(state.project.index, dialog.command.editor.input.text, state.project.recentlyOpenedPaths)[0]?.path;
      if (candidate === undefined) {
        state = Object.freeze({ ...state, dialogState: Object.freeze({ ...dialog, error: 'No file matches the query.' }) });
        return;
      }
      try {
        await api.openFile(candidate, signal);
        if (state.dialogState === dialog) state = clearDialog(state);
      } catch (error) {
        if (signal?.aborted === true) throw error;
        if (state.dialogState === dialog) {
          state = Object.freeze({
            ...state,
            dialogState: Object.freeze({ ...dialog, error: error instanceof Error ? error.message : String(error) })
          });
        }
      }
    },
    async restoreRecoveryGeneration(generation, signal) {
      signal?.throwIfAborted();
      const snapshot = options.recoveryJournal?.snapshots.find((candidate) => candidate.generation === generation);
      if (snapshot === undefined) throw new Error(`Recovery generation is unavailable: ${String(generation)}`);
      const restored = await restoreApplicationSeed(options.sessionRecord, Object.freeze({
        schemaVersion: 1,
        snapshots: Object.freeze([snapshot])
      }));
      signal?.throwIfAborted();
      for (const controller of directoryReads.values()) controller.abort();
      directoryReads.clear();
      projectIndexRead?.abort();
      projectIndexRead = undefined;
      cancelProjectSearchRead();
      if (projectWatchTimer !== undefined) clearTimeout(projectWatchTimer);
      projectWatchTimer = undefined;
      pendingProjectIndexPaths.clear();
      forceFullProjectIndexRefresh = false;
      for (const watcher of projectWatchers.values()) watcher.close();
      projectWatchers.clear();
      exportController?.abort(new DOMException('Workspace recovery restored.', 'AbortError'));
      for (const id of [...runtimes.keys()]) releaseBuffer(id);
      const configurationDiagnostics = state.configurationDiagnostics;
      state = Object.freeze({
        ...restored.state,
        configurationDiagnostics,
        notice: Object.freeze({
          status: 'warning',
          message: `Restored recovery generation ${String(generation)} from ${snapshot.timestamp}.`
        })
      });
      for (const buffer of Object.values(state.project.buffers)) {
        const parser = restored.parsers.get(buffer.id)
          ?? createBufferParser(textDocumentText(buffer.editor.document), buffer.sourceRevision, options.parseOptions);
        runtimes.set(buffer.id, createRuntime(parser));
        if (options.watchFiles !== false && buffer.path !== undefined) attachWatcher(buffer.id, buffer.path);
        schedulePreviewResources(buffer.id);
        scheduleDiagnostics(buffer.id);
      }
      if (state.project.rootDirectory !== undefined) await api.refreshFileTree();
      await api.persistState();
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
      state = Object.freeze({
        ...state,
        projectSearch: Object.freeze({
          ...state.projectSearch,
          query: query.editor.input.text
        }),
        dialogState: Object.freeze({ ...dialog, query })
      });
      invalidateProjectSearchResults();
      schedulePersistence();
    },
    async runProjectDirectorySearch(searchOptions = {}, signal = new AbortController().signal) {
      const dialog = state.dialogState;
      if (dialog?.kind !== 'projectDirectorySearch') return;
      await projectIndexTask;
      signal.throwIfAborted();
      const activeDialog = state.dialogState;
      if (activeDialog?.kind !== 'projectDirectorySearch') return;
      cancelProjectSearchRead();
      const controller = new AbortController();
      projectSearchRead = controller;
      const searchSignal = AbortSignal.any([signal, controller.signal]);
      const query = activeDialog.query.editor.input.text;
      try {
        const indexedRevision = state.project.index.revision;
        const sourceIdentity = projectSearchSourceIdentity();
        const searchIndex = overlayOpenBuffers(state.project.index, Object.values(state.project.buffers).map((buffer) => ({
          ...(buffer.path === undefined ? {} : { path: buffer.path }),
          source: textDocumentText(buffer.editor.document)
        })));
        state = Object.freeze({
          ...state,
          projectSearch: Object.freeze({ ...state.projectSearch, query, searching: true, results: Object.freeze([]) }),
          dialogState: Object.freeze({ ...activeDialog, searching: true, results: Object.freeze([]) })
        });
        const results = await searchProjectDirectory(searchIndex, query, {
          ...searchOptions,
          onBatch: (batch) => {
            const active = state.dialogState;
            if (active?.kind !== 'projectDirectorySearch'
              || active.query.editor.input.text !== query
              || state.project.index.revision !== indexedRevision
              || projectSearchSourceIdentity() !== sourceIdentity) return;
            state = Object.freeze({
              ...state,
              projectSearch: Object.freeze({
                ...state.projectSearch,
                query,
                searching: true,
                results: Object.freeze([...state.projectSearch.results, ...batch])
              }),
              dialogState: Object.freeze({ ...active, results: Object.freeze([...active.results, ...batch]) })
            });
            publishApplicationUpdate('projectIndex');
          }
        }, searchSignal);
        if (state.dialogState?.kind !== 'projectDirectorySearch') return;
        if (state.dialogState.query.editor.input.text !== query
          || state.project.index.revision !== indexedRevision
          || projectSearchSourceIdentity() !== sourceIdentity) {
          invalidateProjectSearchResults();
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
          projectSearch: Object.freeze({
            ...state.projectSearch,
            query,
            recentQueries: query.trim().length === 0
              ? state.projectSearch.recentQueries
              : Object.freeze([query, ...state.projectSearch.recentQueries.filter((candidate) => candidate !== query)].slice(0, 20)),
            searching: false,
            results
          }),
          dialogState: Object.freeze({
            ...state.dialogState, searching: false, results,
            query: commandInputReducer(state.dialogState.query, { kind: 'setSuggestions', suggestions })
          })
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        if (signal.aborted) {
          if (projectSearchRead === controller) stopProjectSearch();
          throw error;
        }
        if (state.dialogState?.kind !== 'projectDirectorySearch') return;
        state = Object.freeze({
          ...state,
          projectSearch: Object.freeze({
            ...state.projectSearch,
            query,
            searching: false,
            results: state.projectSearch.results,
            error: error instanceof Error ? error.message : String(error)
          }),
          dialogState: Object.freeze({
            ...state.dialogState, searching: false,
            error: error instanceof Error ? error.message : String(error)
          })
        });
      } finally {
        if (projectSearchRead === controller) projectSearchRead = undefined;
      }
      schedulePersistence();
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
        await executeExportRequest(dialog.scope, profile, signal);
        const notice = state.notice;
        state = Object.freeze({ ...clearDialog(state), ...(notice === undefined ? {} : { notice }) });
      } catch (error) {
        if (signal?.aborted === true) throw error;
        state = Object.freeze({
          ...state,
          dialogState: Object.freeze({ ...dialog, error: error instanceof Error ? error.message : String(error) })
        });
      }
    },
    async runProjectManifestExport(signal) {
      await executeExportRequest('projectManifest', undefined, signal);
    },
    async repeatLastExport(signal) {
      const request = state.exports.lastRequest;
      if (request === undefined) throw new Error('No export is available to repeat.');
      if (request.scope === 'projectManifest') {
        await executeExportRequest('projectManifest', undefined, signal, true);
        return;
      }
      const profile = exportProfiles.find((candidate) => candidate.id === request.profileId);
      if (profile === undefined) throw new Error(`The previous export profile is no longer configured: ${request.profileId}`);
      await executeExportRequest(request.scope, profile, signal, true);
    },
    cancelExport() {
      exportController?.abort(new Error('Export cancelled by the user.'));
    },
    dismissDialog() {
      if (state.dialogState?.kind === 'projectDirectorySearch') {
        cancelProjectSearchRead();
        stopProjectSearch();
      }
      state = clearDialog(state);
    },
    resizeSplitPane(transition) {
      const splitPane = splitPaneReducer(state.splitPane, transition, {
        constraints: Object.freeze([{ minShare: 0.2, maxShare: 0.8 }, { minShare: 0.2, maxShare: 0.8 }])
      });
      if (splitPane !== state.splitPane) {
        state = Object.freeze({ ...state, splitPane });
        schedulePersistence();
      }
    },
    resizeTerminal(previous, next, widthProfile) {
      currentTerminalSize = next;
      currentWidthProfile = widthProfile;
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
      schedulePersistence();
    },
    updatePreviewScroll(bufferId, request, synchronization) {
      const buffer = state.project.buffers[bufferId];
      if (buffer === undefined) return;
      if (synchronization === undefined) {
        replaceBuffer({ ...buffer, previewScroll: request.nextState });
        schedulePersistence();
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
      schedulePersistence();
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
      anchorTypewriterViewport(bufferId);
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
      anchorTypewriterViewport(bufferId);
    },
    indentList(bufferId, outdent) {
      const buffer = state.project.buffers[bufferId];
      const runtime = runtimes.get(bufferId);
      if (buffer === undefined || runtime === undefined) return;
      const transition = listIndentTransition(buffer, outdent, runtime.parser.source());
      if (transition.action !== undefined) applyTransition(bufferId, transition.action, transition.caretOffset);
    },
    async saveBuffer(bufferId, destination, overwriteConflict = false, signal) {
      const previous = saveQueues.get(bufferId);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const queued = (previous ?? Promise.resolve()).catch(() => undefined).then(() => gate);
      saveQueues.set(bufferId, queued);
      if (previous !== undefined) await previous.catch(() => undefined);
      try {
        signal?.throwIfAborted();
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
        await refreshChangedProjectPaths([file.path]);
        await api.persistState();
        return true;
      } finally {
        release();
        if (saveQueues.get(bufferId) === queued) saveQueues.delete(bufferId);
      }
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
      await api.persistState();
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
      await api.persistState();
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
        const renamed = await findRenamedPath(state.project.index, latestPrevious);
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
      schedulePersistence();
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
    previewResourceStats() {
      return previewResourcePool.stats();
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
      if (hybridDecorationCacheMatches(runtime.hybridDecorations, buffer, state.writingMode.focus, currentWidthProfile)) {
        return runtime.hybridDecorations.decorations;
      }
      const decorations = createHybridTextDecorations(
        buffer,
        markdownTheme,
        state.writingMode.focus,
        blockResources(buffer, runtime),
        currentWidthProfile
      );
      runtime.hybridDecorations = hybridDecorationCache(buffer, decorations, state.writingMode.focus, currentWidthProfile);
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
      const resources = blockResources(buffer, runtime);
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
                    const image = await runtime.imageLoader.decode(
                      diagram.bytes,
                      'Mermaid diagram',
                      diagram.contentType,
                      controller.signal
                    );
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
                  } else {
                    commitPreviewResource(
                      bufferId,
                      revision,
                      node.id,
                      topLevelNodeById.get(node.id),
                      { kind: 'diagram', text: `Mermaid renderer is not configured.\n${node.value}` },
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
    async refreshDiagnostics(bufferId) {
      const buffer = state.project.buffers[bufferId];
      const runtime = runtimes.get(bufferId);
      if (buffer === undefined || runtime === undefined) return;
      runtime.diagnosticController?.abort();
      const controller = new AbortController();
      runtime.diagnosticController = controller;
      try {
        const diagnostics = await collectDiagnostics(
          buffer,
          overlayOpenBuffers(state.project.index, Object.values(state.project.buffers).map((candidate) => ({
            ...(candidate.path === undefined ? {} : { path: candidate.path }),
            source: textDocumentText(candidate.editor.document)
          }))),
          diagnosticProviders,
          controller.signal
        );
        if (runtime.diagnosticController !== controller
          || state.project.buffers[bufferId]?.sourceRevision !== buffer.sourceRevision) return;
        state = Object.freeze({
          ...state,
          diagnostics: Object.freeze({ ...state.diagnostics, [bufferId]: diagnostics })
        });
        publishApplicationUpdate('diagnostics', bufferId);
      } finally {
        if (runtime.diagnosticController === controller) runtime.diagnosticController = undefined;
      }
    },
    applyDiagnosticFix(bufferId, diagnosticId, fixIndex = 0) {
      const buffer = state.project.buffers[bufferId];
      const diagnostic = state.diagnostics[bufferId]?.find((candidate) => candidate.id === diagnosticId);
      const fix = diagnostic?.fixes[fixIndex];
      if (buffer === undefined || diagnostic === undefined || fix === undefined) return;
      if (diagnostic.providerRevision !== buffer.sourceRevision) {
        scheduleDiagnostics(bufferId);
        return;
      }
      applyTransition(bufferId, {
        kind: 'applyChanges',
        changeSet: createTextChangeSet([{
          startOffset: fix.span.start,
          endOffsetExclusive: fix.span.end,
          insertedText: fix.replacement
        }])
      });
    },
    navigateDiagnostic(bufferId, direction) {
      const buffer = state.project.buffers[bufferId];
      const diagnostics = visibleDiagnosticsFor(bufferId);
      if (buffer === undefined || diagnostics.length === 0) return;
      const caret = buffer.editor.caret.position.offset;
      const target = direction === 'next'
        ? diagnostics.find((diagnostic) => diagnostic.span.start > caret) ?? diagnostics[0]
        : [...diagnostics].toReversed().find((diagnostic) => diagnostic.span.start < caret) ?? diagnostics.at(-1);
      if (target !== undefined) {
        state = Object.freeze({
          ...state,
          navigator: Object.freeze({ ...state.navigator, mode: 'diagnostics', visible: true })
        });
        api.navigateTo(bufferId, target.span.start, true, target.span);
      }
    },
    applyCurrentDiagnosticFix() {
      const buffer = activeBuffer(state);
      const diagnostic = currentDiagnostic(true);
      if (buffer !== undefined && diagnostic !== undefined) api.applyDiagnosticFix(buffer.id, diagnostic.id);
    },
    ignoreCurrentDiagnosticRule() {
      const diagnostic = currentDiagnostic();
      if (diagnostic === undefined || state.diagnosticPreferences.ignoredRules.includes(diagnostic.rule)) return;
      state = Object.freeze({
        ...state,
        diagnosticPreferences: Object.freeze({
          ...state.diagnosticPreferences,
          ignoredRules: Object.freeze([...state.diagnosticPreferences.ignoredRules, diagnostic.rule])
        }),
        notice: Object.freeze({ status: 'success', message: `Ignored diagnostic rule ${diagnostic.rule}.` })
      });
      schedulePersistence();
    },
    cycleDiagnosticSeverity() {
      const previous = state.diagnosticPreferences.minimumSeverity;
      const minimumSeverity = previous === 'info' ? 'warning' : previous === 'warning' ? 'error' : 'info';
      state = Object.freeze({
        ...state,
        diagnosticPreferences: Object.freeze({ ...state.diagnosticPreferences, minimumSeverity }),
        notice: Object.freeze({ status: 'success', message: `Showing ${minimumSeverity} and higher diagnostics.` })
      });
      schedulePersistence();
    },
    cycleDiagnosticSource() {
      const sources: readonly AppState['diagnosticPreferences']['source'][] = Object.freeze([
        'all', 'parser', 'markdown', 'spelling', 'grammar', 'links', 'assets', 'export'
      ]);
      const current = sources.indexOf(state.diagnosticPreferences.source);
      const source = sources[(current + 1) % sources.length] ?? 'all';
      state = Object.freeze({
        ...state,
        diagnosticPreferences: Object.freeze({ ...state.diagnosticPreferences, source }),
        notice: Object.freeze({ status: 'success', message: `Diagnostic source filter: ${source}.` })
      });
      schedulePersistence();
    },
    async refreshProjectDiagnostics() {
      await Promise.all(state.project.bufferOrder.map((bufferId) => api.refreshDiagnostics(bufferId)));
    },
    async addCurrentWordToDictionary() {
      const buffer = activeBuffer(state);
      const diagnostic = currentDiagnostic();
      if (buffer === undefined || diagnostic?.source !== 'spelling' || options.wordDictionary === undefined) {
        throw new Error('No spelling diagnostic or writable dictionary is available.');
      }
      const word = textDocumentText(buffer.editor.document).slice(diagnostic.span.start, diagnostic.span.end);
      const added = await addPersonalDictionaryWord(personalDictionaryPath, options.wordDictionary, word);
      if (added) await api.refreshDiagnostics(buffer.id);
      state = Object.freeze({
        ...state,
        notice: Object.freeze({ status: 'success', message: added ? `Added “${word}” to the personal dictionary.` : `“${word}” is already in the dictionary.` })
      });
    },
    async persistState() {
      assertActive();
      if (persistenceTimer !== undefined) {
        clearTimeout(persistenceTimer);
        persistenceTimer = undefined;
      }
      await writePersistence();
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      if (persistenceTimer !== undefined) {
        clearTimeout(persistenceTimer);
        persistenceTimer = undefined;
      }
      for (const controller of directoryReads.values()) controller.abort();
      directoryReads.clear();
      if (projectWatchTimer !== undefined) clearTimeout(projectWatchTimer);
      projectWatchTimer = undefined;
      pendingProjectIndexPaths.clear();
      forceFullProjectIndexRefresh = false;
      for (const watcher of projectWatchers.values()) watcher.close();
      projectWatchers.clear();
      projectIndexRead?.abort();
      projectIndexRead = undefined;
      cancelProjectSearchRead();
      for (const id of [...runtimes.keys()]) releaseBuffer(id);
      if (ownsPreviewResourcePool) previewResourcePool.clear();
      listeners.clear();
      await writePersistence();
    }
  };

  for (const buffer of Object.values(state.project.buffers)) {
    const parser = restoredParsers.get(buffer.id)
      ?? createBufferParser(textDocumentText(buffer.editor.document), buffer.sourceRevision, options.parseOptions);
    runtimes.set(buffer.id, createRuntime(parser));
    if (options.watchFiles !== false && buffer.path !== undefined) attachWatcher(buffer.id, buffer.path);
    schedulePreviewResources(buffer.id);
    scheduleDiagnostics(buffer.id);
  }
  return Object.freeze(api);
}

export async function restoreVellumApplication(
  sessionStore: SessionStore,
  recoveryStore: RecoveryStore,
  options: Omit<VellumApplicationOptions, 'initialState' | 'sessionStore' | 'recoveryStore'> = {}
): Promise<VellumApplication> {
  const [session, recovery] = await Promise.all([sessionStore.read(), recoveryStore.read()]);
  const recovered = await restoreApplicationSeed(session, recovery);
  const startupDiagnostics = Object.freeze([
    ...(options.startupDiagnostics ?? []),
    ...sessionStore.diagnostics().map((message) => Object.freeze({ source: 'session' as const, severity: 'error' as const, message })),
    ...recoveryStore.diagnostics().map((message) => Object.freeze({ source: 'recovery' as const, severity: 'error' as const, message })),
    ...recovered.diagnostics.map((message) => Object.freeze({ source: 'session' as const, severity: 'warning' as const, message }))
  ]);
  const application = instantiateVellumApplication(
    {
      ...options,
      sessionStore,
      recoveryStore,
      ...(session === undefined ? {} : { sessionRecord: session }),
      ...(recovery === undefined ? {} : { recoveryJournal: recovery }),
      initialState: recovered.state,
      startupDiagnostics
    },
    recovered.parsers
  );
  try {
    if (recovered.state.project.rootDirectory !== undefined) {
      await application.refreshFileTree();
      const pending = [...application.state().project.fileTree.pendingExpansionIds]
        .toSorted((left, right) => left.split(path.sep).length - right.split(path.sep).length);
      for (const directory of pending) {
        if (application.state().project.fileTree.nodes[directory]?.kind === 'directory') {
          await application.loadFileTreeDirectory(directory);
        }
      }
    }
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

function applyProjectLinkChanges(
  source: string,
  changes: readonly { readonly start: number; readonly end: number; readonly replacement: string }[]
): string {
  let result = source;
  for (const change of [...changes].toSorted((left, right) => right.start - left.start)) {
    result = result.slice(0, change.start) + change.replacement + result.slice(change.end);
  }
  return result;
}

function remapMovedPath(candidate: string, source: string, destination: string): string {
  if (candidate === source) return destination;
  return pathIsWithin(source, candidate)
    ? path.join(destination, path.relative(source, candidate))
    : candidate;
}

function pathIsWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function findRenamedPath(
  index: AppState['project']['index'],
  previous: ExternalFileFingerprint
): Promise<string | undefined> {
  for (const filePath of index.orderedPaths) {
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
  if (commandId === 'navigate.nextDiagnostic' || commandId === 'navigate.previousDiagnostic') {
    const id = application.state().project.activeBufferId;
    if (id !== undefined) application.navigateDiagnostic(id, commandId === 'navigate.nextDiagnostic' ? 'next' : 'previous');
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
