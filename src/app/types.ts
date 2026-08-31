import type {
  CommandInputState,
  ScrollState,
  SplitPaneState,
  TextAreaState
} from '@ismail-elkorchi/terminal-ui/behavior';
import type {
  MarkdownDiagnostic,
  MarkdownSessionSnapshot,
  MarkdownSessionUpdate,
  MarkdownTreeIndex,
  SourceSpan
} from 'markspan';

export type BufferId = string;
export type EditorMode = 'source' | 'hybrid';
export type PaneArrangement = 'editor' | 'preview' | 'editorPreview';
export type NavigatorMode = 'files' | 'outline' | 'search' | 'diagnostics' | 'backlinks' | 'properties' | 'export';
export type CommandId =
  | 'application.commandPalette'
  | 'application.quit'
  | 'file.new'
  | 'file.open'
  | 'file.openDirectory'
  | 'file.save'
  | 'file.saveAs'
  | 'file.saveAll'
  | 'file.close'
  | 'file.reopenClosed'
  | 'file.quickOpen'
  | 'file.searchProjectDirectory'
  | 'file.createProjectFile'
  | 'file.createProjectDirectory'
  | 'file.renameProjectEntry'
  | 'file.moveProjectEntry'
  | 'file.duplicateProjectEntry'
  | 'file.trashProjectEntry'
  | 'file.copyRelativePath'
  | 'file.copyAbsolutePath'
  | 'file.importAsset'
  | 'file.importClipboardAsset'
  | 'file.findUnusedAssets'
  | 'file.refreshProjectEntry'
  | 'file.revealProjectEntry'
  | 'file.filterProjectTree'
  | 'file.cycleProjectTreeSort'
  | 'file.pinProject'
  | 'file.openRecentProject'
  | 'edit.undo'
  | 'edit.redo'
  | 'edit.find'
  | 'edit.replace'
  | 'edit.complete'
  | 'navigate.outline'
  | 'navigate.back'
  | 'navigate.forward'
  | 'navigate.goToLine'
  | 'navigate.nextHeading'
  | 'navigate.previousHeading'
  | 'navigate.nextDiagnostic'
  | 'navigate.previousDiagnostic'
  | 'diagnostics.applyFix'
  | 'diagnostics.ignoreRule'
  | 'diagnostics.cycleSeverity'
  | 'diagnostics.cycleSource'
  | 'diagnostics.refreshDocument'
  | 'diagnostics.refreshProject'
  | 'diagnostics.addWord'
  | 'view.editorSource'
  | 'view.editorHybrid'
  | 'view.preview'
  | 'view.editorPreview'
  | 'view.toggleNavigator'
  | 'view.navigatorFiles'
  | 'view.navigatorOutline'
  | 'view.navigatorSearch'
  | 'view.navigatorDiagnostics'
  | 'view.navigatorBacklinks'
  | 'view.navigatorProperties'
  | 'view.navigatorExport'
  | 'view.toggleFocusMode'
  | 'view.toggleTypewriterMode'
  | 'view.toggleDistractionFreeMode'
  | 'markdown.toggleStrong'
  | 'markdown.toggleEmphasis'
  | 'markdown.toggleInlineCode'
  | 'markdown.insertLink'
  | 'markdown.toggleTask'
  | 'markdown.promoteHeading'
  | 'markdown.demoteHeading'
  | 'markdown.insertCodeFence'
  | 'markdown.moveBlockUp'
  | 'markdown.moveBlockDown'
  | 'markdown.duplicateBlock'
  | 'markdown.formatTable'
  | 'markdown.nextTableCell'
  | 'markdown.previousTableCell'
  | 'markdown.addTableRow'
  | 'markdown.addTableColumn'
  | 'markdown.deleteTableRow'
  | 'markdown.deleteTableColumn'
  | 'export.activeBuffer'
  | 'export.batchDirectory'
  | 'export.projectManifest'
  | 'export.repeatLast'
  | 'export.cancel';

export interface DocumentMetrics {
  readonly wordCount: number;
  readonly headingCount: number;
  readonly linkCount: number;
  readonly taskCount: number;
}

