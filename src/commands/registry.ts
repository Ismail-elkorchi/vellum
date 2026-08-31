import {
  createCommandInputState,
  createSplitPaneState,
  createCommandSuggestions
} from '@ismail-elkorchi/terminal-ui/behavior';
import type { BindableKeyName } from '@ismail-elkorchi/terminal-ui/input';
import type { AppState, CommandId } from '../app/types.js';
import { activeBuffer, bufferIsDirty } from '../app/types.js';
import { createFileTreeState } from '../project/file-tree.js';
import { extractMarkdownOutline, markdownPathAt, type MarkdownNode } from 'markspan';
import { markdownCompletions } from '../editing/completion.js';

export interface KeyBinding {
  readonly key: BindableKeyName;
  readonly ctrl?: boolean;
  readonly alt?: boolean;
  readonly shift?: boolean;
  readonly meta?: boolean;
}

export type VellumEffect =
  | { readonly kind: 'newFile' }
  | { readonly kind: 'save' }
  | { readonly kind: 'saveAll' }
  | { readonly kind: 'closeBuffer' }
  | { readonly kind: 'reopenClosed' }
  | { readonly kind: 'trashProjectEntry'; readonly path: string }
  | { readonly kind: 'copyProjectPath'; readonly path: string; readonly relative: boolean }
  | { readonly kind: 'importClipboardAsset' }
  | { readonly kind: 'findUnusedAssets' }
  | { readonly kind: 'exportProjectManifest' }
  | { readonly kind: 'repeatLastExport' }
  | { readonly kind: 'cancelExport' }
  | { readonly kind: 'refreshProjectEntry'; readonly path: string }
  | { readonly kind: 'revealProjectEntry'; readonly path: string }
  | { readonly kind: 'cycleFileTreeSort' }
  | { readonly kind: 'pinProject' }
  | { readonly kind: 'diagnosticAction'; readonly action: 'applyFix' | 'ignoreRule' | 'cycleSeverity' | 'cycleSource' }
  | { readonly kind: 'refreshDiagnostics'; readonly scope: 'document' | 'project' }
  | { readonly kind: 'addDiagnosticWord' }
  | { readonly kind: 'textEdit'; readonly commandId: CommandId }
  | { readonly kind: 'navigate'; readonly commandId: CommandId }
  | { readonly kind: 'quit' };

export interface AppUpdate {
  readonly state: AppState;
  readonly effects: readonly VellumEffect[];
}

export interface VellumCommand {
  readonly id: CommandId;
  readonly title: string;
  readonly category: string;
  readonly defaultBindings: readonly KeyBinding[];
  enabled(state: AppState): boolean;
  execute(state: AppState): AppUpdate;
}

