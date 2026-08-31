import type { TerminalSize } from '@ismail-elkorchi/terminal-ui/host';
import type { AppState } from './types.js';

export interface VellumBodyGeometry {
  readonly fileTreeWidth: number;
  readonly bodyWidth: number;
  readonly bodyRows: number;
  readonly contentRows: number;
}

export interface VellumPaneSize {
  readonly width: number;
  readonly rows: number;
}

export interface VellumPaneGeometry {
  readonly direction: 'horizontal' | 'vertical';
  readonly editor?: VellumPaneSize;
  readonly preview?: VellumPaneSize;
}

export interface VellumPreviewDocumentGeometry {
  readonly contentWidth: number;
  readonly contentColumn: number;
}

const maximumPreviewContentWidth = 88;

/** Centers a readable preview column while retaining a gutter in constrained panes. */
export function vellumPreviewDocumentGeometry(paneWidth: number): VellumPreviewDocumentGeometry {
  const available = Math.max(1, Math.floor(paneWidth));
  const frameWidth = Math.min(available, maximumPreviewContentWidth + 2);
  const contentWidth = Math.max(1, frameWidth - 2);
  const remaining = frameWidth - contentWidth;
  const left = Math.min(1, remaining);
  const contentColumn = Math.floor((available - frameWidth) / 2) + left;
  return Object.freeze({
    contentWidth,
    contentColumn,
  });
}

export function vellumBodyGeometry(state: AppState, terminalSize: TerminalSize): VellumBodyGeometry {
  const columns = Math.max(1, terminalSize.columns);
  const rows = Math.max(1, terminalSize.rows);
  const navigatorUnavailable = state.navigator.mode === 'files' && state.project.rootDirectory === undefined;
  const fileTreeWidth = !state.navigator.visible || state.writingMode.distractionFree || navigatorUnavailable || columns < 72
    ? 0
    : Math.min(state.navigator.width, Math.max(16, Math.floor(columns * 0.25)));
  const bodyWidth = Math.max(1, columns - fileTreeWidth - (fileTreeWidth > 0 ? 1 : 0));
  const bodyRows = Math.max(1, rows - 2);
  return Object.freeze({
    fileTreeWidth,
    bodyWidth,
    bodyRows,
    contentRows: Math.max(1, bodyRows - 1)
  });
}

export function vellumPaneGeometry(state: AppState, width: number, rows: number): VellumPaneGeometry {
  const boundedWidth = Math.max(1, width);
  const boundedRows = Math.max(1, rows);
  if (state.paneArrangement === 'editor') {
    return Object.freeze({
      direction: 'horizontal',
      editor: Object.freeze({ width: boundedWidth, rows: boundedRows })
    });
  }
  if (state.paneArrangement === 'preview') {
    return Object.freeze({
      direction: 'horizontal',
      preview: Object.freeze({ width: boundedWidth, rows: boundedRows })
    });
  }
  const horizontal = boundedWidth >= 96;
  const editorWidth = horizontal
    ? Math.max(1, Math.floor((boundedWidth - 1) * (state.splitPane.shares[0] ?? 0.5)))
    : boundedWidth;
  const editorRows = horizontal
    ? boundedRows
    : Math.max(1, Math.floor((boundedRows - 1) * (state.splitPane.shares[0] ?? 0.5)));
  return Object.freeze({
    direction: horizontal ? 'horizontal' : 'vertical',
    editor: Object.freeze({ width: editorWidth, rows: editorRows }),
    preview: Object.freeze({
      width: horizontal ? Math.max(1, boundedWidth - editorWidth - 1) : boundedWidth,
      rows: horizontal ? boundedRows : Math.max(1, boundedRows - editorRows - 1)
    })
  });
}