export interface ReadyMarkdownPreview {
  readonly kind: 'ready';
  readonly sourceRevision: number;
  readonly identity: object;
  readonly snapshot: MarkdownSessionSnapshot;
  readonly treeIndex: MarkdownTreeIndex;
  readonly metrics: DocumentMetrics;
  readonly metricUpdate: DocumentMetricUpdate;
  readonly update?: MarkdownSessionUpdate;
}

export interface DocumentMetricUpdate {
  readonly reusedNodes: number;
  readonly recomputedNodes: number;
  readonly removedNodes: number;
}

export interface FailedMarkdownPreview {
  readonly kind: 'failed';
  readonly sourceRevision: number;
  readonly message: string;
  readonly diagnostics: readonly MarkdownDiagnostic[];
}

export type MarkdownPreview = ReadyMarkdownPreview | FailedMarkdownPreview;

export interface ExternalFileFingerprint {
  readonly realPath: string;
  readonly device: string;
  readonly inode: string;
  readonly size: number;
  readonly modifiedNanoseconds: string;
  readonly contentHash: string;
}

export type ExternalFileState =
  | { readonly kind: 'untracked' }
  | { readonly kind: 'current'; readonly fingerprint: ExternalFileFingerprint }
  | { readonly kind: 'conflict'; readonly disk: ExternalFileFingerprint }
  | { readonly kind: 'deleted'; readonly previous: ExternalFileFingerprint };

export interface FileFormat {
  readonly bom: boolean;
  readonly lineEnding: 'lf' | 'crlf';
  readonly permissionMode?: number;
}

export interface BufferState {
  readonly id: BufferId;
  readonly path?: string;
  readonly label: string;
  readonly editor: TextAreaState;
  readonly sourceRevision: number;
  readonly savedRevision: number;
  readonly preview: MarkdownPreview;
  /** Monotonic identity for asynchronously completed preview resources. */
  readonly previewResourceRevision: number;
  readonly previewScroll: ScrollState;
  readonly externalFileState: ExternalFileState;
  readonly format: FileFormat;
}

export interface FileTreeNode {
  readonly id: string;
  readonly path: string;
  readonly label: string;
  readonly kind: 'directory' | 'file';
  readonly parentId?: string;
  readonly loaded: boolean;
  readonly loading: boolean;
  readonly children: readonly string[];
}

export interface FileTreeState {
  readonly nodes: Readonly<Record<string, FileTreeNode>>;
  readonly rootIds: readonly string[];
  readonly expandedIds: readonly string[];
  readonly pendingExpansionIds: readonly string[];
  readonly activeId?: string;
  readonly exclusionPatterns: readonly string[];
  readonly filter: string;
  readonly sort: 'foldersFirst' | 'nameAscending' | 'nameDescending';
  readonly scroll: ScrollState;
  readonly revision: number;
}

export interface ProjectHeadingIndexEntry {
  readonly text: string;
  readonly depth: number;
  readonly sourceOffset: number;
}

export interface ProjectLinkIndexEntry {
  readonly destination: string;
  readonly sourceSpan: SourceSpan;
}

export interface ProjectDocumentIndexEntry {
  readonly path: string;
  readonly relativePath: string;
  readonly size: number;
  readonly modifiedMilliseconds: number;
  readonly contentHash: string;
  readonly headings: readonly ProjectHeadingIndexEntry[];
  readonly links: readonly ProjectLinkIndexEntry[];
  readonly properties: Readonly<Record<string, string | number | boolean | readonly string[]>>;
  readonly taskStates: readonly boolean[];
  readonly tags: readonly string[];
  readonly citationKeys: readonly string[];
  readonly searchableText: string;
}

export interface ProjectIndexState {
  readonly documents: Readonly<Record<string, ProjectDocumentIndexEntry>>;
  readonly orderedPaths: readonly string[];
  readonly assetPaths: readonly string[];
  readonly indexing: boolean;
  readonly revision: number;
  readonly lastError?: string;
}

export interface ClosedBufferRecord {
  readonly path?: string;
  readonly label: string;
  readonly editor: TextAreaState;
  readonly sourceRevision: number;
  readonly savedRevision: number;
  readonly previewScroll: ScrollState;
  readonly externalFileState: ExternalFileState;
  readonly format: FileFormat;
}

