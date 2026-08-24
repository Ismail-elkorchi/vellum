import { pathToFileURL } from 'node:url';
import {
  defineTui,
  runTui,
  type TuiApp,
  type TuiEffect,
  type TuiInputBinding,
  type TuiUpdateResult
} from '@ismail-elkorchi/terminal-ui/tui';
import {
  activatePane,
  closeDialog,
  cycleMode,
  dismissDialog,
  editDocument,
  editFileDialog,
  initialState,
  isModified,
  markDocumentSaved,
  movePreview,
  openDocument,
  resizeSplitPane,
  setFileDialogError,
  setMarkdownPreview,
  setMode,
  setNotice,
  setPreviewScroll,
  showHelpDialog,
  showOpenConfirmation,
  showQuitConfirmation,
  startFileDialog,
  synchronizeEditorToPreviewScroll,
  synchronizePreviewToEditorScroll,
  toggleActivePane,
  type AppState
} from './editor-state.js';
import {
  openMarkdownFile,
  saveMarkdownFile
} from './file-io.js';
import {
  createMarkdownPreviewEngine,
  type MarkdownPreviewEngine
} from './markdown/preview.js';
import {
  VELLUM_IDS,
  view,
  type AppMessage,
  type FileOperation
} from './view.js';

const EDITOR_FOCUS = { kind: 'element', elementId: VELLUM_IDS.editor } as const;
const PREVIEW_FOCUS = { kind: 'element', elementId: VELLUM_IDS.preview } as const;
const FILE_INPUT_FOCUS = { kind: 'element', elementId: VELLUM_IDS.fileInput } as const;
const CONFIRM_CANCEL_FOCUS = { kind: 'element', elementId: VELLUM_IDS.confirmCancel } as const;
const HELP_CLOSE_FOCUS = { kind: 'element', elementId: VELLUM_IDS.helpClose } as const;

function workspaceFocus(state: AppState) {
  return state.mode === 'preview' || (state.mode === 'split' && state.activePane === 'preview')
    ? PREVIEW_FOCUS
    : EDITOR_FOCUS;
}

function dialogFocus(state: AppState) {
  switch (state.dialog?.kind) {
    case 'file':
      return FILE_INPUT_FOCUS;
    case 'confirm':
      return CONFIRM_CANCEL_FOCUS;
    case 'help':
      return HELP_CLOSE_FOCUS;
    case undefined:
      return workspaceFocus(state);
  }
}

function bindingsEnabled({ state }: { readonly state: AppState }): boolean {
  return state.dialog === undefined;
}

const inputBindings: readonly TuiInputBinding<AppState, AppMessage>[] = [
  {
    id: 'vellum-open',
    triggers: [{ kind: 'key', key: 'o', modifiers: { ctrl: true } }],
    label: 'Open',
    enabled: bindingsEnabled,
    message: { kind: 'openDialog' }
  },
  {
    id: 'vellum-save-as',
    triggers: [
      { kind: 'key', key: 's', modifiers: { ctrl: true, shift: true } },
      { kind: 'key', key: 'f2' }
    ],
    label: 'Save As',
    enabled: bindingsEnabled,
    message: { kind: 'saveAsDialog' }
  },
  {
    id: 'vellum-save',
    triggers: [{ kind: 'key', key: 's', modifiers: { ctrl: true } }],
    label: 'Save',
    enabled: bindingsEnabled,
    message: { kind: 'save' }
  },
  {
    id: 'vellum-cycle-mode',
    triggers: [{ kind: 'key', key: 'p', modifiers: { ctrl: true } }],
    label: 'Cycle view mode',
    enabled: bindingsEnabled,
    message: { kind: 'toggleMode' }
  },
  {
    id: 'vellum-switch-pane',
    triggers: [
      { kind: 'key', key: 'tab' },
      { kind: 'key', key: 'tab', modifiers: { shift: true } }
    ],
    phase: 'beforeFocus',
    label: 'Switch pane',
    enabled: ({ state }) => state.dialog === undefined && state.mode === 'split',
    message: { kind: 'togglePane' }
  },
  {
    id: 'vellum-resize-split-smaller-horizontal',
    triggers: [
      { kind: 'key', key: 'arrowLeft', modifiers: { alt: true } },
      { kind: 'key', key: 'arrowUp', modifiers: { alt: true } }
    ],
    phase: 'beforeFocus',
    enabled: ({ state }) => state.dialog === undefined && state.mode === 'split',
    message: { kind: 'resizeSplit', action: { kind: 'resizeBy', deltaShare: -0.04 } }
  },
  {
    id: 'vellum-resize-split-larger-horizontal',
    triggers: [
      { kind: 'key', key: 'arrowRight', modifiers: { alt: true } },
      { kind: 'key', key: 'arrowDown', modifiers: { alt: true } }
    ],
    phase: 'beforeFocus',
    enabled: ({ state }) => state.dialog === undefined && state.mode === 'split',
    message: { kind: 'resizeSplit', action: { kind: 'resizeBy', deltaShare: 0.04 } }
  },
  {
    id: 'vellum-help',
    triggers: [{ kind: 'key', key: 'f1' }],
    label: 'Help',
    enabled: bindingsEnabled,
    message: { kind: 'helpDialog' }
  },
  {
    id: 'vellum-quit',
    triggers: [{ kind: 'key', key: 'q', modifiers: { ctrl: true } }],
    label: 'Quit',
    enabled: bindingsEnabled,
    message: { kind: 'quit' }
  }
];

