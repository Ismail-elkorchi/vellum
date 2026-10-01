import type { TerminalSize } from '@ismail-elkorchi/terminal-ui/host';
import type { AppState } from './types.js';

export interface VellumBodyGeometry {
  readonly fileTreeWidth: number;
  readonly bodyWidth: number;
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
  const navigatorUnavailable = state.navigator.mode === 'files' && state.project.rootDirectory === undefined;
  const fileTreeWidth = !state.navigator.visible || state.writingMode.distractionFree || navigatorUnavailable || columns < 72
    ? 0
    : Math.min(state.navigator.width, Math.max(16, Math.floor(columns * 0.25)));
  const bodyWidth = Math.max(1, columns - fileTreeWidth - (fileTreeWidth > 0 ? 1 : 0));
  return Object.freeze({
    fileTreeWidth,
    bodyWidth
  });
}