const noBindings: readonly KeyBinding[] = Object.freeze([]);
const enabled = (): boolean => true;
const hasBuffer = (state: AppState): boolean => activeBuffer(state) !== undefined;
const hasDirtyActiveBuffer = (state: AppState): boolean => {
  const buffer = activeBuffer(state);
  return buffer !== undefined && bufferIsDirty(buffer);
};
const hasUndo = (state: AppState): boolean => (activeBuffer(state)?.editor.history.undo.length ?? 0) > 0;
const hasRedo = (state: AppState): boolean => (activeBuffer(state)?.editor.history.redo.length ?? 0) > 0;
const hasDirtyBuffer = (state: AppState): boolean => Object.values(state.project.buffers).some(bufferIsDirty);
const effect = (state: AppState, value: VellumEffect): AppUpdate => Object.freeze({
  state,
  effects: Object.freeze([value])
});
const stateOnly = (state: AppState): AppUpdate => Object.freeze({ state, effects: Object.freeze([]) });
const filePathDialog = (
  state: AppState,
  operation: Extract<NonNullable<AppState['dialogState']>, { kind: 'filePath' }>['operation'],
  projectSourcePath?: string
): AppUpdate => stateOnly(Object.freeze({
  ...state,
  dialogState: Object.freeze({
    kind: 'filePath',
    operation,
    ...(projectSourcePath === undefined ? {} : { projectSourcePath }),
    command: createCommandInputState({ value: '', suggestions: createCommandSuggestions([]) })
  })
}));
const selectedProjectPath = (state: AppState): string | undefined => {
  const id = state.project.fileTree.activeId;
  const node = id === undefined ? undefined : state.project.fileTree.nodes[id];
  return node === undefined || node.path === state.project.rootDirectory ? undefined : node.path;
};
const hasProject = (state: AppState): boolean => state.project.rootDirectory !== undefined;
const hasSelectedProjectEntry = (state: AppState): boolean => selectedProjectPath(state) !== undefined;
const activeProjectPath = (state: AppState): string | undefined => {
  const activeId = state.project.fileTree.activeId;
  return activeId === undefined ? state.project.rootDirectory : state.project.fileTree.nodes[activeId]?.path;
};
const searchInput = (value = '') => createCommandInputState({ value, suggestions: createCommandSuggestions([]) });
const visibleDiagnostics = (state: AppState) => {
  const id = state.project.activeBufferId;
  if (id === undefined) return Object.freeze([]);
  const ranks = { info: 0, warning: 1, error: 2 } as const;
  return (state.diagnostics[id] ?? []).filter((diagnostic) => (
    ranks[diagnostic.severity] >= ranks[state.diagnosticPreferences.minimumSeverity]
    && (state.diagnosticPreferences.source === 'all' || diagnostic.source === state.diagnosticPreferences.source)
    && !state.diagnosticPreferences.ignoredRules.includes(diagnostic.rule)
  ));
};
const documentSearchDialog = (state: AppState, replace: boolean): AppUpdate => stateOnly(Object.freeze({
  ...state,
  dialogState: Object.freeze({
    kind: 'documentSearch',
    query: searchInput(),
    ...(replace ? { replacement: searchInput() } : {}),
    regularExpression: false,
    caseSensitive: false,
    wholeWord: false,
    selectionOnly: false,
    matches: Object.freeze([])
  })
}));
const exportDialog = (state: AppState, scope: 'activeBuffer' | 'batchDirectory'): AppUpdate => {
  return stateOnly(Object.freeze({
    ...state,
    dialogState: Object.freeze({
      kind: 'exportProfile',
      scope,
      command: createCommandInputState({ value: '', suggestions: createCommandSuggestions([]) })
    })
  }));
};

const completionDialog = (state: AppState): AppUpdate => {
  const buffer = activeBuffer(state);
  if (buffer === undefined) return stateOnly(state);
  const entries = markdownCompletions(buffer, state.project.index);
  return stateOnly(Object.freeze({
    ...state,
    dialogState: Object.freeze({
      kind: 'completion',
      bufferId: buffer.id,
      entries,
      command: createCommandInputState({
        value: '',
        suggestions: createCommandSuggestions(entries.map((entry) => ({
          id: entry.id,
          label: entry.label,
          description: entry.detail,
          completion: { range: { startOffset: 0, endOffsetExclusive: 0 }, text: entry.id }
        })))
      }),
      ...(entries.length === 0 ? { error: 'No completion is available at the caret.' } : {})
    })
  }));
};

function syntaxPath(state: AppState): readonly MarkdownNode[] {
  const buffer = activeBuffer(state);
  return buffer?.preview.kind === 'ready'
    ? markdownPathAt(buffer.preview.snapshot.document.tree, buffer.editor.caret.position.offset, { includeEnd: true })
    : Object.freeze([]);
}

function hasSyntaxContext(state: AppState, kind: MarkdownNode['kind']): boolean {
  return syntaxPath(state).some((node) => node.kind === kind);
}

function hasReadyBuffer(state: AppState): boolean {
  return activeBuffer(state)?.preview.kind === 'ready';
}

function inlineMarkdownEnabled(state: AppState): boolean {
  return hasReadyBuffer(state) && !syntaxPath(state).some((node) => (
    node.kind === 'codeBlock' || node.kind === 'mathBlock' || node.kind === 'htmlBlock'
  ));
}

function headingCommandEnabled(state: AppState, direction: 'promote' | 'demote'): boolean {
  const heading = syntaxPath(state).findLast((node) => node.kind === 'heading');
  return heading?.kind === 'heading' && (direction === 'promote' ? heading.depth > 1 : heading.depth < 6);
}

