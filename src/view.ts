import type { TuiContext } from '@ismail-elkorchi/terminal-ui/tui';
import {
  button,
  commandInput,
  dialog,
  richText,
  statusBar,
  text,
  textArea,
  type InlineContent,
  type StatusBarItem
} from '@ismail-elkorchi/terminal-ui/components';
import {
  column,
  grid,
  overlay,
  row,
  splitPane,
  surface,
  viewport
} from '@ismail-elkorchi/terminal-ui/layout';
import {
  commandInputPresentation,
  splitPanePresentation,
  type CommandInputTransition,
  type ScrollEvent,
  type SplitPaneAction,
  type TextAreaAction
} from '@ismail-elkorchi/terminal-ui/behavior';
import {
  prepareTextDocument,
  measureTextCells,
  textCaretAt,
  textDocumentSelectionBetween
} from '@ismail-elkorchi/terminal-ui/text';
import { themeColor } from '@ismail-elkorchi/terminal-ui/theme';
import type {
  ActivePane,
  AppState,
  EditorMode,
  FileDialogOperation,
  PreviewScrollCommand
} from './editor-state.js';
import {
  cursorLineColumn,
  normalizedPreviewScroll,
  type PreviewScrollGeometry,
  type SplitScrollGeometry
} from './editor-state.js';
import type { MarkdownFileRecord } from './file-io.js';
import { getMarkdownDocument, type MarkdownDocument } from './markdown-model.js';
import { layoutMarkdownDocument, markdownDocument } from './markdown-render.js';

export const VELLUM_IDS = Object.freeze({
  editor: 'vellum-editor',
  preview: 'vellum-preview',
  split: 'vellum-split',
  fileInput: 'vellum-file-input',
  filePrimary: 'vellum-file-primary',
  dialogCancel: 'vellum-dialog-cancel',
  confirmCancel: 'vellum-confirm-cancel',
  confirmDiscard: 'vellum-confirm-discard',
  helpClose: 'vellum-help-close'
});

export type FileOperation = 'open' | 'save' | 'saveAs';

export type AppMessage =
  | { readonly kind: 'editDocument'; readonly action: TextAreaAction; readonly sync?: SplitScrollGeometry }
  | { readonly kind: 'editFileDialog'; readonly action: CommandInputTransition }
  | { readonly kind: 'scrollPreview'; readonly event: ScrollEvent; readonly sync?: SplitScrollGeometry }
  | { readonly kind: 'movePreview'; readonly command: PreviewScrollCommand; readonly geometry: PreviewScrollGeometry; readonly sync?: SplitScrollGeometry }
  | { readonly kind: 'activatePane'; readonly pane: ActivePane }
  | { readonly kind: 'resizeSplit'; readonly action: SplitPaneAction }
  | { readonly kind: 'openDialog' }
  | { readonly kind: 'saveAsDialog' }
  | { readonly kind: 'helpDialog' }
  | { readonly kind: 'dismissDialog' }
  | { readonly kind: 'submitFileDialog'; readonly value?: string }
  | { readonly kind: 'confirmDiscard' }
  | { readonly kind: 'toggleMode' }
  | { readonly kind: 'togglePane' }
  | { readonly kind: 'quit' }
  | { readonly kind: 'save' }
  | { readonly kind: 'refreshPreview'; readonly documentId: number; readonly revision: number; readonly source: string }
  | { readonly kind: 'fileOpened'; readonly file: MarkdownFileRecord; readonly documentId: number; readonly revision: number }
  | {
      readonly kind: 'fileSaved';
      readonly path: string;
      readonly savedText: string;
      readonly documentId: number;
    }
  | {
      readonly kind: 'fileError';
      readonly operation: FileOperation;
      readonly rawPath: string;
      readonly message: string;
      readonly documentId: number;
      readonly revision: number;
    };

