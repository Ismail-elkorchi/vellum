import {
  createCommandInputState,
  createSplitPaneState,
  createCommandSuggestions
} from '@ismail-elkorchi/terminal-ui/behavior';
import type { BindableKeyName } from '@ismail-elkorchi/terminal-ui/input';
import type { AppState, CommandId } from '../app/types.js';
import { activeBuffer } from '../app/types.js';
import { builtInExportProfiles } from '../export/profiles.js';
import { createFileTreeState } from '../project/file-tree.js';

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
const hasDirtyBuffer = (state: AppState): boolean => Object.values(state.project.buffers).some((buffer) => buffer.dirty);
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
  const suggestions = createCommandSuggestions(builtInExportProfiles.map((profile) => ({
    id: profile.id,
    label: profile.label,
    description: profile.targetFormat,
    completion: { range: { startOffset: 0, endOffsetExclusive: 0 }, text: profile.id }
  })));
  return stateOnly(Object.freeze({
    ...state,
    dialogState: Object.freeze({ kind: 'exportProfile', scope, command: createCommandInputState({ value: '', suggestions }) })
  }));
};

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
  command('application.commandPalette', 'Command Palette', 'Application', [{ key: 'p', ctrl: true, shift: true }], enabled, (state) => stateOnly(Object.freeze({
    ...state,
    dialogState: Object.freeze({
      kind: 'commandPalette',
      command: createCommandInputState({ value: '', suggestions: createCommandSuggestions([]) })
    })
  }))),
  command('application.quit', 'Quit Vellum', 'Application', [{ key: 'q', ctrl: true }], enabled, (state) => effect(state, { kind: 'quit' })),
  command('file.new', 'New File', 'File', [{ key: 'n', ctrl: true }], enabled, (state) => effect(state, { kind: 'newFile' })),
  command('file.open', 'Open File', 'File', [{ key: 'o', ctrl: true }], enabled, (state) => filePathDialog(state, 'openFile')),
  command('file.openDirectory', 'Open Project Directory', 'File', [{ key: 'o', ctrl: true, shift: true }], enabled, (state) => filePathDialog(state, 'openProjectDirectory')),
  command('file.save', 'Save', 'File', [{ key: 's', ctrl: true }], hasBuffer, (state) => activeBuffer(state)?.path === undefined
    ? filePathDialog(state, 'saveAs')
    : effect(state, { kind: 'save' })),
  command('file.saveAs', 'Save As', 'File', [{ key: 's', ctrl: true, shift: true }], hasBuffer, (state) => filePathDialog(state, 'saveAs')),
  command('file.saveAll', 'Save All', 'File', [{ key: 's', ctrl: true, alt: true }], hasDirtyBuffer, (state) => effect(state, { kind: 'saveAll' })),
  command('file.close', 'Close Active Buffer', 'File', [{ key: 'w', ctrl: true }], hasBuffer, (state) => effect(state, { kind: 'closeBuffer' })),
  command('file.reopenClosed', 'Reopen Recently Closed Buffer', 'File', [{ key: 't', ctrl: true, shift: true }], (state) => state.project.recentlyClosed.length > 0, (state) => effect(state, { kind: 'reopenClosed' })),
  command('file.quickOpen', 'Quick Open', 'File', [{ key: 'p', ctrl: true }], (state) => state.project.rootDirectory !== undefined, (state) => stateOnly(Object.freeze({
    ...state,
    dialogState: Object.freeze({
      kind: 'quickOpen',
      command: createCommandInputState({ value: '', suggestions: createCommandSuggestions([]) })
    })
  }))),
  command('file.searchProjectDirectory', 'Search Project Directory', 'File', [{ key: 'f', ctrl: true, shift: true }], (state) => state.project.rootDirectory !== undefined, (state) => stateOnly(Object.freeze({
    ...state,
    dialogState: Object.freeze({ kind: 'projectDirectorySearch', query: searchInput(), searching: false, results: Object.freeze([]) })
  }))),
  command('edit.undo', 'Undo', 'Edit', [{ key: 'z', ctrl: true }], hasBuffer, (state) => effect(state, { kind: 'textEdit', commandId: 'edit.undo' })),
  command('edit.redo', 'Redo', 'Edit', [{ key: 'y', ctrl: true }], hasBuffer, (state) => effect(state, { kind: 'textEdit', commandId: 'edit.redo' })),
  command('edit.find', 'Find in Source Document', 'Edit', [{ key: 'f', ctrl: true }], hasBuffer, (state) => documentSearchDialog(state, false)),
  command('edit.replace', 'Replace in Source Document', 'Edit', [{ key: 'h', ctrl: true }], hasBuffer, (state) => documentSearchDialog(state, true)),
  command('navigate.outline', 'Open Outline', 'Navigate', [{ key: 'o', ctrl: true, alt: true }], hasBuffer, (state) => stateOnly(Object.freeze({
    ...state,
    dialogState: Object.freeze({ kind: 'outline', query: searchInput(), entries: Object.freeze([]) })
  }))),
  command('navigate.back', 'Navigate Back', 'Navigate', [{ key: 'arrowLeft', alt: true }], (state) => state.commandState.navigation.back.length > 0, (state) => effect(state, { kind: 'navigate', commandId: 'navigate.back' })),
  command('navigate.forward', 'Navigate Forward', 'Navigate', [{ key: 'arrowRight', alt: true }], (state) => state.commandState.navigation.forward.length > 0, (state) => effect(state, { kind: 'navigate', commandId: 'navigate.forward' })),
  command('navigate.goToLine', 'Go to Line', 'Navigate', [{ key: 'g', ctrl: true }], hasBuffer, (state) => stateOnly(Object.freeze({
    ...state,
    dialogState: Object.freeze({ kind: 'goToLine', command: searchInput() })
  }))),
  command('navigate.nextHeading', 'Next Heading', 'Navigate', [{ key: 'f6' }], hasBuffer, (state) => effect(state, { kind: 'navigate', commandId: 'navigate.nextHeading' })),
  command('navigate.previousHeading', 'Previous Heading', 'Navigate', [{ key: 'f6', shift: true }], hasBuffer, (state) => effect(state, { kind: 'navigate', commandId: 'navigate.previousHeading' })),
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
    ['markdown.duplicateBlock', 'Duplicate Block', [{ key: 'd', ctrl: true, shift: true }]],
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
    hasBuffer,
    (state) => effect(state, { kind: 'textEdit', commandId: id })
  )));
}

export const commandRegistry: ReadonlyMap<CommandId, VellumCommand> = new Map(
  definitions.map((value) => [value.id, value])
);

export function allCommands(): readonly VellumCommand[] {
  return definitions;
}

export function executeCommand(state: AppState, id: CommandId): AppUpdate {
  const value = commandRegistry.get(id);
  if (value === undefined) throw new Error(`Unknown command identifier: ${id}`);
  return value.enabled(state) ? value.execute(state) : stateOnly(state);
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
      activePane: 'editor',
      navigation: Object.freeze({ back: Object.freeze([]), forward: Object.freeze([]) })
    })
  });
}