function moveBlockEnabled(state: AppState, direction: -1 | 1): boolean {
  const buffer = activeBuffer(state);
  if (buffer?.preview.kind !== 'ready') return false;
  const caret = buffer.editor.caret.position.offset;
  const blocks = buffer.preview.snapshot.document.tree.children;
  const index = blocks.findIndex((block) => block.span.start <= caret && caret <= block.span.end);
  return index >= 0 && index + direction >= 0 && index + direction < blocks.length;
}

function hasTopLevelBlock(state: AppState): boolean {
  const buffer = activeBuffer(state);
  if (buffer?.preview.kind !== 'ready') return false;
  const caret = buffer.editor.caret.position.offset;
  return buffer.preview.snapshot.document.tree.children.some((block) => (
    block.span.start <= caret && caret <= block.span.end
  ));
}

function tableCellMovementEnabled(state: AppState, direction: -1 | 1): boolean {
  const path = syntaxPath(state);
  const table = path.findLast((node) => node.kind === 'table');
  const cell = path.findLast((node) => node.kind === 'tableCell');
  if (table?.kind !== 'table' || cell?.kind !== 'tableCell') return false;
  const cells = [table.header, ...table.rows].flatMap((row) => row.cells);
  const index = cells.findIndex((candidate) => candidate.id === cell.id);
  return cells[index + direction] !== undefined;
}

function tableRowDeletionEnabled(state: AppState): boolean {
  const path = syntaxPath(state);
  const table = path.findLast((node) => node.kind === 'table');
  const row = path.findLast((node) => node.kind === 'tableRow');
  return table?.kind === 'table' && row?.kind === 'tableRow'
    && table.rows.some((candidate) => candidate.id === row.id);
}

function tableColumnDeletionEnabled(state: AppState): boolean {
  const table = syntaxPath(state).findLast((node) => node.kind === 'table');
  return table?.kind === 'table' && table.align.length > 1;
}

function hasHeadingDestination(state: AppState, direction: 'next' | 'previous'): boolean {
  const buffer = activeBuffer(state);
  if (buffer?.preview.kind !== 'ready') return false;
  const caret = buffer.editor.caret.position.offset;
  const headings = extractMarkdownOutline(buffer.preview.snapshot.document.tree).flatMap(flattenOutline);
  return direction === 'next'
    ? headings.some((heading) => heading.span.start > caret)
    : headings.some((heading) => heading.span.start < caret);
}

function flattenOutline(
  entry: ReturnType<typeof extractMarkdownOutline>[number]
): readonly ReturnType<typeof extractMarkdownOutline>[number][] {
  return Object.freeze([entry, ...entry.children.flatMap(flattenOutline)]);
}

function command(
  id: CommandId,
  title: string,
  category: string,
  defaultBindings: readonly KeyBinding[],
  isEnabled: (state: AppState) => boolean,
  execute: (state: AppState) => AppUpdate
): VellumCommand {
  return Object.freeze({
    id,
    title,
    category,
    defaultBindings: Object.freeze(defaultBindings.map((binding) => Object.freeze({ ...binding }))),
    enabled: isEnabled,
    execute
  });
}

