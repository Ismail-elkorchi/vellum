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
const filePathDialog = (state: AppState, operation: 'openFile' | 'openProjectDirectory' | 'saveAs'): AppUpdate => stateOnly(Object.freeze({
  ...state,
  dialogState: Object.freeze({
    kind: 'filePath',
    operation,
    command: createCommandInputState({ value: '', suggestions: createCommandSuggestions([]) })
  })
}));
const searchInput = () => createCommandInputState({ value: '', suggestions: createCommandSuggestions([]) });
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
const exportDialog = (state: AppState, scope: 'activeBuffer' | 'projectDirectory'): AppUpdate => {
  return stateOnly(Object.freeze({
    ...state,
    dialogState: Object.freeze({
      kind: 'exportProfile',
      scope,
      command: createCommandInputState({ value: '', suggestions: createCommandSuggestions([]) })
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
  command('application.commandPalette', 'Command Palette', 'Application', [{ key: 'p', ctrl: true, alt: true }], enabled, (state) => stateOnly(Object.freeze({
    ...state,
    dialogState: Object.freeze({
      kind: 'commandPalette',
      command: createCommandInputState({ value: '', suggestions: createCommandSuggestions([]) })
    })
  }))),
  command('application.quit', 'Quit Vellum', 'Application', [{ key: 'q', ctrl: true }], enabled, (state) => effect(state, { kind: 'quit' })),
  command('file.new', 'New File', 'File', [{ key: 'n', ctrl: true }], enabled, (state) => effect(state, { kind: 'newFile' })),
  command('file.open', 'Open File', 'File', [{ key: 'o', ctrl: true }], enabled, (state) => filePathDialog(state, 'openFile')),
  command('file.openDirectory', 'Open Project Directory', 'File', [{ key: 'd', ctrl: true, alt: true }], enabled, (state) => filePathDialog(state, 'openProjectDirectory')),
  command('file.save', 'Save', 'File', [{ key: 's', ctrl: true }], hasDirtyActiveBuffer, (state) => activeBuffer(state)?.path === undefined
    ? filePathDialog(state, 'saveAs')
    : effect(state, { kind: 'save' })),
  command('file.saveAs', 'Save As', 'File', [{ key: 's', ctrl: true, alt: true }], hasBuffer, (state) => filePathDialog(state, 'saveAs')),
  command('file.saveAll', 'Save All', 'File', [{ key: 'a', ctrl: true, alt: true }], hasDirtyBuffer, (state) => effect(state, { kind: 'saveAll' })),
  command('file.close', 'Close Active Buffer', 'File', [{ key: 'w', ctrl: true }], hasBuffer, (state) => effect(state, { kind: 'closeBuffer' })),
  command('file.reopenClosed', 'Reopen Recently Closed Buffer', 'File', [{ key: 'r', ctrl: true, alt: true }], (state) => state.project.recentlyClosed.length > 0, (state) => effect(state, { kind: 'reopenClosed' })),
  command('file.quickOpen', 'Quick Open', 'File', [{ key: 'p', ctrl: true }], (state) => state.project.rootDirectory !== undefined, (state) => stateOnly(Object.freeze({
    ...state,
    dialogState: Object.freeze({
      kind: 'quickOpen',
      command: createCommandInputState({ value: '', suggestions: createCommandSuggestions([]) })
    })
  }))),
  command('file.searchProjectDirectory', 'Search Project Directory', 'File', [{ key: 'f', ctrl: true, alt: true }], (state) => state.project.rootDirectory !== undefined, (state) => stateOnly(Object.freeze({
    ...state,
    dialogState: Object.freeze({ kind: 'projectDirectorySearch', query: searchInput(), searching: false, results: Object.freeze([]) })
  }))),
  command('edit.undo', 'Undo', 'Edit', [{ key: 'z', ctrl: true }], hasUndo, (state) => effect(state, { kind: 'textEdit', commandId: 'edit.undo' })),
  command('edit.redo', 'Redo', 'Edit', [{ key: 'y', ctrl: true }], hasRedo, (state) => effect(state, { kind: 'textEdit', commandId: 'edit.redo' })),
  command('edit.find', 'Find in Source Document', 'Edit', [{ key: 'f', ctrl: true }], hasBuffer, (state) => documentSearchDialog(state, false)),
  command('edit.replace', 'Replace in Source Document', 'Edit', [{ key: 'h', ctrl: true }], hasBuffer, (state) => documentSearchDialog(state, true)),
  command('navigate.outline', 'Open Outline', 'Navigate', [{ key: 'o', ctrl: true, alt: true }], hasReadyBuffer, (state) => stateOnly(Object.freeze({
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
  command('view.editorSource', 'Source Editor', 'View', noBindings, hasBuffer, (state) => stateOnly(Object.freeze({ ...state, editorMode: 'source', paneArrangement: 'editor' }))),
  command('view.editorHybrid', 'Hybrid Editor', 'View', noBindings, hasBuffer, (state) => stateOnly(Object.freeze({ ...state, editorMode: 'hybrid', paneArrangement: 'editor' }))),
  command('view.preview', 'Preview', 'View', [{ key: 'f7' }], hasBuffer, (state) => stateOnly(Object.freeze({ ...state, paneArrangement: 'preview' }))),
  command('view.editorPreview', 'Editor and Preview', 'View', [{ key: 'f8' }], hasBuffer, (state) => stateOnly(Object.freeze({ ...state, paneArrangement: 'editorPreview' }))),
  ...markdownCommands(),
  command('export.activeBuffer', 'Export Active Buffer', 'Export', noBindings, hasBuffer, (state) => exportDialog(state, 'activeBuffer')),
  command('export.projectDirectory', 'Export Project Directory', 'Export', noBindings, (state) => state.project.rootDirectory !== undefined, (state) => exportDialog(state, 'projectDirectory'))
]);

function markdownCommands(): readonly VellumCommand[] {
  const values: readonly [CommandId, string, readonly KeyBinding[]][] = [
    ['markdown.toggleStrong', 'Toggle Strong', [{ key: 'b', ctrl: true }]],
    ['markdown.toggleEmphasis', 'Toggle Emphasis', [{ key: 'i', ctrl: true }]],
    ['markdown.toggleInlineCode', 'Toggle Inline Code', [{ key: 'f9' }]],
    ['markdown.insertLink', 'Insert or Edit Link', [{ key: 'k', ctrl: true }]],
    ['markdown.toggleTask', 'Toggle Task', noBindings],
    ['markdown.promoteHeading', 'Promote Heading', noBindings],
    ['markdown.demoteHeading', 'Demote Heading', noBindings],
    ['markdown.insertCodeFence', 'Insert Code Fence', noBindings],
    ['markdown.moveBlockUp', 'Move Block Up', [{ key: 'arrowUp', alt: true }]],
    ['markdown.moveBlockDown', 'Move Block Down', [{ key: 'arrowDown', alt: true }]],
    ['markdown.duplicateBlock', 'Duplicate Block', [{ key: 'b', ctrl: true, alt: true }]],
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
      buffers: Object.freeze({}),
      bufferOrder: Object.freeze([]),
      recentlyClosed: Object.freeze([]),
      recentlyOpenedPaths: Object.freeze([])
    }),
    paneArrangement: 'editor',
    editorMode: 'source',
    splitPane: createSplitPaneState(2, [0.5, 0.5]),
    commandState: Object.freeze({
      navigation: Object.freeze({ back: Object.freeze([]), forward: Object.freeze([]) })
    })
  });
}
