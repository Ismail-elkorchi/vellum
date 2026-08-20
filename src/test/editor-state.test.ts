import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cursorLineColumn,
  editDocument,
  initialState,
  isModified,
  markDocumentSaved,
  movePreview,
  openDocument,
  resizeSplitPane,
  setMode,
  synchronizeEditorToPreviewScroll,
  synchronizePreviewToEditorScroll,
  toggleActivePane
} from '../editor-state.js';

function insert(state: ReturnType<typeof initialState>, text: string) {
  return editDocument(state, {
    kind: 'edit',
    operation: { kind: 'insert', text }
  });
}

test('editing, undo, redo, and cursor metrics preserve controlled document state', () => {
  let state = initialState();
  state = insert(state, 'first\nsecond');
  assert.equal(state.document.text, 'first\nsecond');
  assert.deepEqual(cursorLineColumn(state), { line: 2, column: 7 });
  assert.equal(isModified(state), true);

  state = editDocument(state, { kind: 'undo' });
  assert.equal(state.document.text, '');
  state = editDocument(state, { kind: 'redo' });
  assert.equal(state.document.text, 'first\nsecond');
});

test('a completed save marks only the exact text snapshot that was written', () => {
  let state = openDocument(initialState(), '/tmp/notes.md', 'notes.md', 'before');
  state = editDocument(state, {
    kind: 'edit',
    operation: {
      kind: 'replaceRange',
      range: { startOffset: 0, endOffsetExclusive: state.document.text.length },
      text: 'snapshot sent to disk'
    }
  });
  const savedSnapshot = state.document.text;

  state = insert(state, ' plus a later edit');
  state = markDocumentSaved(state, '/tmp/notes.md', savedSnapshot);
  assert.equal(state.document.savedText, savedSnapshot);
  assert.equal(state.document.text, 'snapshot sent to disk plus a later edit');
  assert.equal(isModified(state), true);

  state = markDocumentSaved(state, '/tmp/notes.md', state.document.text);
  assert.equal(isModified(state), false);
});

test('mode and pane transitions maintain a valid active pane', () => {
  let state = initialState();
  state = setMode(state, 'preview');
  assert.equal(state.activePane, 'preview');
  state = setMode(state, 'edit');
  assert.equal(state.activePane, 'editor');
  state = setMode(state, 'split');
  state = toggleActivePane(state);
  assert.equal(state.activePane, 'preview');
});

test('preview navigation supports line, page, top, and bottom commands', () => {
  let state = initialState();
  state = movePreview(state, 'lineDown', { contentRows: 30, pageRows: 7 });
  assert.equal(state.previewScroll.offsetRow, 1);
  state = movePreview(state, 'pageDown', { contentRows: 30, pageRows: 7 });
  assert.equal(state.previewScroll.offsetRow, 8);
  state = movePreview(state, 'pageUp', { contentRows: 30, pageRows: 3 });
  assert.equal(state.previewScroll.offsetRow, 5);
  state = movePreview(state, 'top', { contentRows: 30, pageRows: 7 });
  assert.equal(state.previewScroll.offsetRow, 0);
  state = movePreview(state, 'bottom', { contentRows: 30, pageRows: 7 });
  assert.equal(state.previewScroll.offsetRow, 23);
  assert.equal(state.previewScroll.followTail, true);
  state = movePreview(state, 'lineUp', { contentRows: 30, pageRows: 7 });
  assert.equal(state.previewScroll.offsetRow, 22);
  assert.equal(state.previewScroll.followTail, false);
  assert.equal(state.activePane, 'preview');
});

test('split resizing obeys the 25/75 percent pane constraints', () => {
  let state = initialState();
  state = resizeSplitPane(state, { kind: 'resizeBy', deltaShare: 1 });
  assert.equal(state.splitPane.shares[0], 0.75);
  assert.equal(state.splitPane.shares[1], 0.25);
  state = resizeSplitPane(state, { kind: 'resizeBy', deltaShare: -1 });
  assert.equal(state.splitPane.shares[0], 0.25);
  assert.equal(state.splitPane.shares[1], 0.75);
});

test('visible Split panes synchronize proportional scroll positions in both directions', () => {
  const geometry = {
    editor: { contentRows: 100, pageRows: 20 },
    preview: { contentRows: 60, pageRows: 10 }
  };
  let state = setMode(initialState(), 'split');
  state = editDocument(state, {
    kind: 'scroll',
    event: {
      source: 'wheel',
      target: 'content',
      nextState: { offsetRow: 40, offsetColumn: 0, followTail: false }
    }
  });
  state = synchronizePreviewToEditorScroll(state, geometry);
  assert.equal(state.previewScroll.offsetRow, 25);

  state = movePreview(state, 'bottom', geometry.preview);
  state = synchronizeEditorToPreviewScroll(state, geometry);
  assert.equal(state.document.scroll.offsetRow, 80);
});

test('opening a document resets workspace mode, focus intent, history, and scrolling', () => {
  let state = movePreview(
    setMode(initialState(), 'preview'),
    'bottom',
    { contentRows: 30, pageRows: 7 }
  );
  state = openDocument(state, '/tmp/new.md', 'new.md', '# New');
  assert.equal(state.mode, 'edit');
  assert.equal(state.activePane, 'editor');
  assert.equal(state.document.path, '/tmp/new.md');
  assert.equal(state.document.label, 'new.md');
  assert.equal(state.document.text, '# New');
  assert.equal(state.document.savedText, '# New');
  assert.equal(state.previewScroll.offsetRow, 0);
});