const strong = { fg: themeColor('text.strong'), bold: true } as const;
const muted = { fg: themeColor('text.muted'), dim: true } as const;
const accent = { fg: themeColor('accent.primary'), bold: true } as const;
const activeMode = {
  fg: themeColor('control.primary.foreground'),
  bg: themeColor('control.primary.background'),
  bold: true
} as const;
const inactiveMode = { fg: themeColor('text.muted') } as const;
const warning = { fg: themeColor('status.warning'), bold: true } as const;

function editorPresentation(state: AppState) {
  return {
    document: prepareTextDocument(state.document.text),
    caret: textCaretAt(state.document.cursor),
    ...(state.document.selection === undefined
      ? {}
      : {
          selection: textDocumentSelectionBetween(
            state.document.selection.startOffset,
            state.document.selection.endOffsetExclusive
          )
        }),
    scroll: state.document.scroll,
    revealCaret: true
  };
}

function modeLabel(mode: EditorMode, selected: boolean): InlineContent {
  return [{
    kind: 'text',
    text: selected ? `[${mode.toUpperCase()}]` : ` ${mode.toUpperCase()} `,
    style: selected ? activeMode : inactiveMode
  }];
}

function makeHeader(state: AppState, columns: number) {
  const modified = state.document.text !== state.document.savedText;
  const identity: InlineContent = [
    { kind: 'text', text: 'VELLUM', style: accent },
    { kind: 'text', text: columns >= 52 ? `  ${state.document.label}` : ` ${state.document.label}`, style: strong },
    ...(modified
      ? [{ kind: 'text' as const, text: ' *', style: warning }]
      : [])
  ];

  const selector: InlineContent = columns < 44
    ? modeLabel(state.mode, true)
    : [
        ...modeLabel('edit', state.mode === 'edit'),
        { kind: 'text', text: ' ', style: muted },
        ...modeLabel('split', state.mode === 'split'),
        { kind: 'text', text: ' ', style: muted },
        ...modeLabel('preview', state.mode === 'preview')
      ];

  return surface(
    row([
      richText({ id: 'vellum-header-identity', segments: identity, wrap: false }),
      richText({ id: 'vellum-header-modes', segments: selector, wrap: false })
    ], {
      id: 'vellum-header-row',
      sizes: [{ kind: 'fill' }, { kind: 'content', max: 32 }],
      align: 'center'
    }),
    {
      id: 'vellum-header',
      appearance: 'bar',
      border: { kind: 'none' },
      padding: { left: 1, right: 1 }
    }
  );
}

function makeEditor(state: AppState, sync: SplitScrollGeometry | undefined) {
  return textArea({
    id: VELLUM_IDS.editor,
    presentation: editorPresentation(state),
    placeholder: [
      'Start a Markdown document here.',
      '',
      '# A heading',
      '',
      'Write in the source pane, then use Ctrl+P to open Split or Preview.'
    ].join('\n'),
    lineNumbers: { minWidth: 3 },
    highlightActiveLine: true,
    wrap: { mode: 'soft' },
    scrollbar: { visible: 'auto' },
    scrollPolicy: { wheel: { rows: 6, columns: 8 } },
    meta: { focus: { order: 1 } },
    onAction: (action: TextAreaAction): AppMessage => ({
      kind: 'editDocument',
      action,
      ...(action.kind === 'scroll' && sync !== undefined ? { sync } : {})
    })
  });
}

interface PreviewMetrics extends PreviewScrollGeometry {
  readonly offsetRow: number;
}

type WorkspaceLayout = 'single' | 'horizontal' | 'vertical';

function workspaceLayout(state: AppState, columns: number, rows: number): WorkspaceLayout {
  if (state.mode !== 'split') return 'single';
  if (columns >= 96) return 'horizontal';
  return columns >= 68 && rows >= 24 ? 'vertical' : 'single';
}

function paneViewportSize(
  state: AppState,
  columns: number,
  rows: number,
  layout: WorkspaceLayout,
  paneIndex: 0 | 1
) {
  const bodyRows = Math.max(1, rows - 2);
  const height = layout === 'vertical'
    ? Math.max(1, Math.floor(Math.max(0, bodyRows - 1) * (state.splitPane.shares[paneIndex] ?? 0.5)) - 2)
    : Math.max(1, bodyRows - 2);
  const width = layout === 'horizontal'
    ? Math.max(1, Math.floor(Math.max(0, columns - 1) * (state.splitPane.shares[paneIndex] ?? 0.5)) - 4)
    : Math.max(1, columns - 4);
  return { width, height };
}

