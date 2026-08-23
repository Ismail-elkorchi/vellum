import {
  applyScrollEvent,
  createCommandInputState,
  createScrollState,
  createSplitPaneState,
  createTextAreaState,
  commandInputReducer,
  normalizeScrollState,
  prepareCommandSuggestions,
  scrollReducer,
  splitPaneReducer,
  textAreaReducer,
  type CommandInputState,
  type CommandInputTransition,
  type ScrollEvent,
  type ScrollState,
  type SplitPaneAction,
  type SplitPaneState,
  type TextAreaAction,
  type TextAreaState
} from '@ismail-elkorchi/terminal-ui/behavior';
import {
  measureTextCells,
  textDocumentText
} from '@ismail-elkorchi/terminal-ui/text';
import path from 'node:path';

export type EditorMode = 'edit' | 'preview' | 'split';
export type ActivePane = 'editor' | 'preview';
export type FileDialogOperation = 'open' | 'saveAs';
export type PreviewScrollCommand = 'lineUp' | 'lineDown' | 'pageUp' | 'pageDown' | 'top' | 'bottom';

export interface PreviewScrollGeometry {
  readonly contentRows: number;
  readonly pageRows: number;
}

export interface SplitScrollGeometry {
  readonly editor: PreviewScrollGeometry;
  readonly preview: PreviewScrollGeometry;
}

export interface DocumentState {
  readonly id: number;
  readonly revision: number;
  readonly path?: string;
  readonly label: string;
  readonly text: string;
  readonly editor: TextAreaState;
  readonly savedText: string;
}

export interface FileDialogState {
  readonly kind: 'file';
  readonly operation: FileDialogOperation;
  readonly command: CommandInputState;
  readonly error?: string;
}

export interface ConfirmDialogState {
  readonly kind: 'confirm';
  readonly operation: 'quit' | 'open';
  readonly rawPath?: string;
  readonly returnTo?: FileDialogState;
}

export interface HelpDialogState {
  readonly kind: 'help';
}

export type AppDialogState = FileDialogState | ConfirmDialogState | HelpDialogState;

export interface AppNotice {
  readonly text: string;
  readonly status: 'info' | 'warning' | 'error';
}

export interface AppState {
  readonly mode: EditorMode;
  readonly activePane: ActivePane;
  readonly document: DocumentState;
  readonly previewScroll: ScrollState;
  readonly splitPane: SplitPaneState;
  readonly previewSource: string;
  readonly notice?: AppNotice;
  readonly dialog?: AppDialogState;
}

const DEFAULT_TITLE = 'untitled.md';
const PROMPT_COMMAND_SUGGESTIONS = prepareCommandSuggestions([]);
const SPLIT_CONSTRAINTS = [
  { minShare: 0.25, maxShare: 0.75 },
  { minShare: 0.25, maxShare: 0.75 }
] as const;

function createPromptState(value = ''): CommandInputState {
  return createCommandInputState({
    value,
    suggestions: PROMPT_COMMAND_SUGGESTIONS
  });
}

function buildDocument(args: {
  readonly id: number;
  readonly path?: string;
  readonly label?: string;
  readonly text: string;
}): DocumentState {
  const resolvedPath = args.path;
  const label = args.label ?? (resolvedPath === undefined ? DEFAULT_TITLE : path.basename(resolvedPath));
  return {
    id: args.id,
    revision: 0,
    path: resolvedPath,
    label,
    text: args.text,
    editor: createTextAreaState({ value: args.text }),
    savedText: args.text
  };
}

export function initialState(): AppState {
  return {
    mode: 'edit',
    activePane: 'editor',
    document: buildDocument({ id: 0, text: '' }),
    previewScroll: createScrollState(),
    splitPane: createSplitPaneState(2, [0.5, 0.5]),
    previewSource: ''
  };
}

export function cycleMode(mode: EditorMode): EditorMode {
  if (mode === 'edit') return 'split';
  if (mode === 'split') return 'preview';
  return 'edit';
}

export function setMode(state: AppState, mode: EditorMode): AppState {
  return {
    ...state,
    mode,
    activePane: mode === 'preview' ? 'preview' : mode === 'edit' ? 'editor' : state.activePane,
    previewSource: mode === 'edit' ? state.previewSource : state.document.text,
    dialog: undefined,
    notice: undefined
  };
}

export function activatePane(state: AppState, pane: ActivePane): AppState {
  if (state.activePane === pane) return state;
  return { ...state, activePane: pane };
}

export function toggleActivePane(state: AppState): AppState {
  return activatePane(state, state.activePane === 'editor' ? 'preview' : 'editor');
}

