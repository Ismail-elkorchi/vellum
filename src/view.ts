import type { TuiContext } from '@ismail-elkorchi/terminal-ui/tui';
import {
  button,
  commandInput,
  dialog,
  richText,
  tabs,
  text,
  textArea,
  tree,
  type TabCloseEvent,
  type TabsTransition,
  type TreeActivateEvent
} from '@ismail-elkorchi/terminal-ui/components';
import {
  commandInputView,
  splitPaneLayout,
  type CommandInputTransition,
  type ScrollRequest,
  type SplitPaneTransition,
  type TextAreaTransition,
  type TreeTransition
} from '@ismail-elkorchi/terminal-ui/behavior';
import { column, grid, overlay, row, splitPane, surface, viewport } from '@ismail-elkorchi/terminal-ui/layout';
import { themeColor } from '@ismail-elkorchi/terminal-ui/theme';
import type { TextWidthProfile } from '@ismail-elkorchi/terminal-ui/text';
import type { TerminalSize } from '@ismail-elkorchi/terminal-ui/host';
import type { AppState, BufferId, BufferState, CommandId } from './app/types.js';
import { bufferIsDirty } from './app/types.js';
import type {
  SynchronizedPaneGeometry,
  VellumApplication,
  VellumApplicationUpdate
} from './app/application.js';
import { markdownPreview, type MarkdownPreviewAction } from './markdown/render/component.js';
import { terminalFileTreeView } from './project/file-tree.js';
import {
  vellumBodyGeometry,
  vellumPaneGeometry,
  vellumPreviewDocumentGeometry,
} from './app/viewport-geometry.js';

export const VELLUM_IDS = Object.freeze({
  editor: 'vellum-editor',
  preview: 'vellum-preview',
  tabs: 'vellum-buffers',
  fileTree: 'vellum-file-tree',
  filePath: 'vellum-file-path',
  selection: 'vellum-selection',
  searchQuery: 'vellum-search-query',
  searchReplacement: 'vellum-search-replacement',
  dialogCancel: 'vellum-dialog-cancel',
  dialogPrimary: 'vellum-dialog-primary'
});

export type AppMessage =
  | { readonly kind: 'editor'; readonly bufferId: BufferId; readonly transition: TextAreaTransition; readonly synchronization?: SynchronizedPaneGeometry }
  | { readonly kind: 'previewScroll'; readonly bufferId: BufferId; readonly request: ScrollRequest; readonly synchronization?: SynchronizedPaneGeometry }
  | { readonly kind: 'tabs'; readonly transition: TabsTransition<BufferId> }
  | { readonly kind: 'closeTab'; readonly bufferId: BufferId }
  | { readonly kind: 'fileTree'; readonly transition: TreeTransition }
  | { readonly kind: 'activateFileTree'; readonly nodeId: string }
  | { readonly kind: 'split'; readonly transition: SplitPaneTransition }
  | { readonly kind: 'command'; readonly commandId: CommandId }
  | { readonly kind: 'filePath'; readonly transition: CommandInputTransition }
  | { readonly kind: 'submitFilePath'; readonly value?: string }
  | { readonly kind: 'selection'; readonly transition: CommandInputTransition }
  | { readonly kind: 'submitSelection'; readonly value?: string }
  | { readonly kind: 'documentSearch'; readonly field: 'query' | 'replacement'; readonly transition: CommandInputTransition }
  | { readonly kind: 'configureDocumentSearch'; readonly option: 'regularExpression' | 'caseSensitive' | 'wholeWord' | 'selectionOnly' }
  | { readonly kind: 'navigateDocumentSearch'; readonly direction: 'next' | 'previous' }
  | { readonly kind: 'replaceDocumentSearch'; readonly scope: 'current' | 'all' }
  | { readonly kind: 'projectDirectorySearch'; readonly transition: CommandInputTransition }
  | { readonly kind: 'submitProjectDirectorySearch'; readonly value?: string }
  | { readonly kind: 'outline'; readonly transition: CommandInputTransition }
  | { readonly kind: 'submitOutline'; readonly value?: string }
  | { readonly kind: 'goToLine'; readonly transition: CommandInputTransition }
  | { readonly kind: 'submitGoToLine'; readonly value?: string }
  | { readonly kind: 'previewActivate'; readonly bufferId: BufferId; readonly target: MarkdownPreviewAction['target'] }
  | { readonly kind: 'exportProfile'; readonly transition: CommandInputTransition }
  | { readonly kind: 'submitExportProfile'; readonly value?: string }
  | { readonly kind: 'dismissDialog' }
  | { readonly kind: 'resolveDirty'; readonly action: 'save' | 'discard' | 'cancel' }
  | { readonly kind: 'externalFile'; readonly action: 'compare' | 'reloadDisk' | 'keepBuffer' | 'saveAs' | 'overwriteDisk' | 'recreate' | 'closeBuffer' }
  | { readonly kind: 'checkExternalFiles' }
  | { readonly kind: 'applicationUpdate'; readonly update: VellumApplicationUpdate }
  | { readonly kind: 'terminalResize'; readonly previousTerminalSize: TerminalSize; readonly terminalSize: TerminalSize; readonly widthProfile: TextWidthProfile }
  | { readonly kind: 'exit' }
  | { readonly kind: 'refresh' };