function previewMetrics(
  state: AppState,
  document: MarkdownDocument,
  columns: number,
  rows: number,
  layout: WorkspaceLayout
): PreviewMetrics {
  const size = paneViewportSize(state, columns, rows, layout, 1);
  const fullPreview = state.mode === 'preview';
  const contentRows = layoutMarkdownDocument(document, {
    width: size.width,
    maxContentWidth: fullPreview ? 88 : 82,
    minHorizontalPadding: fullPreview ? 3 : 2
  }).lines.length;
  const geometry = { contentRows, pageRows: size.height };
  return {
    ...geometry,
    offsetRow: normalizedPreviewScroll(state, geometry).offsetRow
  };
}

function editorScrollGeometry(
  state: AppState,
  columns: number,
  rows: number,
  layout: WorkspaceLayout
): PreviewScrollGeometry {
  const size = paneViewportSize(state, columns, rows, layout, 0);
  const sourceLines = state.document.text.split('\n');
  const lineNumberWidth = Math.max(3, String(sourceLines.length).length);
  const contentWidth = Math.max(1, size.width - lineNumberWidth - 4);
  const contentRows = sourceLines.reduce((total, line) => {
    const cells = measureTextCells(line.replace(/\t/gu, '    ')).cells;
    return total + Math.max(1, Math.ceil(cells / contentWidth));
  }, 0);
  return { contentRows, pageRows: size.height };
}

function makePreview(
  document: MarkdownDocument,
  metrics: PreviewMetrics,
  sync: SplitScrollGeometry | undefined,
  fullPreview: boolean
) {
  return viewport(
    markdownDocument({
      id: VELLUM_IDS.preview,
      document,
      maxContentWidth: fullPreview ? 88 : 82,
      minHorizontalPadding: fullPreview ? 3 : 2,
      pageRows: metrics.pageRows,
      contentRows: metrics.contentRows,
      meta: { focus: { order: 2 } },
      onAction: (action): AppMessage => ({
        kind: 'movePreview',
        command: action.command,
        geometry: { pageRows: action.pageRows, contentRows: action.contentRows },
        ...(sync === undefined ? {} : { sync })
      })
    }),
    {
      id: 'vellum-preview-viewport',
      offset: {
        row: metrics.offsetRow,
        column: 0
      },
      scrollbar: { visible: 'auto' },
      scrollPolicy: { wheel: { rows: 6, columns: 8 } },
      meta: {
        accessibility: {
          label: 'Rendered Markdown preview',
          description: 'Use arrows, Page Up, Page Down, Home, and End to navigate.'
        }
      },
      onScroll: (event: ScrollEvent): AppMessage => ({
        kind: 'scrollPreview',
        event,
        ...(sync === undefined ? {} : { sync })
      })
    }
  );
}

function paneTitle(label: string, active: boolean): string {
  return active ? `[ ${label} · ACTIVE ]` : label;
}

function makeEditorPane(state: AppState, sync: SplitScrollGeometry | undefined) {
  const active = state.activePane === 'editor';
  return surface(makeEditor(state, sync), {
    id: 'vellum-source-surface',
    title: paneTitle('SOURCE', active),
    appearance: active ? 'raised' : 'neutral',
    border: { kind: active ? 'heavy' : 'rounded' },
    padding: { top: 0, right: 1, bottom: 0, left: 1 }
  });
}

function makePreviewPane(
  state: AppState,
  document: MarkdownDocument,
  metrics: PreviewMetrics,
  sync: SplitScrollGeometry | undefined,
  fullPreview: boolean
) {
  const active = state.activePane === 'preview';
  return surface(makePreview(document, metrics, sync, fullPreview), {
    id: 'vellum-preview-surface',
    title: paneTitle('PREVIEW', active),
    appearance: active ? 'raised' : 'neutral',
    border: { kind: active ? 'heavy' : 'rounded' },
    padding: { top: 0, right: 1, bottom: 0, left: 1 }
  });
}