export function openDocument(state: AppState, filePath: string, label: string, text: string): AppState {
  return {
    ...state,
    mode: 'edit',
    activePane: 'editor',
    document: buildDocument({ id: state.document.id + 1, path: filePath, label, text }),
    previewScroll: createScrollState(),
    previewSource: text,
    dialog: undefined,
    notice: undefined
  };
}

export function markDocumentSaved(state: AppState, filePath: string, savedText: string): AppState {
  const label = path.basename(filePath);
  return {
    ...state,
    document: {
      ...state.document,
      path: filePath,
      label,
      savedText
    },
    dialog: undefined,
    notice: undefined
  };
}

export function startFileDialog(
  state: AppState,
  operation: FileDialogOperation,
  value = operation === 'saveAs' ? (state.document.path ?? '') : '',
  error?: string
): AppState {
  return {
    ...state,
    dialog: {
      kind: 'file',
      operation,
      command: createPromptState(value),
      ...(error === undefined ? {} : { error })
    },
    notice: undefined
  };
}

export function showOpenConfirmation(state: AppState, rawPath: string, returnTo: FileDialogState): AppState {
  return {
    ...state,
    dialog: {
      kind: 'confirm',
      operation: 'open',
      rawPath,
      returnTo
    },
    notice: undefined
  };
}

export function showQuitConfirmation(state: AppState): AppState {
  return {
    ...state,
    dialog: {
      kind: 'confirm',
      operation: 'quit'
    },
    notice: undefined
  };
}

export function showHelpDialog(state: AppState): AppState {
  return {
    ...state,
    dialog: { kind: 'help' },
    notice: undefined
  };
}

export function dismissDialog(state: AppState): AppState {
  if (state.dialog?.kind === 'confirm' && state.dialog.returnTo !== undefined) {
    return { ...state, dialog: state.dialog.returnTo, notice: undefined };
  }
  return { ...state, dialog: undefined, notice: undefined };
}

export function closeDialog(state: AppState): AppState {
  if (state.dialog === undefined) return state;
  return { ...state, dialog: undefined };
}

export function editFileDialog(state: AppState, action: CommandInputTransition): AppState {
  if (state.dialog?.kind !== 'file') return state;
  const next = commandInputReducer(state.dialog.command, action);
  if (next === state.dialog.command && state.dialog.error === undefined) return state;
  return {
    ...state,
    dialog: {
      ...state.dialog,
      command: next,
      error: undefined
    }
  };
}

export function setFileDialogError(state: AppState, error: string): AppState {
  if (state.dialog?.kind !== 'file') return state;
  return {
    ...state,
    dialog: {
      ...state.dialog,
      error
    }
  };
}

export function editDocument(state: AppState, action: TextAreaAction): AppState {
  const editor = textAreaReducer(state.document.editor, action);
  if (editor === state.document.editor && state.activePane === 'editor') return state;
  const textChanged = editor.document !== state.document.editor.document;
  const text = textChanged ? textDocumentText(editor.document) : state.document.text;

  return {
    ...state,
    activePane: 'editor',
    notice: undefined,
    document: {
      ...state.document,
      text,
      editor,
      revision: textChanged ? state.document.revision + 1 : state.document.revision
    }
  };
}

export function setPreviewScroll(state: AppState, event: ScrollEvent): AppState {
  const previewScroll = applyScrollEvent(state.previewScroll, event);
  if (previewScroll === state.previewScroll && state.activePane === 'preview') return state;
  return {
    ...state,
    activePane: 'preview',
    previewScroll
  };
}

export function movePreview(
  state: AppState,
  command: PreviewScrollCommand,
  geometry: PreviewScrollGeometry
): AppState {
  const scrollGeometry = {
    contentRows: Math.max(0, Math.floor(geometry.contentRows)),
    contentColumns: 1,
    viewportRows: Math.max(1, Math.floor(geometry.pageRows)),
    viewportColumns: 1
  };
  const current = normalizeScrollState(state.previewScroll, scrollGeometry);
  let previewScroll: ScrollState;
  switch (command) {
    case 'lineUp':
      previewScroll = scrollReducer(current, { kind: 'scrollLines', rows: -1 }, scrollGeometry);
      break;
    case 'lineDown':
      previewScroll = scrollReducer(current, { kind: 'scrollLines', rows: 1 }, scrollGeometry);
      break;
    case 'pageUp':
      previewScroll = scrollReducer(current, { kind: 'scrollPages', rows: -1 }, scrollGeometry);
      break;
    case 'pageDown':
      previewScroll = scrollReducer(current, { kind: 'scrollPages', rows: 1 }, scrollGeometry);
      break;
    case 'top':
      previewScroll = scrollReducer(current, { kind: 'top' }, scrollGeometry);
      break;
    case 'bottom':
      previewScroll = scrollReducer(current, { kind: 'bottom' }, scrollGeometry);
      break;
  }
  if (previewScroll === state.previewScroll && state.activePane === 'preview') return state;
  return {
    ...state,
    activePane: 'preview',
    previewScroll
  };
}