function openMarkdownEffect(
  rawPath: string,
  documentId: number,
  revision: number
): TuiEffect<AppMessage> {
  return {
    id: 'vellum-open-file',
    concurrency: 'replace',
    async run({ signal }) {
      const file = await openMarkdownFile(rawPath, signal);
      return { kind: 'message', message: { kind: 'fileOpened', file, documentId, revision } };
    },
    onError: ({ diagnostic }) => ({
      kind: 'message',
      message: {
        kind: 'fileError',
        operation: 'open',
        rawPath,
        message: diagnostic.message,
        documentId,
        revision
      }
    })
  };
}

function saveMarkdownEffect(
  rawPath: string,
  savedText: string,
  operation: Extract<FileOperation, 'save' | 'saveAs'>,
  documentId: number,
  revision: number
): TuiEffect<AppMessage> {
  return {
    id: 'vellum-save-file',
    concurrency: 'enqueue',
    async run({ signal }) {
      const file = await saveMarkdownFile(rawPath, savedText, signal);
      return {
        kind: 'message',
        message: {
          kind: 'fileSaved',
          path: file.path,
          savedText,
          documentId
        }
      };
    },
    onError: ({ diagnostic }) => ({
      kind: 'message',
      message: {
        kind: 'fileError',
        operation,
        rawPath,
        message: diagnostic.message,
        documentId,
        revision
      }
    })
  };
}

function previewRefreshEffect(
  engine: MarkdownPreviewEngine,
  documentId: number,
  revision: number,
  source: string
): TuiEffect<AppMessage> {
  return {
    id: 'vellum-preview-refresh',
    concurrency: 'replace',
    async run({ clock, signal }) {
      const outcome = await clock.sleep(75, signal);
      if (outcome === 'aborted') return { kind: 'none' };
      return {
        kind: 'message',
        message: {
          kind: 'previewReady',
          preview: engine.update(documentId, revision, source)
        }
      };
    }
  };
}

function requestOpen(state: AppState, rawPath: string): TuiUpdateResult<AppState, AppMessage> {
  const normalized = rawPath.trim();
  if (normalized.length === 0) {
    return {
      state: setFileDialogError(state, 'Enter a file path.'),
      focus: FILE_INPUT_FOCUS
    };
  }
  return {
    state: setNotice(closeDialog(state), { text: `Opening ${normalized}…`, status: 'info' }),
    effects: [openMarkdownEffect(normalized, state.document.id, state.document.revision)]
  };
}