function makeWorkspace(
  state: AppState,
  document: MarkdownDocument,
  metrics: PreviewMetrics | undefined,
  editorGeometry: PreviewScrollGeometry | undefined,
  layout: WorkspaceLayout
) {
  const sync = state.mode === 'split'
    && layout !== 'single'
    && metrics !== undefined
    && editorGeometry !== undefined
    ? { editor: editorGeometry, preview: metrics }
    : undefined;
  const editor = makeEditorPane(state, sync);

  if (state.mode === 'edit') return editor;
  if (layout === 'single' && state.mode === 'split' && state.activePane === 'editor') return editor;
  if (metrics === undefined) return editor;
  const preview = makePreviewPane(state, document, metrics, sync, state.mode === 'preview');
  if (state.mode === 'preview' || layout === 'single') return preview;

  const presentation = splitPanePresentation(state.splitPane);
  return splitPane([editor, preview], {
    id: VELLUM_IDS.split,
    direction: layout,
    ...presentation,
    resizeStep: 0.04,
    gap: 1,
    onAction: (action: SplitPaneAction): AppMessage => ({ kind: 'resizeSplit', action }),
    meta: {
      accessibility: {
        label: layout === 'horizontal' ? 'Source and preview split horizontally' : 'Source and preview stacked vertically'
      }
    }
  });
}

function makeStatus(
  state: AppState,
  document: MarkdownDocument,
  columns: number,
  metrics: PreviewMetrics | undefined
) {
  const cursor = cursorLineColumn(state);
  const modified = state.document.text !== state.document.savedText;
  const fileState = state.document.path === undefined ? 'UNSAVED' : modified ? 'MODIFIED' : 'SAVED';

  const leading: StatusBarItem[] = [
    {
      id: 'vellum-file-state',
      kind: 'status',
      text: `${state.document.label} · ${fileState}`,
      status: fileState === 'SAVED' ? 'success' : 'warning'
    }
  ];

  const previewActive = metrics !== undefined
    && (state.mode === 'preview' || (state.mode === 'split' && state.activePane === 'preview'));
  const center: StatusBarItem[] = [
    previewActive
      ? {
          id: 'vellum-preview-position',
          kind: 'text',
          text: `Rows ${String(metrics.offsetRow + 1)}-${String(Math.min(metrics.contentRows, metrics.offsetRow + metrics.pageRows))}/${String(metrics.contentRows)}`
        }
      : {
          id: 'vellum-cursor',
          kind: 'text',
          text: `Ln ${String(cursor.line)}, Col ${String(cursor.column)}`
        },
    ...(columns >= 72
      ? [{ id: 'vellum-words', kind: 'text' as const, text: `${String(document.wordCount)} words` }]
      : [])
  ];

  const notice = state.notice;
  const trailing: StatusBarItem[] = notice === undefined
    ? [{
        id: 'vellum-shortcuts',
        kind: 'text',
        text: previewActive && columns < 100
          ? columns >= 72 ? 'Ctrl+P Mode  F1 Help' : 'Ctrl+P  F1'
          : columns >= 100
            ? state.mode === 'split'
              ? 'Ctrl+S Save  Ctrl+P Mode  Tab Pane  F1 Help'
              : 'Ctrl+S Save  Ctrl+P Mode  F1 Help'
            : columns >= 72
              ? 'Ctrl+S Save  Ctrl+P Mode  F1 Help'
              : 'Ctrl+S  Ctrl+P  F1'
      }]
    : [{
        id: 'vellum-notice',
        kind: 'status',
        text: notice.text,
        status: notice.status
      }];

  return statusBar({
    id: 'vellum-status',
    leading,
    center,
    trailing
  });
}

function fileDialogTitle(operation: FileDialogOperation): string {
  return operation === 'open' ? 'Open Markdown file' : 'Save Markdown file as';
}