export interface ProjectState {
  readonly rootDirectory?: string;
  readonly fileTree: FileTreeState;
  readonly index: ProjectIndexState;
  readonly buffers: Readonly<Record<BufferId, BufferState>>;
  readonly bufferOrder: readonly BufferId[];
  readonly activeBufferId?: BufferId;
  readonly recentlyClosed: readonly ClosedBufferRecord[];
  readonly recentlyOpenedPaths: readonly string[];
  readonly unusedAssets: readonly string[];
  readonly recentProjects: readonly string[];
  readonly pinnedProjects: readonly string[];
}

export interface NavigationLocation {
  readonly bufferId: BufferId;
  readonly sourceOffset: number;
  readonly selection?: SourceSpan;
}

export interface NavigationHistory {
  readonly back: readonly NavigationLocation[];
  readonly forward: readonly NavigationLocation[];
}

export interface CommandPaletteState {
  readonly kind: 'commandPalette';
  readonly command: CommandInputState;
  readonly error?: string;
}

export interface QuickOpenState {
  readonly kind: 'quickOpen';
  readonly command: CommandInputState;
  readonly error?: string;
}

export interface CompletionDialogState {
  readonly kind: 'completion';
  readonly command: CommandInputState;
  readonly bufferId: BufferId;
  readonly entries: readonly {
    readonly id: string;
    readonly label: string;
    readonly detail: string;
    readonly replacement: string;
    readonly range: SourceSpan;
  }[];
  readonly error?: string;
}

export interface RecentProjectDialogState {
  readonly kind: 'recentProject';
  readonly command: CommandInputState;
  readonly entries: readonly { readonly id: string; readonly label: string; readonly detail: string }[];
  readonly error?: string;
}

export interface RecoverySelectionDialogState {
  readonly kind: 'recoverySelection';
  readonly command: CommandInputState;
  readonly entries: readonly { readonly id: string; readonly label: string; readonly detail: string; readonly generation: number }[];
  readonly error?: string;
}

export interface DirtyBufferDialogState {
  readonly kind: 'dirtyBuffer';
  readonly bufferIds: readonly BufferId[];
  readonly closeApplication: boolean;
}

export interface ExternalConflictDialogState {
  readonly kind: 'externalConflict';
  readonly bufferId: BufferId;
  readonly comparison?: readonly {
    readonly kind: 'unchanged' | 'added' | 'removed';
    readonly text: string;
  }[];
}

export interface DocumentSearchDialogState {
  readonly kind: 'documentSearch';
  readonly query: CommandInputState;
  readonly replacement?: CommandInputState;
  readonly regularExpression: boolean;
  readonly caseSensitive: boolean;
  readonly wholeWord: boolean;
  readonly selectionOnly: boolean;
  readonly selectionSpan?: SourceSpan;
  readonly matches: readonly SourceSpan[];
  readonly selectedIndex?: number;
  readonly error?: string;
}

export interface ProjectDirectorySearchDialogState {
  readonly kind: 'projectDirectorySearch';
  readonly query: CommandInputState;
  readonly searching: boolean;
  readonly results: readonly {
    readonly path: string;
    readonly line: number;
    readonly column: number;
    readonly span: SourceSpan;
    readonly context: string;
  }[];
  readonly error?: string;
}

export interface PersistentProjectSearchState {
  readonly query: string;
  readonly recentQueries: readonly string[];
  readonly searching: boolean;
  readonly results: ProjectDirectorySearchDialogState['results'];
  readonly error?: string;
}

export interface OutlineDialogState {
  readonly kind: 'outline';
  readonly query: CommandInputState;
  readonly entries: readonly {
    readonly nodeId: number;
    readonly depth: number;
    readonly title: string;
    readonly sourceOffset: number;
    readonly active: boolean;
  }[];
}

export interface GoToLineDialogState {
  readonly kind: 'goToLine';
  readonly command: CommandInputState;
  readonly error?: string;
}

export interface ExportDialogState {
  readonly kind: 'exportProfile';
  readonly scope: 'activeBuffer' | 'batchDirectory';
  readonly command: CommandInputState;
  readonly error?: string;
}