export function viewVellum(
  application: VellumApplication,
  state: AppState,
  context: Pick<TuiContext, 'terminalSize' | 'capabilities'>
) {
  const columns = Math.max(1, context.terminalSize.columns);
  const geometry = vellumBodyGeometry(state, context.terminalSize);
  const widthProfile = context.capabilities.unicode.widthProfile;
  const root = grid({
    id: 'vellum-root',
    areas: `header\nbody\nstatus`,
    rows: [{ kind: 'fixed', cells: 1 }, { kind: 'fill' }, { kind: 'fixed', cells: 1 }],
    columns: [{ kind: 'fill' }],
    children: {
      header: header(state),
      body: geometry.fileTreeWidth === 0
        ? bufferTabs(application, state, geometry.bodyWidth, geometry.bodyRows, widthProfile)
        : row([
          fileTree(state),
          bufferTabs(application, state, geometry.bodyWidth, geometry.bodyRows, widthProfile)
        ], { sizes: [{ kind: 'fixed', cells: geometry.fileTreeWidth }, { kind: 'fill' }], gap: 1 }),
      status: status(state)
    }
  });
  const modal = activeDialog(state, columns);
  return modal === undefined ? root : overlay([root, modal], { id: 'vellum-overlay' });
}

function header(state: AppState) {
  const project = state.project.rootDirectory?.split(/[\\/]/u).at(-1) ?? 'No project directory';
  return surface(richText({
    id: 'vellum-header-text',
    segments: [
      { kind: 'text', text: 'MARKDOWN VELLUM', style: { fg: themeColor('accent.primary'), bold: true } },
      { kind: 'text', text: `  ${project}`, style: { fg: themeColor('text.muted') } },
      { kind: 'text', text: `  ${state.editorMode.toUpperCase()} · ${state.paneArrangement}` }
    ],
    wrap: false
  }), { id: 'vellum-header', appearance: 'bar', border: { kind: 'none' }, padding: { left: 1, right: 1 } });
}

function status(state: AppState) {
  const activeId = state.project.activeBufferId;
  const buffer = activeId === undefined ? undefined : state.project.buffers[activeId];
  const textValue = state.notice !== undefined
    ? `${state.notice.status.toUpperCase()}: ${state.notice.message}`
    : buffer === undefined
      ? 'Ctrl+N new file · Ctrl+O open file · Ctrl+Alt+D open project directory'
      : `${buffer.label} · ${bufferIsDirty(buffer) ? 'UNSAVED' : 'SAVED'} · ${buffer.preview.kind === 'ready' ? `${String(buffer.preview.metrics.wordCount)} words` : 'PREVIEW FAILED'}`;
  return surface(text({ id: 'vellum-status-text', content: textValue, textRole: 'metadata' }), {
    id: 'vellum-status', appearance: 'bar', border: { kind: 'none' }, padding: { left: 1, right: 1 }
  });
}