function fileDialogDescription(operation: FileDialogOperation): string {
  return operation === 'open'
    ? 'Enter the path of a Markdown file to open.'
    : 'Choose the destination path for this Markdown document.';
}

function makeFileDialog(state: AppState, columns: number, rows: number) {
  if (state.dialog?.kind !== 'file') return undefined;
  const operation = state.dialog.operation;
  const title = fileDialogTitle(operation);
  const compact = rows < 12;
  const width = Math.max(1, Math.min(72, columns - 2));

  const input = commandInput({
    id: VELLUM_IDS.fileInput,
    presentation: commandInputPresentation(state.dialog.command),
    prompt: operation === 'open' ? 'Open › ' : 'Save › ',
    placeholder: operation === 'open' ? './README.md' : './notes.md',
    display: 'expanded',
    ...(state.dialog.error === undefined
      ? {}
      : { validation: { message: state.dialog.error, level: 'error' as const } }),
    footer: 'Enter confirms · Esc cancels',
    meta: { focus: { order: 1 } },
    onTransition: (action: CommandInputTransition): AppMessage => ({ kind: 'editFileDialog', action }),
    onSubmit: ({ value }): AppMessage => ({ kind: 'submitFileDialog', value })
  });

  return dialog({
    id: 'vellum-file-dialog',
    title,
    accessibleName: title,
    modal: true,
    width,
    border: { kind: 'rounded' },
    padding: compact ? 0 : 1,
    gap: compact ? 0 : 1,
    focusPolicy: {
      initialFocus: { kind: 'element', elementId: VELLUM_IDS.fileInput },
      returnFocus: 'restore'
    },
    dismissal: {
      dismissOnEscape: true,
      dismissOnOutsidePress: false
    },
    onAction: (): AppMessage => ({ kind: 'dismissDialog' }),
    slots: {
      content: column([
        ...(compact
          ? []
          : [text({ id: 'vellum-file-description', content: fileDialogDescription(operation), textRole: 'body' })]),
        input
      ], { gap: compact ? 0 : 1 }),
      actions: row([
        button({
          id: VELLUM_IDS.dialogCancel,
          label: 'Cancel',
          tone: 'secondary',
          onAction: (): AppMessage => ({ kind: 'dismissDialog' })
        }),
        button({
          id: VELLUM_IDS.filePrimary,
          label: operation === 'open' ? 'Open' : 'Save As',
          tone: 'primary',
          onAction: (): AppMessage => ({ kind: 'submitFileDialog' })
        })
      ], {
        gap: 1,
        justify: 'end'
      })
    }
  });
}

function makeConfirmDialog(state: AppState, columns: number, rows: number) {
  if (state.dialog?.kind !== 'confirm') return undefined;
  const opening = state.dialog.operation === 'open';
  const title = 'Unsaved changes';
  const compact = rows < 12;
  const width = Math.max(1, Math.min(64, columns - 2));
  const message = opening
    ? 'Opening another file will discard the changes in the current document.'
    : 'Quit Vellum and discard the changes in the current document?';

  return dialog({
    id: 'vellum-confirm-dialog',
    title,
    accessibleName: title,
    modal: true,
    width,
    border: { kind: 'rounded' },
    padding: compact ? 0 : 1,
    gap: compact ? 0 : 1,
    focusPolicy: {
      initialFocus: { kind: 'element', elementId: VELLUM_IDS.confirmCancel },
      returnFocus: 'restore'
    },
    dismissal: {
      dismissOnEscape: true,
      dismissOnOutsidePress: false
    },
    onAction: (): AppMessage => ({ kind: 'dismissDialog' }),
    slots: {
      content: column([
        text({ id: 'vellum-confirm-message', content: message, textRole: 'body' }),
        ...(compact
          ? []
          : [text({
              id: 'vellum-confirm-hint',
              content: 'Save first to keep your work.',
              textRole: 'caption',
              meta: { styles: { root: muted } }
            })])
      ], { gap: compact ? 0 : 1 }),
      actions: row([
        button({
          id: VELLUM_IDS.confirmCancel,
          label: 'Keep Editing',
          tone: 'secondary',
          onAction: (): AppMessage => ({ kind: 'dismissDialog' })
        }),
        button({
          id: VELLUM_IDS.confirmDiscard,
          label: opening ? 'Discard and Open' : 'Discard and Quit',
          tone: 'destructive',
          onAction: (): AppMessage => ({ kind: 'confirmDiscard' })
        })
      ], { gap: 1, justify: 'end' })
    }
  });
}