function requestSaveAs(state: AppState, rawPath: string): TuiUpdateResult<AppState, AppMessage> {
  const normalized = rawPath.trim();
  if (normalized.length === 0) {
    return {
      state: setFileDialogError(state, 'Enter a destination path.'),
      focus: FILE_INPUT_FOCUS
    };
  }
  const savedText = state.document.text;
  return {
    state: setNotice(closeDialog(state), { text: `Saving ${normalized}…`, status: 'info' }),
    effects: [saveMarkdownEffect(
      normalized,
      savedText,
      'saveAs',
      state.document.id,
      state.document.revision
    )]
  };
}

function requestSave(state: AppState): TuiUpdateResult<AppState, AppMessage> {
  const filePath = state.document.path;
  if (filePath === undefined) {
    return {
      state: startFileDialog(state, 'saveAs'),
      focus: FILE_INPUT_FOCUS
    };
  }
  const savedText = state.document.text;
  return {
    state: setNotice(state, { text: `Saving ${state.document.label}…`, status: 'info' }),
    effects: [saveMarkdownEffect(
      filePath,
      savedText,
      'save',
      state.document.id,
      state.document.revision
    )]
  };
}

function updateVellum(
  previewEngine: MarkdownPreviewEngine,
  state: AppState,
  message: AppMessage
): TuiUpdateResult<AppState, AppMessage> {
  switch (message.kind) {
    case 'editDocument': {
      const edited = editDocument(state, message.action);
      const next = message.sync === undefined
        ? edited
        : synchronizePreviewToEditorScroll(edited, message.sync);
      if (next.document.revision === state.document.revision) return { state: next };
      return {
        state: next,
        effects: [previewRefreshEffect(
          previewEngine,
          next.document.id,
          next.document.revision,
          next.document.text
        )]
      };
    }
    case 'editFileDialog':
      return { state: editFileDialog(state, message.action) };
    case 'scrollPreview': {
      const scrolled = setPreviewScroll(state, message.event);
      const next = message.sync === undefined
        ? scrolled
        : synchronizeEditorToPreviewScroll(scrolled, message.sync);
      return { state: next, focus: PREVIEW_FOCUS };
    }
    case 'movePreview': {
      const moved = movePreview(state, message.command, message.geometry);
      return {
        state: message.sync === undefined
          ? moved
          : synchronizeEditorToPreviewScroll(moved, message.sync)
      };
    }
    case 'activatePane': {
      const next = activatePane(state, message.pane);
      return { state: next, focus: workspaceFocus(next) };
    }
    case 'resizeSplit':
      return { state: resizeSplitPane(state, message.action) };
    case 'openDialog':
      return {
        state: startFileDialog(state, 'open'),
        focus: FILE_INPUT_FOCUS
      };
    case 'saveAsDialog':
      return {
        state: startFileDialog(state, 'saveAs'),
        focus: FILE_INPUT_FOCUS
      };
    case 'helpDialog':
      return {
        state: showHelpDialog(state),
        focus: HELP_CLOSE_FOCUS
      };
    case 'dismissDialog': {
      const hadReturningFileDialog = state.dialog?.kind === 'confirm' && state.dialog.returnTo !== undefined;
      const next = dismissDialog(state);
      return {
        state: next,
        ...(hadReturningFileDialog ? { focus: FILE_INPUT_FOCUS } : {})
      };
    }
    case 'submitFileDialog': {
      if (state.dialog?.kind !== 'file') return { state };
      const dialogState = state.dialog;
      const value = (message.value ?? dialogState.command.editor.input.text).trim();
      if (value.length === 0) {
        return {
          state: setFileDialogError(
            state,
            dialogState.operation === 'open' ? 'Enter a file path.' : 'Enter a destination path.'
          ),
          focus: FILE_INPUT_FOCUS
        };
      }
      if (dialogState.operation === 'open') {
        if (isModified(state)) {
          return {
            state: showOpenConfirmation(state, value, dialogState),
            focus: CONFIRM_CANCEL_FOCUS
          };
        }
        return requestOpen(state, value);
      }
      return requestSaveAs(state, value);
    }
    case 'confirmDiscard': {
      if (state.dialog?.kind !== 'confirm') return { state };
      if (state.dialog.operation === 'quit') {
        return { state: closeDialog(state), exit: { reason: 'quit' } };
      }
      const rawPath = state.dialog.rawPath;
      if (rawPath === undefined) {
        return {
          state: setNotice(closeDialog(state), {
            text: 'The file path is missing.',
            status: 'error'
          }),
          focus: workspaceFocus(state)
        };
      }
      return requestOpen(closeDialog(state), rawPath);
    }
    case 'toggleMode': {
      let next = setMode(state, cycleMode(state.mode));
      if (next.mode !== 'edit' && next.preview.sourceRevision !== next.document.revision) {
        next = setMarkdownPreview(next, previewEngine.update(
          next.document.id,
          next.document.revision,
          next.document.text
        ));
      }
      return { state: next, focus: workspaceFocus(next) };
    }
    case 'togglePane': {
      if (state.mode !== 'split') return { state };
      const next = toggleActivePane(state);
      return { state: next, focus: workspaceFocus(next) };
    }
    case 'save':
      return requestSave(state);
    case 'quit':
      if (isModified(state)) {
        return {
          state: showQuitConfirmation(state),
          focus: CONFIRM_CANCEL_FOCUS
        };
      }
      return { state, exit: { reason: 'quit' } };
    case 'fileOpened': {
      if (message.documentId !== state.document.id || message.revision !== state.document.revision) {
        return {
          state: setNotice(state, {
            text: 'Open result ignored because the document changed.',
            status: 'warning'
          }),
          focus: workspaceFocus(state)
        };
      }
      const documentId = state.document.id + 1;
      const preview = previewEngine.open(documentId, 0, message.file.text);
      const next = openDocument(
        state,
        message.file.path,
        message.file.label,
        message.file.text,
        preview
      );
      return {
        state: next,
        focus: EDITOR_FOCUS,
        cancelEffects: ['vellum-preview-refresh']
      };
    }
    case 'fileSaved': {
      if (message.documentId !== state.document.id) return { state };
      const next = markDocumentSaved(state, message.path, message.savedText);
      return { state: next, focus: dialogFocus(next) };
    }
    case 'previewReady':
      if (
        message.preview.documentId !== state.document.id
        || message.preview.sourceRevision !== state.document.revision
      ) return { state };
      return { state: setMarkdownPreview(state, message.preview) };
    case 'fileError': {
      if (message.documentId !== state.document.id) return { state };
      if (message.operation === 'open' && message.revision !== state.document.revision) {
        return {
          state: setNotice(state, {
            text: 'Open error ignored because the document changed.',
            status: 'warning'
          }),
          focus: workspaceFocus(state)
        };
      }
      if (message.operation === 'open' || message.operation === 'saveAs') {
        const next = startFileDialog(
          closeDialog(state),
          message.operation,
          message.rawPath,
          message.message
        );
        return { state: next, focus: FILE_INPUT_FOCUS };
      }
      const next = setNotice(state, { text: message.message, status: 'error' });
      return { state: next, focus: workspaceFocus(next) };
    }
  }
}

export interface VellumController {
  initialState(): AppState;
  update(state: AppState, message: AppMessage): TuiUpdateResult<AppState, AppMessage>;
}

export function createVellumController(): VellumController {
  const previewEngine = createMarkdownPreviewEngine();
  return Object.freeze({
    initialState(): AppState {
      return initialState(previewEngine.open(0, 0, ''));
    },
    update(state: AppState, message: AppMessage): TuiUpdateResult<AppState, AppMessage> {
      return updateVellum(previewEngine, state, message);
    }
  });
}

const vellumController = createVellumController();

export const vellumApp: TuiApp<AppState, AppMessage> = defineTui<AppState, AppMessage>({
  id: 'vellum-markdown-editor',
  init: () => ({ state: vellumController.initialState() }),
  inputBindings,
  update: (state, message) => vellumController.update(state, message),
  view,
  nonTty: {
    mode: 'last_frame',
    diagnosticHint: 'Run Vellum in an interactive terminal to edit files.'
  }
});

export async function runVellum() {
  return runTui(vellumApp, { initialFocus: EDITOR_FOCUS });
}

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  await runVellum();
}