function bufferTabs(
  application: VellumApplication,
  state: AppState,
  width: number,
  rows: number,
  widthProfile: TextWidthProfile,
) {
  const items = state.project.bufferOrder.flatMap((id) => {
    const buffer = state.project.buffers[id];
    if (buffer === undefined) return [];
    const conflict = buffer.externalFileState.kind === 'conflict' || buffer.externalFileState.kind === 'deleted';
    return [{
      id,
      label: buffer.label,
      ...(conflict ? { badge: '!' } : bufferIsDirty(buffer) ? { badge: '●' } : {}),
      description: conflict ? 'External file conflict' : bufferIsDirty(buffer) ? 'Unsaved source document' : 'Saved source document',
      closable: true,
      panel: applicationContent(
        application,
        state,
        buffer,
        width,
        Math.max(1, rows - 1),
        widthProfile,
      )
    }];
  });
  if (items.length === 0) {
    return surface(text({
      id: 'vellum-empty',
      content: 'Open a Markdown file or create a new source document.',
      textRole: 'body'
    }), { id: 'vellum-empty-surface', title: 'Vellum', border: { kind: 'rounded' }, padding: 1 });
  }
  return tabs({
    id: VELLUM_IDS.tabs,
    tabs: items,
    state: {
      ...(state.project.activeBufferId === undefined ? {} : {
        activeId: state.project.activeBufferId,
        selectedId: state.project.activeBufferId
      })
    },
    onTransition: (transition: TabsTransition<BufferId>): AppMessage => ({ kind: 'tabs', transition }),
    onClose: (event: TabCloseEvent<BufferId>): AppMessage => ({ kind: 'closeTab', bufferId: event.id }),
    meta: { accessibleName: 'Open buffers', focus: { order: 2 } }
  });
}

function applicationContent(
  application: VellumApplication,
  state: AppState,
  buffer: BufferState,
  width: number,
  rows: number,
  widthProfile: TextWidthProfile,
) {
  if (state.paneArrangement === 'editor') {
    return editorPane(application, state, buffer);
  }
  if (state.paneArrangement === 'preview') {
    return previewPane(application, buffer, width, rows, widthProfile);
  }
  const geometry = vellumPaneGeometry(state, width, rows);
  const editorSize = geometry.editor;
  const previewSize = geometry.preview;
  if (editorSize === undefined || previewSize === undefined) throw new Error('Editor and preview geometry is incomplete.');
  const synchronization: SynchronizedPaneGeometry = Object.freeze({
    editor: editorSize,
    preview: previewSize,
    widthProfile,
  });
  const editor = editorPane(
    application,
    state,
    buffer,
    synchronization,
  );
  const preview = previewPane(
    application,
    buffer,
    previewSize.width,
    previewSize.rows,
    widthProfile,
    synchronization,
  );
  return splitPane([editor, preview], {
    id: `vellum-split-${buffer.id}`,
    direction: geometry.direction,
    ...splitPaneLayout(state.splitPane),
    gap: 1,
    resizeStep: 0.04,
    onTransition: (transition: SplitPaneTransition): AppMessage => ({ kind: 'split', transition }),
    meta: { accessibility: { label: 'Editor and preview panes' } }
  });
}

function editorPane(
  application: VellumApplication,
  state: AppState,
  buffer: BufferState,
  synchronization?: SynchronizedPaneGeometry
) {
  const decorations = state.editorMode === 'hybrid'
    ? application.hybridDecorations(buffer.id)
    : undefined;
  return textArea({
    id: `${VELLUM_IDS.editor}-${buffer.id}`,
    state: {
      document: buffer.editor.document,
      caret: buffer.editor.caret,
      ...(buffer.editor.selection === undefined ? {} : { selection: buffer.editor.selection }),
      scroll: buffer.editor.scroll,
      revealCaret: buffer.editor.revealCaret
    },
    placeholder: 'Start a Markdown source document.',
    ...(decorations === undefined ? {} : { decorations }),
    lineNumbers: { minWidth: 3 },
    wrap: { mode: 'soft' },
    scrollbar: { visible: 'auto' },
    scrollPolicy: { wheel: { rows: 5, columns: 8 } },
    meta: { accessibleName: `${buffer.label} source document`, focus: { order: 3 } },
    onTransition: (transition: TextAreaTransition): AppMessage => ({
      kind: 'editor',
      bufferId: buffer.id,
      transition,
      ...(synchronization === undefined ? {} : { synchronization })
    })
  });
}

