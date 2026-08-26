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
export type ActivePane = 'editor' | 'preview' | 'fileTree';
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
  | 'edit.undo'
  | 'edit.redo'
  | 'edit.find'
  | 'edit.replace'
  | 'navigate.outline'
  | 'navigate.back'
  | 'navigate.forward'
  | 'navigate.goToLine'
  | 'navigate.nextHeading'
  | 'navigate.previousHeading'
  | 'view.editorSource'
  | 'view.editorHybrid'
  | 'view.preview'
  | 'view.editorPreview'
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
  | 'export.projectDirectory';

export interface DocumentMetrics {
  readonly wordCount: number;
  readonly headingCount: number;
  readonly linkCount: number;
  readonly taskCount: number;
}

export interface PreviewBlock {
  readonly nodeId: number;
  readonly kind: string;
  readonly sourceSpan: SourceSpan;
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
  readonly reusedBlocks: number;
  readonly recomputedBlocks: number;
  readonly removedBlocks: number;
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
  readonly dirty: boolean;
  readonly preview: MarkdownPreview;
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
  readonly indexedFiles: readonly string[];
  readonly expandedIds: readonly string[];
  readonly activeId?: string;
  readonly exclusionPatterns: readonly string[];
  readonly scroll: ScrollState;
  readonly revision: number;
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
  readonly buffers: Readonly<Record<BufferId, BufferState>>;
  readonly bufferOrder: readonly BufferId[];
  readonly activeBufferId?: BufferId;
  readonly recentlyClosed: readonly ClosedBufferRecord[];
  readonly recentlyOpenedPaths: readonly string[];
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
  readonly scope: 'activeBuffer' | 'projectDirectory';
  readonly command: CommandInputState;
  readonly error?: string;
}

export interface FilePathDialogState {
  readonly kind: 'filePath';
  readonly operation: 'openFile' | 'openProjectDirectory' | 'saveAs';
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
  | DirtyBufferDialogState
  | ExternalConflictDialogState
  | DocumentSearchDialogState
  | ProjectDirectorySearchDialogState
  | OutlineDialogState
  | GoToLineDialogState
  | ExportDialogState
  | FilePathDialogState;

export interface CommandState {
  readonly activePane: ActivePane;
  readonly navigation: NavigationHistory;
}

export interface Notice {
  readonly status: 'info' | 'success' | 'warning' | 'error';
  readonly message: string;
}

export interface AppState {
  readonly project: ProjectState;
  readonly paneArrangement: PaneArrangement;
  readonly editorMode: EditorMode;
  readonly splitPane: SplitPaneState;
  readonly commandState: CommandState;
  readonly dialogState?: DialogState;
  readonly notice?: Notice;
}

export function activeBuffer(state: AppState): BufferState | undefined {
  const id = state.project.activeBufferId;
  return id === undefined ? undefined : state.project.buffers[id];
}