function makeHelpDialog(state: AppState, columns: number, rows: number) {
  if (state.dialog?.kind !== 'help') return undefined;
  const compact = rows < 18;
  const width = Math.max(1, Math.min(68, columns - 2));
  const shortcuts = (compact ? [
    'Ctrl+O Open · Ctrl+S Save · F2 Save As',
    'Ctrl+P Mode · Tab Pane · ↑/↓ Scroll',
    'PgUp/PgDn Page · Home/End Edge · Ctrl+Q Quit'
  ] : [
    'Ctrl+O       Open file',
    'Ctrl+S       Save',
    'F2 / Ctrl+Shift+S Save As',
    'Ctrl+P       Edit → Split → Preview',
    'Tab          Switch panes in Split mode',
    'Arrow keys   Scroll Preview',
    'PgUp / PgDn  Scroll Preview by page',
    'Home / End   Preview start / end',
    'Alt+Arrows   Resize a visible split',
    'Ctrl+Q       Quit',
    'F1           Show this help'
  ]).join('\n');

  return dialog({
    id: 'vellum-help-dialog',
    title: 'Vellum keyboard shortcuts',
    accessibleName: 'Vellum keyboard shortcuts',
    modal: true,
    width,
    border: { kind: 'rounded' },
    padding: compact ? 0 : 1,
    focusPolicy: {
      initialFocus: { kind: 'element', elementId: VELLUM_IDS.helpClose },
      returnFocus: 'restore'
    },
    dismissal: {
      dismissOnEscape: true,
      dismissOnOutsidePress: true
    },
    onAction: (): AppMessage => ({ kind: 'dismissDialog' }),
    slots: {
      content: text({
        id: 'vellum-help-content',
        content: shortcuts,
        textRole: 'body'
      }),
      actions: button({
        id: VELLUM_IDS.helpClose,
        label: 'Close',
        tone: 'primary',
        onAction: (): AppMessage => ({ kind: 'dismissDialog' })
      })
    }
  });
}

function makeDialog(state: AppState, columns: number, rows: number) {
  return makeFileDialog(state, columns, rows)
    ?? makeConfirmDialog(state, columns, rows)
    ?? makeHelpDialog(state, columns, rows);
}

export function view(state: AppState, context: TuiContext) {
  const columns = Math.max(1, context.terminalSize.columns);
  const rows = Math.max(1, context.terminalSize.rows);
  const document = getMarkdownDocument(state.previewSource);
  const layout = workspaceLayout(state, columns, rows);
  const previewVisible = state.mode === 'preview'
    || (state.mode === 'split' && (layout !== 'single' || state.activePane === 'preview'));
  const metrics = previewVisible
    ? previewMetrics(state, document, columns, rows, layout)
    : undefined;
  const editorGeometry = state.mode === 'split' && layout !== 'single'
    ? editorScrollGeometry(state, columns, rows, layout)
    : undefined;
  const root = grid({
    id: 'vellum-root',
    areas: `
      header
      body
      status
    `,
    rows: [
      { kind: 'fixed', cells: 1 },
      { kind: 'fill' },
      { kind: 'fixed', cells: 1 }
    ],
    columns: [{ kind: 'fill' }],
    children: {
      header: makeHeader(state, columns),
      body: makeWorkspace(state, document, metrics, editorGeometry, layout),
      status: makeStatus(state, document, columns, metrics)
    }
  });
  const activeDialog = makeDialog(state, columns, rows);
  return activeDialog === undefined
    ? root
    : overlay([root, activeDialog], { id: 'vellum-root-overlay' });
}