function previewPane(
  application: VellumApplication,
  buffer: BufferState,
  width: number,
  rows: number,
  widthProfile: TextWidthProfile,
  synchronization?: SynchronizedPaneGeometry
) {
  if (buffer.preview.kind === 'failed') {
    return surface(text({ id: `preview-failed-${buffer.id}`, content: `Preview failed: ${buffer.preview.message}`, textRole: 'body' }), {
      id: `preview-failed-surface-${buffer.id}`,
      title: 'Preview', border: { kind: 'rounded' }, padding: 1
    });
  }
  const layout = application.previewViewportLayout(
    buffer.id,
    width,
    rows,
    application.markdownTheme(),
    widthProfile,
  );
  if (layout === undefined) return text({ id: `preview-empty-${buffer.id}`, content: '', textRole: 'body' });
  const viewportWidth = Math.max(1, width - (layout.rows.length > rows ? 1 : 0));
  const geometry = vellumPreviewDocumentGeometry(viewportWidth);
  return viewport(markdownPreview({
    id: `preview-content-${buffer.id}`,
    label: `${buffer.label} rendered preview`,
    layout,
    viewportWidth,
    contentColumn: geometry.contentColumn,
    onAction: (action): AppMessage => ({
      kind: 'previewActivate', bufferId: buffer.id, target: action.target
    })
  }), {
    id: `${VELLUM_IDS.preview}-${buffer.id}`,
    offset: { row: buffer.previewScroll.offsetRow, column: buffer.previewScroll.offsetColumn },
    scrollbar: { visible: 'auto' },
    scrollPolicy: { wheel: { rows: 5, columns: 8 } },
    meta: { accessibility: { label: `${buffer.label} preview` } },
    onScroll: (request: ScrollRequest): AppMessage => ({
      kind: 'previewScroll',
      bufferId: buffer.id,
      request,
      ...(synchronization === undefined ? {} : { synchronization })
    })
  });
}

function fileTree(state: AppState) {
  const view = terminalFileTreeView(state.project.fileTree);
  return tree({
    id: VELLUM_IDS.fileTree,
    view,
    state: {
      ...(state.project.fileTree.activeId === undefined ? {} : { activeId: state.project.fileTree.activeId }),
      selection: state.project.fileTree.activeId === undefined
        ? { mode: 'single' }
        : { mode: 'single', selectedId: state.project.fileTree.activeId },
      expandedIds: state.project.fileTree.expandedIds,
      scroll: state.project.fileTree.scroll
    },
    emptyText: 'Project directory is empty',
    meta: { accessibleName: 'File tree', focus: { order: 1 } },
    onTransition: (transition: TreeTransition): AppMessage => ({ kind: 'fileTree', transition }),
    onActivate: (event: TreeActivateEvent): AppMessage => ({ kind: 'activateFileTree', nodeId: event.id })
  });
}