const definitions: readonly VellumCommand[] = Object.freeze([
  command('application.commandPalette', 'Command Palette', 'Application', [{ key: 'f1' }], enabled, (state) => stateOnly(Object.freeze({
    ...state,
    dialogState: Object.freeze({
      kind: 'commandPalette',
      command: createCommandInputState({ value: '', suggestions: createCommandSuggestions([]) })
    })
  }))),
  command('application.quit', 'Quit Vellum', 'Application', [{ key: 'q', ctrl: true }], enabled, (state) => effect(state, { kind: 'quit' })),
  command('file.new', 'New File', 'File', [{ key: 'n', ctrl: true }], enabled, (state) => effect(state, { kind: 'newFile' })),
  command('file.open', 'Open File', 'File', [{ key: 'o', ctrl: true }], enabled, (state) => filePathDialog(state, 'openFile')),
  command('file.openDirectory', 'Open Project Directory', 'File', [{ key: 'd', alt: true }], enabled, (state) => filePathDialog(state, 'openProjectDirectory')),
  command('file.save', 'Save', 'File', [{ key: 's', ctrl: true }], hasDirtyActiveBuffer, (state) => activeBuffer(state)?.path === undefined
    ? filePathDialog(state, 'saveAs')
    : effect(state, { kind: 'save' })),
  command('file.saveAs', 'Save As', 'File', [{ key: 's', alt: true }], hasBuffer, (state) => filePathDialog(state, 'saveAs')),
  command('file.saveAll', 'Save All', 'File', [{ key: 'a', alt: true }], hasDirtyBuffer, (state) => effect(state, { kind: 'saveAll' })),
  command('file.close', 'Close Active Buffer', 'File', [{ key: 'w', ctrl: true }], hasBuffer, (state) => effect(state, { kind: 'closeBuffer' })),
  command('file.reopenClosed', 'Reopen Recently Closed Buffer', 'File', [{ key: 'r', alt: true }], (state) => state.project.recentlyClosed.length > 0, (state) => effect(state, { kind: 'reopenClosed' })),
  command('file.quickOpen', 'Quick Open', 'File', [{ key: 'p', ctrl: true }], (state) => state.project.rootDirectory !== undefined, (state) => stateOnly(Object.freeze({
    ...state,
    dialogState: Object.freeze({
      kind: 'quickOpen',
      command: createCommandInputState({ value: '', suggestions: createCommandSuggestions([]) })
    })
  }))),
  command('file.searchProjectDirectory', 'Search Project Directory', 'File', [{ key: 'f3' }], (state) => state.project.rootDirectory !== undefined, (state) => stateOnly(Object.freeze({
    ...state,
    dialogState: Object.freeze({ kind: 'projectDirectorySearch', query: searchInput(state.projectSearch.query), searching: false, results: state.projectSearch.results })
  }))),
  command('file.createProjectFile', 'Create Project File', 'File', noBindings, hasProject, (state) => filePathDialog(state, 'createProjectFile')),
  command('file.createProjectDirectory', 'Create Project Directory', 'File', noBindings, hasProject, (state) => filePathDialog(state, 'createProjectDirectory')),
  command('file.renameProjectEntry', 'Rename Project Entry', 'File', noBindings, hasSelectedProjectEntry, (state) => filePathDialog(state, 'renameProjectEntry', selectedProjectPath(state))),
  command('file.moveProjectEntry', 'Move Project Entry', 'File', noBindings, hasSelectedProjectEntry, (state) => filePathDialog(state, 'moveProjectEntry', selectedProjectPath(state))),
  command('file.duplicateProjectEntry', 'Duplicate Project Entry', 'File', noBindings, hasSelectedProjectEntry, (state) => filePathDialog(state, 'duplicateProjectEntry', selectedProjectPath(state))),
  command('file.trashProjectEntry', 'Move Project Entry to Trash', 'File', noBindings, hasSelectedProjectEntry, (state) => effect(state, {
    kind: 'trashProjectEntry',
    path: selectedProjectPath(state) as string
  })),
  command('file.copyRelativePath', 'Copy Project-Relative Path', 'File', noBindings, hasSelectedProjectEntry, (state) => effect(state, {
    kind: 'copyProjectPath',
    path: selectedProjectPath(state) as string,
    relative: true
  })),
  command('file.copyAbsolutePath', 'Copy Absolute Path', 'File', noBindings, hasSelectedProjectEntry, (state) => effect(state, {
    kind: 'copyProjectPath',
    path: selectedProjectPath(state) as string,
    relative: false
  })),
  command('file.importAsset', 'Import Image Asset', 'File', noBindings, (state) => hasProject(state) && hasBuffer(state), (state) => filePathDialog(state, 'importAsset')),
  command('file.importClipboardAsset', 'Import Clipboard Image', 'File', noBindings, (state) => hasProject(state) && hasBuffer(state), (state) => effect(state, { kind: 'importClipboardAsset' })),
  command('file.findUnusedAssets', 'Find Unused Image Assets', 'File', noBindings, hasProject, (state) => effect(state, { kind: 'findUnusedAssets' })),
  command('file.refreshProjectEntry', 'Refresh Selected Project Directory', 'File', noBindings, hasProject, (state) => effect(state, {
    kind: 'refreshProjectEntry', path: activeProjectPath(state) ?? state.project.rootDirectory as string
  })),
  command('file.revealProjectEntry', 'Reveal Project Entry Externally', 'File', noBindings, hasSelectedProjectEntry, (state) => effect(state, {
    kind: 'revealProjectEntry', path: selectedProjectPath(state) as string
  })),
  command('file.filterProjectTree', 'Filter Project Files', 'File', noBindings, hasProject, (state) => filePathDialog(state, 'filterProjectTree')),
  command('file.cycleProjectTreeSort', 'Cycle Project File Sort', 'File', noBindings, hasProject, (state) => effect(state, { kind: 'cycleFileTreeSort' })),
  command('file.pinProject', 'Pin or Unpin Current Project', 'File', noBindings, hasProject, (state) => effect(state, { kind: 'pinProject' })),
  command('file.openRecentProject', 'Open Recent Project', 'File', noBindings, (state) => state.project.recentProjects.length > 0 || state.project.pinnedProjects.length > 0, (state) => stateOnly(Object.freeze({
    ...state,
    dialogState: Object.freeze({
      kind: 'recentProject',
      command: searchInput(),
      entries: Object.freeze([...new Set([...state.project.pinnedProjects, ...state.project.recentProjects])].map((projectPath) => Object.freeze({
        id: projectPath,
        label: projectPath,
        detail: state.project.pinnedProjects.includes(projectPath) ? 'Pinned project' : 'Recent project'
      })))
    })
  }))),
  command('edit.undo', 'Undo', 'Edit', [{ key: 'z', ctrl: true }], hasUndo, (state) => effect(state, { kind: 'textEdit', commandId: 'edit.undo' })),
  command('edit.redo', 'Redo', 'Edit', [{ key: 'y', ctrl: true }], hasRedo, (state) => effect(state, { kind: 'textEdit', commandId: 'edit.redo' })),
  command('edit.find', 'Find in Source Document', 'Edit', [{ key: 'f', ctrl: true }], hasBuffer, (state) => documentSearchDialog(state, false)),
  command('edit.replace', 'Replace in Source Document', 'Edit', [{ key: 'r', ctrl: true }], hasBuffer, (state) => documentSearchDialog(state, true)),
  command('edit.complete', 'Complete Markdown Context', 'Edit', [{ key: 'f12' }], hasBuffer, completionDialog),
  command('navigate.outline', 'Open Outline', 'Navigate', [{ key: 'o', alt: true }], hasReadyBuffer, (state) => stateOnly(Object.freeze({
    ...state,
    dialogState: Object.freeze({ kind: 'outline', query: searchInput(), entries: Object.freeze([]) })
  }))),
  command('navigate.back', 'Navigate Back', 'Navigate', [{ key: 'arrowLeft', alt: true }], (state) => state.commandState.navigation.back.length > 0, (state) => effect(state, { kind: 'navigate', commandId: 'navigate.back' })),
  command('navigate.forward', 'Navigate Forward', 'Navigate', [{ key: 'arrowRight', alt: true }], (state) => state.commandState.navigation.forward.length > 0, (state) => effect(state, { kind: 'navigate', commandId: 'navigate.forward' })),
  command('navigate.goToLine', 'Go to Line', 'Navigate', [{ key: 'g', ctrl: true }], hasReadyBuffer, (state) => stateOnly(Object.freeze({
    ...state,
    dialogState: Object.freeze({ kind: 'goToLine', command: searchInput() })
  }))),
  command('navigate.nextHeading', 'Next Heading', 'Navigate', [{ key: 'f6' }], (state) => hasHeadingDestination(state, 'next'), (state) => effect(state, { kind: 'navigate', commandId: 'navigate.nextHeading' })),
  command('navigate.previousHeading', 'Previous Heading', 'Navigate', [{ key: 'f6', shift: true }], (state) => hasHeadingDestination(state, 'previous'), (state) => effect(state, { kind: 'navigate', commandId: 'navigate.previousHeading' })),
  command('navigate.nextDiagnostic', 'Next Diagnostic', 'Navigate', [{ key: 'f4' }], (state) => {
    const id = state.project.activeBufferId;
    return id !== undefined && (state.diagnostics[id]?.length ?? 0) > 0;
  }, (state) => effect(state, { kind: 'navigate', commandId: 'navigate.nextDiagnostic' })),
  command('navigate.previousDiagnostic', 'Previous Diagnostic', 'Navigate', [{ key: 'f4', shift: true }], (state) => {
    const id = state.project.activeBufferId;
    return id !== undefined && (state.diagnostics[id]?.length ?? 0) > 0;
  }, (state) => effect(state, { kind: 'navigate', commandId: 'navigate.previousDiagnostic' })),
  command('diagnostics.applyFix', 'Apply Diagnostic Fix', 'Diagnostics', noBindings, (state) => visibleDiagnostics(state).some((diagnostic) => diagnostic.fixes.length > 0), (state) => effect(state, { kind: 'diagnosticAction', action: 'applyFix' })),
  command('diagnostics.ignoreRule', 'Ignore Current Diagnostic Rule', 'Diagnostics', noBindings, (state) => visibleDiagnostics(state).length > 0, (state) => effect(state, { kind: 'diagnosticAction', action: 'ignoreRule' })),
  command('diagnostics.cycleSeverity', 'Cycle Diagnostic Severity Filter', 'Diagnostics', noBindings, enabled, (state) => effect(state, { kind: 'diagnosticAction', action: 'cycleSeverity' })),
  command('diagnostics.cycleSource', 'Cycle Diagnostic Source Filter', 'Diagnostics', noBindings, enabled, (state) => effect(state, { kind: 'diagnosticAction', action: 'cycleSource' })),
  command('diagnostics.refreshDocument', 'Refresh Document Diagnostics', 'Diagnostics', noBindings, hasBuffer, (state) => effect(state, { kind: 'refreshDiagnostics', scope: 'document' })),
  command('diagnostics.refreshProject', 'Refresh Project Diagnostics', 'Diagnostics', noBindings, hasProject, (state) => effect(state, { kind: 'refreshDiagnostics', scope: 'project' })),
  command('diagnostics.addWord', 'Add Current Word to Dictionary', 'Diagnostics', noBindings, (state) => visibleDiagnostics(state).some((diagnostic) => diagnostic.source === 'spelling'), (state) => effect(state, { kind: 'addDiagnosticWord' })),
  command('view.editorSource', 'Source Editor', 'View', noBindings, hasBuffer, (state) => stateOnly(Object.freeze({ ...state, editorMode: 'source', paneArrangement: 'editor' }))),
  command('view.editorHybrid', 'Hybrid Editor', 'View', noBindings, hasBuffer, (state) => stateOnly(Object.freeze({ ...state, editorMode: 'hybrid', paneArrangement: 'editor' }))),
  command('view.preview', 'Preview', 'View', [{ key: 'f7' }], hasBuffer, (state) => stateOnly(Object.freeze({ ...state, paneArrangement: 'preview' }))),
  command('view.editorPreview', 'Editor and Preview', 'View', [{ key: 'f8' }], hasBuffer, (state) => stateOnly(Object.freeze({ ...state, paneArrangement: 'editorPreview' }))),
  command('view.toggleNavigator', 'Toggle Navigator', 'View', [{ key: 'f2' }], enabled, (state) => stateOnly(Object.freeze({
    ...state,
    navigator: Object.freeze({ ...state.navigator, visible: !state.navigator.visible })
  }))),
  command('view.navigatorFiles', 'Navigator: Files', 'View', noBindings, hasProject, (state) => navigatorState(state, 'files')),
  command('view.navigatorOutline', 'Navigator: Outline', 'View', noBindings, hasReadyBuffer, (state) => navigatorState(state, 'outline')),
  command('view.navigatorSearch', 'Navigator: Search', 'View', noBindings, hasProject, (state) => navigatorState(state, 'search')),
  command('view.navigatorDiagnostics', 'Navigator: Diagnostics', 'View', noBindings, enabled, (state) => navigatorState(state, 'diagnostics')),
  command('view.navigatorBacklinks', 'Navigator: Backlinks', 'View', noBindings, hasBuffer, (state) => navigatorState(state, 'backlinks')),
  command('view.navigatorProperties', 'Navigator: Properties', 'View', noBindings, hasBuffer, (state) => navigatorState(state, 'properties')),
  command('view.navigatorExport', 'Navigator: Export', 'View', noBindings, enabled, (state) => navigatorState(state, 'export')),
  command('view.toggleFocusMode', 'Toggle Focus Mode', 'View', noBindings, hasBuffer, (state) => writingModeState(state, 'focus')),
  command('view.toggleTypewriterMode', 'Toggle Typewriter Mode', 'View', noBindings, hasBuffer, (state) => writingModeState(state, 'typewriter')),
  command('view.toggleDistractionFreeMode', 'Toggle Distraction-Free Mode', 'View', [{ key: 'f11' }], hasBuffer, (state) => writingModeState(state, 'distractionFree')),
  ...markdownCommands(),
  command('export.activeBuffer', 'Export Active Buffer', 'Export', noBindings, hasBuffer, (state) => exportDialog(state, 'activeBuffer')),
  command('export.batchDirectory', 'Batch Export Project Directory', 'Export', noBindings, hasProject, (state) => exportDialog(state, 'batchDirectory')),
  command('export.projectManifest', 'Export Project Manifest', 'Export', noBindings, hasProject, (state) => effect(state, { kind: 'exportProjectManifest' })),
  command('export.repeatLast', 'Repeat Last Export', 'Export', noBindings, (state) => state.exports.lastRequest !== undefined && state.exports.activeId === undefined, (state) => effect(state, { kind: 'repeatLastExport' })),
  command('export.cancel', 'Cancel Active Export', 'Export', noBindings, (state) => state.exports.activeId !== undefined, (state) => effect(state, { kind: 'cancelExport' }))
]);