export interface FilePathDialogState {
  readonly kind: 'filePath';
  readonly operation:
    | 'openFile'
    | 'openProjectDirectory'
    | 'saveAs'
    | 'createProjectFile'
    | 'createProjectDirectory'
    | 'renameProjectEntry'
    | 'moveProjectEntry'
    | 'duplicateProjectEntry'
    | 'importAsset'
    | 'filterProjectTree';
  readonly projectSourcePath?: string;
  readonly command: CommandInputState;
  readonly afterSave?:
    | { readonly kind: 'closeBuffer'; readonly bufferId: BufferId }
    | { readonly kind: 'saveAll'; readonly bufferIds: readonly BufferId[] }
    | { readonly kind: 'closeApplication'; readonly bufferIds: readonly BufferId[] };
  readonly error?: string;
}

export type DialogState =
  | CommandPaletteState
  | QuickOpenState
  | CompletionDialogState
  | RecentProjectDialogState
  | RecoverySelectionDialogState
  | DirtyBufferDialogState
  | ExternalConflictDialogState
  | DocumentSearchDialogState
  | ProjectDirectorySearchDialogState
  | OutlineDialogState
  | GoToLineDialogState
  | ExportDialogState
  | FilePathDialogState;

export interface CommandState {
  readonly navigation: NavigationHistory;
}

export interface Notice {
  readonly status: 'info' | 'success' | 'warning' | 'error';
  readonly message: string;
}

export interface ConfigurationDiagnostic {
  readonly source: 'keymap' | 'theme' | 'exportProfiles' | 'session' | 'recovery';
  readonly severity: 'warning' | 'error';
  readonly message: string;
}

export interface NavigatorState {
  readonly mode: NavigatorMode;
  readonly visible: boolean;
  readonly width: number;
}

export interface WritingModeState {
  readonly focus: boolean;
  readonly typewriter: boolean;
  readonly distractionFree: boolean;
  readonly typewriterAnchor: number;
}

export interface VellumDiagnosticFix {
  readonly label: string;
  readonly replacement: string;
  readonly span: SourceSpan;
}

export interface VellumDiagnostic {
  readonly id: string;
  readonly source: 'parser' | 'markdown' | 'spelling' | 'grammar' | 'links' | 'assets' | 'export';
  readonly severity: 'info' | 'warning' | 'error';
  readonly span: SourceSpan;
  readonly message: string;
  readonly providerRevision: number;
  readonly rule: string;
  readonly fixes: readonly VellumDiagnosticFix[];
}

export interface ExportHistoryEntry {
  readonly id: string;
  readonly scope: 'activeBuffer' | 'batchDirectory' | 'projectManifest';
  readonly profileId: string;
  readonly status: 'running' | 'succeeded' | 'failed' | 'cancelled';
  readonly startedAt: string;
  readonly elapsedMilliseconds?: number;
  readonly outputPaths: readonly string[];
  readonly standardError: string;
  readonly usedUnsavedSource: boolean;
  readonly error?: string;
}

export interface ExportState {
  readonly activeId?: string;
  readonly history: readonly ExportHistoryEntry[];
  readonly lastRequest?: { readonly scope: ExportHistoryEntry['scope']; readonly profileId: string };
}

export interface AppState {
  readonly project: ProjectState;
  readonly paneArrangement: PaneArrangement;
  readonly editorMode: EditorMode;
  readonly splitPane: SplitPaneState;
  readonly navigator: NavigatorState;
  readonly writingMode: WritingModeState;
  readonly projectSearch: PersistentProjectSearchState;
  readonly diagnostics: Readonly<Record<BufferId, readonly VellumDiagnostic[]>>;
  readonly diagnosticPreferences: {
    readonly minimumSeverity: 'info' | 'warning' | 'error';
    readonly source: VellumDiagnostic['source'] | 'all';
    readonly ignoredRules: readonly string[];
  };
  readonly exports: ExportState;
  readonly commandState: CommandState;
  readonly configurationDiagnostics: readonly ConfigurationDiagnostic[];
  readonly dialogState?: DialogState;
  readonly notice?: Notice;
}

export function activeBuffer(state: AppState): BufferState | undefined {
  const id = state.project.activeBufferId;
  return id === undefined ? undefined : state.project.buffers[id];
}

export function bufferIsDirty(buffer: BufferState): boolean {
  return buffer.sourceRevision !== buffer.savedRevision;
}