function activeDialog(state: AppState, columns: number) {
  const active = state.dialogState;
  if (active?.kind === 'commandPalette' || active?.kind === 'quickOpen') {
    const title = active.kind === 'commandPalette' ? 'Command Palette' : 'Quick Open';
    return dialog({
      id: `vellum-${active.kind}-dialog`,
      title,
      accessibleName: title,
      modal: true,
      width: Math.max(1, Math.min(76, columns - 2)),
      border: { kind: 'rounded' },
      padding: 1,
      focusPolicy: { initialFocus: { kind: 'element', elementId: VELLUM_IDS.selection }, returnFocus: 'restore' },
      dismissal: { dismissOnEscape: true, dismissOnOutsidePress: false },
      onDismiss: (): AppMessage => ({ kind: 'dismissDialog' }),
      slots: {
        content: commandInput({
          id: VELLUM_IDS.selection,
          view: commandInputView(active.command),
          prompt: active.kind === 'commandPalette' ? 'Command › ' : 'File › ',
          placeholder: active.kind === 'commandPalette' ? 'Search commands' : 'Search the file tree',
          display: 'expanded',
          maxVisibleSuggestions: 12,
          ...(active.error === undefined ? {} : { validation: { level: 'error' as const, message: active.error } }),
          footer: '↑/↓ selects · Enter opens · Esc cancels',
          meta: { accessibleName: title, focus: { order: 1 } },
          onTransition: (transition: CommandInputTransition): AppMessage => ({ kind: 'selection', transition }),
          onSubmit: ({ value }): AppMessage => ({ kind: 'submitSelection', value })
        })
      }
    });
  }
  if (active?.kind === 'documentSearch') {
    const count = active.matches.length;
    const position = active.selectedIndex === undefined ? 0 : active.selectedIndex + 1;
    return dialog({
      id: 'vellum-document-search-dialog', title: active.replacement === undefined ? 'Find in Source Document' : 'Replace in Source Document',
      accessibleName: active.replacement === undefined ? 'Find in source document' : 'Replace in source document', modal: true,
      width: Math.max(1, Math.min(78, columns - 2)), border: { kind: 'rounded' }, padding: 1, gap: 1,
      focusPolicy: { initialFocus: { kind: 'element', elementId: VELLUM_IDS.searchQuery }, returnFocus: 'restore' },
      dismissal: { dismissOnEscape: true, dismissOnOutsidePress: false },
      onDismiss: (): AppMessage => ({ kind: 'dismissDialog' }),
      slots: {
        content: column([
          commandInput({
            id: VELLUM_IDS.searchQuery, view: commandInputView(active.query), prompt: 'Find › ', display: 'compact',
            ...(active.error === undefined ? {} : { validation: { level: 'error' as const, message: active.error } }),
            meta: { accessibleName: 'Search query', focus: { order: 1 } },
            onTransition: (transition: CommandInputTransition): AppMessage => ({ kind: 'documentSearch', field: 'query', transition }),
            onSubmit: (): AppMessage => ({ kind: 'navigateDocumentSearch', direction: 'next' })
          }),
          ...(active.replacement === undefined ? [] : [commandInput({
            id: VELLUM_IDS.searchReplacement, view: commandInputView(active.replacement), prompt: 'Replace › ', display: 'compact',
            meta: { accessibleName: 'Replacement text', focus: { order: 2 } },
            onTransition: (transition: CommandInputTransition): AppMessage => ({ kind: 'documentSearch', field: 'replacement', transition }),
            onSubmit: (): AppMessage => ({ kind: 'replaceDocumentSearch', scope: 'current' })
          })]),
          row([
            searchOptionButton('regexp', 'Regex', active.regularExpression, 'regularExpression'),
            searchOptionButton('case', 'Case', active.caseSensitive, 'caseSensitive'),
            searchOptionButton('word', 'Whole word', active.wholeWord, 'wholeWord'),
            searchOptionButton('selection', 'Selection', active.selectionOnly, 'selectionOnly')
          ], { gap: 1 }),
          text({ id: 'vellum-search-count', content: `${String(position)} of ${String(count)} matches`, textRole: 'metadata' })
        ], { gap: 1 }),
        actions: row([
          button({ id: VELLUM_IDS.dialogCancel, label: 'Cancel', tone: 'secondary', onPress: (): AppMessage => ({ kind: 'dismissDialog' }) }),
          button({ id: 'vellum-search-previous', label: 'Previous', tone: 'secondary', onPress: (): AppMessage => ({ kind: 'navigateDocumentSearch', direction: 'previous' }) }),
          button({ id: 'vellum-search-next', label: 'Next', tone: 'primary', onPress: (): AppMessage => ({ kind: 'navigateDocumentSearch', direction: 'next' }) }),
          ...(active.replacement === undefined ? [] : [
            button({ id: 'vellum-replace-current', label: 'Replace', tone: 'secondary', onPress: (): AppMessage => ({ kind: 'replaceDocumentSearch', scope: 'current' }) }),
            button({ id: 'vellum-replace-all', label: 'Replace All', tone: 'primary', onPress: (): AppMessage => ({ kind: 'replaceDocumentSearch', scope: 'all' }) })
          ])
        ], { gap: 1, justify: 'end' })
      }
    });
  }
  if (active?.kind === 'outline') {
    return dialog({
      id: 'vellum-outline-dialog', title: 'Outline', accessibleName: 'Source document outline', modal: true,
      width: Math.max(1, Math.min(78, columns - 2)), border: { kind: 'rounded' }, padding: 1,
      focusPolicy: { initialFocus: { kind: 'element', elementId: VELLUM_IDS.selection }, returnFocus: 'restore' },
      dismissal: { dismissOnEscape: true, dismissOnOutsidePress: false },
      onDismiss: (): AppMessage => ({ kind: 'dismissDialog' }),
      slots: {
        content: commandInput({
          id: VELLUM_IDS.selection, view: commandInputView(active.query), prompt: 'Heading › ',
          placeholder: 'Filter headings', display: 'expanded', maxVisibleSuggestions: 14,
          footer: `${String(active.entries.length)} headings · Enter navigates`,
          meta: { accessibleName: 'Heading hierarchy', focus: { order: 1 } },
          onTransition: (transition: CommandInputTransition): AppMessage => ({ kind: 'outline', transition }),
          onSubmit: ({ value }): AppMessage => ({ kind: 'submitOutline', value })
        })
      }
    });
  }
  if (active?.kind === 'goToLine') {
    return dialog({
      id: 'vellum-go-to-line-dialog', title: 'Go to Line', accessibleName: 'Go to source line', modal: true,
      width: Math.max(1, Math.min(48, columns - 2)), border: { kind: 'rounded' }, padding: 1,
      focusPolicy: { initialFocus: { kind: 'element', elementId: VELLUM_IDS.selection }, returnFocus: 'restore' },
      dismissal: { dismissOnEscape: true, dismissOnOutsidePress: false },
      onDismiss: (): AppMessage => ({ kind: 'dismissDialog' }),
      slots: {
        content: commandInput({
          id: VELLUM_IDS.selection, view: commandInputView(active.command), prompt: 'Line › ', display: 'compact',
          ...(active.error === undefined ? {} : { validation: { level: 'error' as const, message: active.error } }),
          meta: { accessibleName: 'One-based source line', focus: { order: 1 } },
          onTransition: (transition: CommandInputTransition): AppMessage => ({ kind: 'goToLine', transition }),
          onSubmit: ({ value }): AppMessage => ({ kind: 'submitGoToLine', value })
        })
      }
    });
  }
  if (active?.kind === 'exportProfile') {
    const title = active.scope === 'activeBuffer' ? 'Export Active Buffer' : 'Export Project Directory';
    return dialog({
      id: 'vellum-export-profile-dialog', title, accessibleName: title, modal: true,
      width: Math.max(1, Math.min(64, columns - 2)), border: { kind: 'rounded' }, padding: 1,
      focusPolicy: { initialFocus: { kind: 'element', elementId: VELLUM_IDS.selection }, returnFocus: 'restore' },
      dismissal: { dismissOnEscape: true, dismissOnOutsidePress: false },
      onDismiss: (): AppMessage => ({ kind: 'dismissDialog' }),
      slots: {
        content: commandInput({
          id: VELLUM_IDS.selection, view: commandInputView(active.command), prompt: 'Profile › ',
          placeholder: 'HTML, PDF, DOCX, or EPUB', display: 'expanded', maxVisibleSuggestions: 8,
          ...(active.error === undefined ? {} : { validation: { level: 'error' as const, message: active.error } }),
          footer: 'Enter starts the export · existing outputs are never replaced',
          meta: { accessibleName: 'Export profile', focus: { order: 1 } },
          onTransition: (transition: CommandInputTransition): AppMessage => ({ kind: 'exportProfile', transition }),
          onSubmit: ({ value }): AppMessage => ({ kind: 'submitExportProfile', value })
        })
      }
    });
  }
  if (active?.kind === 'projectDirectorySearch') {
    return dialog({
      id: 'vellum-project-directory-search-dialog', title: 'Search Project Directory', accessibleName: 'Search project directory', modal: true,
      width: Math.max(1, Math.min(90, columns - 2)), border: { kind: 'rounded' }, padding: 1,
      focusPolicy: { initialFocus: { kind: 'element', elementId: VELLUM_IDS.searchQuery }, returnFocus: 'restore' },
      dismissal: { dismissOnEscape: true, dismissOnOutsidePress: false },
      onDismiss: (): AppMessage => ({ kind: 'dismissDialog' }),
      slots: {
        content: commandInput({
          id: VELLUM_IDS.searchQuery, view: commandInputView(active.query), prompt: 'Project › ',
          placeholder: 'Search indexed text files', display: 'expanded', maxVisibleSuggestions: 14,
          ...(active.error === undefined ? {} : { validation: { level: 'error' as const, message: active.error } }),
          footer: active.searching ? 'Searching…' : `${String(active.results.length)} matches · Enter searches or opens the selected result`,
          meta: { accessibleName: 'Project directory search query and results', focus: { order: 1 } },
          onTransition: (transition: CommandInputTransition): AppMessage => ({ kind: 'projectDirectorySearch', transition }),
          onSubmit: ({ value }): AppMessage => ({ kind: 'submitProjectDirectorySearch', value })
        })
      }
    });
  }
  if (active?.kind === 'filePath') {
    const title = active.operation === 'openFile' ? 'Open file' : active.operation === 'openProjectDirectory' ? 'Open project directory' : 'Save as';
    return dialog({
      id: 'vellum-file-path-dialog',
      title,
      accessibleName: title,
      modal: true,
      width: Math.max(1, Math.min(72, columns - 2)),
      border: { kind: 'rounded' },
      padding: 1,
      gap: 1,
      focusPolicy: { initialFocus: { kind: 'element', elementId: VELLUM_IDS.filePath }, returnFocus: 'restore' },
      dismissal: { dismissOnEscape: true, dismissOnOutsidePress: false },
      onDismiss: (): AppMessage => ({ kind: 'dismissDialog' }),
      slots: {
        content: commandInput({
          id: VELLUM_IDS.filePath,
          view: commandInputView(active.command),
          prompt: 'Path › ',
          display: 'expanded',
          ...(active.error === undefined ? {} : { validation: { level: 'error' as const, message: active.error } }),
          footer: 'Enter confirms · Esc cancels',
          meta: { accessibleName: title, focus: { order: 1 } },
          onTransition: (transition: CommandInputTransition): AppMessage => ({ kind: 'filePath', transition }),
          onSubmit: ({ value }): AppMessage => ({ kind: 'submitFilePath', value })
        }),
        actions: row([
          button({ id: VELLUM_IDS.dialogCancel, label: 'Cancel', tone: 'secondary', onPress: (): AppMessage => ({ kind: 'dismissDialog' }) }),
          button({ id: VELLUM_IDS.dialogPrimary, label: 'Confirm', tone: 'primary', onPress: (): AppMessage => ({ kind: 'submitFilePath' }) })
        ], { gap: 1, justify: 'end' })
      }
    });
  }
  if (active?.kind === 'dirtyBuffer') {
    const multiple = active.bufferIds.length > 1;
    return dialog({
      id: 'vellum-dirty-dialog', title: 'Unsaved buffers', accessibleName: 'Unsaved buffers', modal: true,
      width: Math.max(1, Math.min(64, columns - 2)), border: { kind: 'rounded' }, padding: 1, gap: 1,
      focusPolicy: { initialFocus: { kind: 'element', elementId: VELLUM_IDS.dialogCancel }, returnFocus: 'restore' },
      dismissal: { dismissOnEscape: true, dismissOnOutsidePress: false },
      onDismiss: (): AppMessage => ({ kind: 'resolveDirty', action: 'cancel' }),
      slots: {
        content: text({ id: 'vellum-dirty-message', content: multiple ? 'Save all unsaved buffers before closing?' : 'Save this buffer before closing?', textRole: 'body' }),
        actions: row([
          button({ id: VELLUM_IDS.dialogCancel, label: 'Cancel', tone: 'secondary', onPress: (): AppMessage => ({ kind: 'resolveDirty', action: 'cancel' }) }),
          button({ id: 'vellum-discard', label: multiple ? 'Discard All' : 'Discard', tone: 'destructive', onPress: (): AppMessage => ({ kind: 'resolveDirty', action: 'discard' }) }),
          button({ id: VELLUM_IDS.dialogPrimary, label: multiple ? 'Save All' : 'Save', tone: 'primary', onPress: (): AppMessage => ({ kind: 'resolveDirty', action: 'save' }) })
        ], { gap: 1, justify: 'end' })
      }
    });
  }
  if (active?.kind === 'externalConflict') {
    const buffer = state.project.buffers[active.bufferId];
    const deleted = buffer?.externalFileState.kind === 'deleted';
    const comparison = active.comparison?.map((line) => `${line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' '} ${line.text}`).join('\n');
    return dialog({
      id: 'vellum-external-file-dialog',
      title: deleted ? 'File deleted on disk' : 'External file conflict',
      accessibleName: deleted ? 'File deleted on disk' : 'External file conflict',
      modal: true,
      width: Math.max(1, Math.min(88, columns - 2)),
      border: { kind: 'rounded' }, padding: 1, gap: 1,
      focusPolicy: { initialFocus: { kind: 'element', elementId: VELLUM_IDS.dialogCancel }, returnFocus: 'restore' },
      slots: {
        content: column([
          text({
            id: 'vellum-external-file-message',
            content: deleted
              ? 'The external file was deleted. Choose how to handle the source document in this buffer.'
              : 'The external file changed while this buffer has unsaved edits. No data has been overwritten.',
            textRole: 'body'
          }),
          ...(comparison === undefined ? [] : [viewport(text({ id: 'vellum-external-comparison', content: comparison, textRole: 'body' }), {
            id: 'vellum-external-comparison-viewport', maxHeight: 12,
            meta: { accessibility: { label: 'Line comparison between buffer and disk' } }
          })])
        ], { gap: 1 }),
        actions: deleted
          ? row([
            button({ id: VELLUM_IDS.dialogCancel, label: 'Close Buffer', tone: 'secondary', onPress: (): AppMessage => ({ kind: 'externalFile', action: 'closeBuffer' }) }),
            button({ id: 'vellum-deleted-save-as', label: 'Save As', tone: 'secondary', onPress: (): AppMessage => ({ kind: 'externalFile', action: 'saveAs' }) }),
            button({ id: VELLUM_IDS.dialogPrimary, label: 'Recreate', tone: 'primary', onPress: (): AppMessage => ({ kind: 'externalFile', action: 'recreate' }) })
          ], { gap: 1, justify: 'end' })
          : column([
            row([
              button({ id: 'vellum-conflict-compare', label: 'Compare', tone: 'secondary', onPress: (): AppMessage => ({ kind: 'externalFile', action: 'compare' }) }),
              button({ id: 'vellum-conflict-reload', label: 'Reload Disk', tone: 'destructive', onPress: (): AppMessage => ({ kind: 'externalFile', action: 'reloadDisk' }) }),
              button({ id: 'vellum-conflict-keep', label: 'Keep Buffer', tone: 'secondary', onPress: (): AppMessage => ({ kind: 'externalFile', action: 'keepBuffer' }) })
            ], { gap: 1, justify: 'end' }),
            row([
              button({ id: 'vellum-conflict-save-as', label: 'Save As', tone: 'secondary', onPress: (): AppMessage => ({ kind: 'externalFile', action: 'saveAs' }) }),
              button({ id: VELLUM_IDS.dialogPrimary, label: 'Overwrite Disk', tone: 'destructive', onPress: (): AppMessage => ({ kind: 'externalFile', action: 'overwriteDisk' }) })
            ], { gap: 1, justify: 'end' })
          ], { gap: 1 })
      }
    });
  }
  return undefined;
}

function searchOptionButton(
  id: string,
  label: string,
  selected: boolean,
  option: 'regularExpression' | 'caseSensitive' | 'wholeWord' | 'selectionOnly'
) {
  return button({
    id: `vellum-search-option-${id}`,
    label: `${selected ? '☑' : '☐'} ${label}`,
    tone: selected ? 'primary' : 'secondary',
    onPress: (): AppMessage => ({ kind: 'configureDocumentSearch', option })
  });
}