function navigatorState(state: AppState, mode: AppState['navigator']['mode']): AppUpdate {
  return stateOnly(Object.freeze({
    ...state,
    navigator: Object.freeze({ ...state.navigator, mode, visible: true })
  }));
}

function writingModeState(state: AppState, mode: keyof Omit<AppState['writingMode'], 'typewriterAnchor'>): AppUpdate {
  return stateOnly(Object.freeze({
    ...state,
    writingMode: Object.freeze({ ...state.writingMode, [mode]: !state.writingMode[mode] })
  }));
}

function markdownCommands(): readonly VellumCommand[] {
  const values: readonly [CommandId, string, readonly KeyBinding[]][] = [
    ['markdown.toggleStrong', 'Toggle Strong', [{ key: 'b', ctrl: true }]],
    ['markdown.toggleEmphasis', 'Toggle Emphasis', [{ key: 'f10' }]],
    ['markdown.toggleInlineCode', 'Toggle Inline Code', [{ key: 'f9' }]],
    ['markdown.insertLink', 'Insert or Edit Link', [{ key: 'k', ctrl: true }]],
    ['markdown.toggleTask', 'Toggle Task', noBindings],
    ['markdown.promoteHeading', 'Promote Heading', noBindings],
    ['markdown.demoteHeading', 'Demote Heading', noBindings],
    ['markdown.insertCodeFence', 'Insert Code Fence', noBindings],
    ['markdown.moveBlockUp', 'Move Block Up', [{ key: 'arrowUp', alt: true }]],
    ['markdown.moveBlockDown', 'Move Block Down', [{ key: 'arrowDown', alt: true }]],
    ['markdown.duplicateBlock', 'Duplicate Block', [{ key: 'b', alt: true }]],
    ['markdown.formatTable', 'Format Table', noBindings],
    ['markdown.nextTableCell', 'Next Table Cell', [{ key: 'tab' }]],
    ['markdown.previousTableCell', 'Previous Table Cell', [{ key: 'tab', shift: true }]],
    ['markdown.addTableRow', 'Add Table Row', noBindings],
    ['markdown.addTableColumn', 'Add Table Column', noBindings],
    ['markdown.deleteTableRow', 'Delete Table Row', noBindings],
    ['markdown.deleteTableColumn', 'Delete Table Column', noBindings]
  ];
  return Object.freeze(values.map(([id, title, bindings]) => command(
    id,
    title,
    'Markdown',
    bindings,
    (state) => markdownCommandEnabled(state, id),
    (state) => effect(state, { kind: 'textEdit', commandId: id })
  )));
}

