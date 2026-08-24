import {
  initialState,
  openDocument,
  type AppState
} from '../editor-state.js';
import { createMarkdownPreviewEngine } from '../markdown/preview.js';

export function initialTestState(): AppState {
  const engine = createMarkdownPreviewEngine();
  return initialState(engine.open(0, 0, ''));
}

export function openTestDocument(
  state: AppState,
  filePath: string,
  label: string,
  source: string
): AppState {
  const engine = createMarkdownPreviewEngine();
  const documentId = state.document.id + 1;
  return openDocument(
    state,
    filePath,
    label,
    source,
    engine.open(documentId, 0, source)
  );
}