export function normalizedPreviewScroll(
  state: AppState,
  geometry: PreviewScrollGeometry
): ScrollState {
  return normalizeScrollState(state.previewScroll, {
    contentRows: Math.max(0, Math.floor(geometry.contentRows)),
    contentColumns: 1,
    viewportRows: Math.max(1, Math.floor(geometry.pageRows)),
    viewportColumns: 1
  });
}

function scrollRatio(scroll: ScrollState, geometry: PreviewScrollGeometry): number {
  const maximum = Math.max(0, Math.floor(geometry.contentRows) - Math.max(1, Math.floor(geometry.pageRows)));
  if (maximum === 0) return 0;
  return Math.max(0, Math.min(1, scroll.offsetRow / maximum));
}

function offsetAtRatio(ratio: number, geometry: PreviewScrollGeometry): number {
  const maximum = Math.max(0, Math.floor(geometry.contentRows) - Math.max(1, Math.floor(geometry.pageRows)));
  return Math.round(maximum * Math.max(0, Math.min(1, ratio)));
}

export function synchronizePreviewToEditorScroll(
  state: AppState,
  geometry: SplitScrollGeometry
): AppState {
  if (state.mode !== 'split') return state;
  const editorScroll = normalizeScrollState(state.document.editor.scroll, {
    contentRows: geometry.editor.contentRows,
    contentColumns: 1,
    viewportRows: geometry.editor.pageRows,
    viewportColumns: 1
  });
  const previewScroll = scrollReducer(
    state.previewScroll,
    { kind: 'setOffset', rows: offsetAtRatio(scrollRatio(editorScroll, geometry.editor), geometry.preview) },
    {
      contentRows: geometry.preview.contentRows,
      contentColumns: 1,
      viewportRows: geometry.preview.pageRows,
      viewportColumns: 1
    }
  );
  return previewScroll === state.previewScroll
    ? state
    : { ...state, previewScroll };
}

export function synchronizeEditorToPreviewScroll(
  state: AppState,
  geometry: SplitScrollGeometry
): AppState {
  if (state.mode !== 'split') return state;
  const previewScroll = normalizedPreviewScroll(state, geometry.preview);
  const editorScroll = scrollReducer(
    state.document.editor.scroll,
    { kind: 'setOffset', rows: offsetAtRatio(scrollRatio(previewScroll, geometry.preview), geometry.editor) },
    {
      contentRows: geometry.editor.contentRows,
      contentColumns: 1,
      viewportRows: geometry.editor.pageRows,
      viewportColumns: 1
    }
  );
  const editor = editorScroll === state.document.editor.scroll && !state.document.editor.revealCaret
    ? state.document.editor
    : { ...state.document.editor, scroll: editorScroll, revealCaret: false };
  return editor === state.document.editor
    ? state
    : { ...state, document: { ...state.document, editor } };
}

export function setPreviewSource(state: AppState, source: string): AppState {
  return state.previewSource === source ? state : { ...state, previewSource: source };
}

export function resizeSplitPane(state: AppState, action: SplitPaneAction): AppState {
  const splitPane = splitPaneReducer(state.splitPane, action, { constraints: SPLIT_CONSTRAINTS });
  return splitPane === state.splitPane ? state : { ...state, splitPane };
}

export function setNotice(state: AppState, notice: AppNotice | undefined): AppState {
  if (state.notice === notice) return state;
  return {
    ...state,
    ...(notice === undefined ? { notice: undefined } : { notice })
  };
}

export function isModified(state: AppState): boolean {
  return state.document.text !== state.document.savedText;
}

export function cursorLineColumn(state: AppState): { readonly line: number; readonly column: number } {
  const cursor = state.document.editor.caret.position.offset;
  const before = state.document.text.slice(0, Math.max(0, Math.min(state.document.text.length, cursor)));
  const lines = before.length === 0 ? [''] : before.split('\n');
  return {
    line: lines.length,
    column: measureTextCells(lines.at(-1) ?? '').cells + 1
  };
}