function markdownCommandEnabled(state: AppState, id: CommandId): boolean {
  switch (id) {
    case 'markdown.toggleStrong':
    case 'markdown.toggleEmphasis':
    case 'markdown.toggleInlineCode':
    case 'markdown.insertLink':
      return inlineMarkdownEnabled(state);
    case 'markdown.toggleTask':
      return hasSyntaxContext(state, 'listItem');
    case 'markdown.promoteHeading':
      return headingCommandEnabled(state, 'promote');
    case 'markdown.demoteHeading':
      return headingCommandEnabled(state, 'demote');
    case 'markdown.insertCodeFence':
      return hasReadyBuffer(state) && !hasSyntaxContext(state, 'codeBlock');
    case 'markdown.moveBlockUp':
      return moveBlockEnabled(state, -1);
    case 'markdown.moveBlockDown':
      return moveBlockEnabled(state, 1);
    case 'markdown.duplicateBlock':
      return hasTopLevelBlock(state);
    case 'markdown.formatTable':
    case 'markdown.addTableRow':
    case 'markdown.addTableColumn':
      return hasSyntaxContext(state, 'tableCell');
    case 'markdown.nextTableCell':
      return tableCellMovementEnabled(state, 1);
    case 'markdown.previousTableCell':
      return tableCellMovementEnabled(state, -1);
    case 'markdown.deleteTableRow':
      return tableRowDeletionEnabled(state);
    case 'markdown.deleteTableColumn':
      return tableColumnDeletionEnabled(state);
    default:
      return false;
  }
}

const commandsById = commandMap(definitions);

export function allCommands(): readonly VellumCommand[] {
  return definitions;
}

export function commandById(id: string): VellumCommand | undefined {
  return commandsById.get(id as CommandId);
}

export function executeCommand(state: AppState, id: CommandId): AppUpdate {
  const value = commandsById.get(id);
  if (value === undefined) throw new Error(`Unknown command identifier: ${id}`);
  return value.enabled(state) ? value.execute(state) : stateOnly(state);
}

function commandMap(values: readonly VellumCommand[]): ReadonlyMap<CommandId, VellumCommand> {
  const result = new Map<CommandId, VellumCommand>();
  for (const value of values) {
    if (result.has(value.id)) throw new Error(`Duplicate command identifier: ${value.id}`);
    result.set(value.id, value);
  }
  return result;
}

export function initialAppState(): AppState {
  return Object.freeze({
    project: Object.freeze({
      fileTree: createFileTreeState(),
      index: Object.freeze({ documents: Object.freeze({}), orderedPaths: Object.freeze([]), assetPaths: Object.freeze([]), indexing: false, revision: 0 }),
      buffers: Object.freeze({}),
      bufferOrder: Object.freeze([]),
      recentlyClosed: Object.freeze([]),
      recentlyOpenedPaths: Object.freeze([]),
      unusedAssets: Object.freeze([]),
      recentProjects: Object.freeze([]),
      pinnedProjects: Object.freeze([])
    }),
    paneArrangement: 'editor',
    editorMode: 'source',
    splitPane: createSplitPaneState(2, [0.5, 0.5]),
    navigator: Object.freeze({ mode: 'files', visible: true, width: 28 }),
    writingMode: Object.freeze({ focus: false, typewriter: false, distractionFree: false, typewriterAnchor: 0.45 }),
    projectSearch: Object.freeze({ query: '', recentQueries: Object.freeze([]), searching: false, results: Object.freeze([]) }),
    diagnostics: Object.freeze({}),
    diagnosticPreferences: Object.freeze({ minimumSeverity: 'info', source: 'all', ignoredRules: Object.freeze([]) }),
    exports: Object.freeze({ history: Object.freeze([]) }),
    commandState: Object.freeze({
      navigation: Object.freeze({ back: Object.freeze([]), forward: Object.freeze([]) })
    }),
    configurationDiagnostics: Object.freeze([])
  });
}
