import assert from 'node:assert/strict';
import test from 'node:test';
import { commandInputPresentation } from '@ismail-elkorchi/terminal-ui/behavior';
import {
  editDocument,
  editFileDialog,
  initialState,
  isModified,
  openDocument,
  startFileDialog
} from '../editor-state.js';
import { updateVellum } from '../main.js';
import { VELLUM_IDS } from '../view.js';

const editorFocus = { kind: 'element', elementId: VELLUM_IDS.editor } as const;
const previewFocus = { kind: 'element', elementId: VELLUM_IDS.preview } as const;
const fileInputFocus = { kind: 'element', elementId: VELLUM_IDS.fileInput } as const;
const confirmFocus = { kind: 'element', elementId: VELLUM_IDS.confirmCancel } as const;

function modifiedState() {
  return editDocument(initialState(), {
    kind: 'edit',
    operation: { kind: 'insert', text: 'changed' }
  });
}

test('mode cycling assigns focus to an element present in the destination mode', () => {
  let result = updateVellum(initialState(), { kind: 'toggleMode' });
  assert.equal(result.state.mode, 'split');
  assert.deepEqual(result.focus, editorFocus);

  result = updateVellum(result.state, { kind: 'toggleMode' });
  assert.equal(result.state.mode, 'preview');
  assert.equal(result.state.activePane, 'preview');
  assert.deepEqual(result.focus, previewFocus);

  result = updateVellum(result.state, { kind: 'toggleMode' });
  assert.equal(result.state.mode, 'edit');
  assert.deepEqual(result.focus, editorFocus);
});

test('Tab-style pane switching changes both active pane and focus selector', () => {
  const split = updateVellum(initialState(), { kind: 'toggleMode' }).state;
  const preview = updateVellum(split, { kind: 'togglePane' });
  assert.equal(preview.state.activePane, 'preview');
  assert.deepEqual(preview.focus, previewFocus);

  const editor = updateVellum(preview.state, { kind: 'togglePane' });
  assert.equal(editor.state.activePane, 'editor');
  assert.deepEqual(editor.focus, editorFocus);
});

test('empty file submissions remain in the dialog and expose validation', () => {
  let state = startFileDialog(initialState(), 'open');
  const result = updateVellum(state, { kind: 'submitFileDialog', value: '   ' });
  assert.equal(result.state.dialog?.kind, 'file');
  assert.equal(result.state.dialog?.kind === 'file' ? result.state.dialog.error : undefined, 'Enter a file path.');
  assert.deepEqual(result.focus, fileInputFocus);

  state = startFileDialog(initialState(), 'saveAs');
  const saveResult = updateVellum(state, { kind: 'submitFileDialog', value: '' });
  assert.equal(saveResult.state.dialog?.kind === 'file' ? saveResult.state.dialog.error : undefined, 'Enter a destination path.');
});

test('opening over modified content requires discard confirmation and Escape returns to the file dialog', () => {
  let state = startFileDialog(modifiedState(), 'open');
  state = editFileDialog(state, { kind: 'setValue', value: './next.md' });

  const confirm = updateVellum(state, { kind: 'submitFileDialog' });
  assert.equal(confirm.state.dialog?.kind, 'confirm');
  assert.equal(confirm.state.dialog?.kind === 'confirm' ? confirm.state.dialog.operation : undefined, 'open');
  assert.deepEqual(confirm.focus, confirmFocus);

  const returned = updateVellum(confirm.state, { kind: 'dismissDialog' });
  assert.equal(returned.state.dialog?.kind, 'file');
  assert.equal(returned.state.dialog?.kind === 'file' ? commandInputPresentation(returned.state.dialog.command).value : undefined, './next.md');
  assert.deepEqual(returned.focus, fileInputFocus);
});

test('quit requires confirmation only when unsaved changes exist', () => {
  const clean = updateVellum(initialState(), { kind: 'quit' });
  assert.deepEqual(clean.exit, { reason: 'quit' });

  const modified = updateVellum(modifiedState(), { kind: 'quit' });
  assert.equal(modified.state.dialog?.kind, 'confirm');
  assert.deepEqual(modified.focus, confirmFocus);

  const discarded = updateVellum(modified.state, { kind: 'confirmDiscard' });
  assert.deepEqual(discarded.exit, { reason: 'quit' });
});

test('save completion keeps later edits modified', () => {
  let state = openDocument(initialState(), '/tmp/note.md', 'note.md', 'old');
  state = editDocument(state, {
    kind: 'edit',
    operation: {
      kind: 'replaceRange',
      range: { startOffset: 0, endOffsetExclusive: 3 },
      text: 'written'
    }
  });
  const snapshot = state.document.text;
  state = editDocument(state, { kind: 'edit', operation: { kind: 'insert', text: ' later' } });

  const result = updateVellum(state, {
    kind: 'fileSaved',
    path: '/tmp/note.md',
    savedText: snapshot,
    documentId: state.document.id
  });
  assert.equal(result.state.document.savedText, 'written');
  assert.equal(result.state.document.text, 'written later');
  assert.equal(isModified(result.state), true);
});

test('save without a path opens Save As and file errors restore the appropriate modal', () => {
  const save = updateVellum(modifiedState(), { kind: 'save' });
  assert.equal(save.state.dialog?.kind, 'file');
  assert.equal(save.state.dialog?.kind === 'file' ? save.state.dialog.operation : undefined, 'saveAs');
  assert.deepEqual(save.focus, fileInputFocus);

  const failed = updateVellum(save.state, {
    kind: 'fileError',
    operation: 'saveAs',
    rawPath: './blocked.md',
    message: 'Permission denied',
    documentId: save.state.document.id,
    revision: save.state.document.revision
  });
  assert.equal(failed.state.dialog?.kind, 'file');
  assert.equal(failed.state.dialog?.kind === 'file' ? failed.state.dialog.error : undefined, 'Permission denied');
  assert.deepEqual(failed.focus, fileInputFocus);
});

test('stale file completions cannot replace or retag the active document', () => {
  const first = openDocument(initialState(), '/tmp/first.md', 'first.md', 'first');
  const second = openDocument(first, '/tmp/second.md', 'second.md', 'second');
  const staleSave = updateVellum(second, {
    kind: 'fileSaved',
    path: '/tmp/first.md',
    savedText: 'first',
    documentId: first.document.id
  });
  assert.equal(staleSave.state.document.path, '/tmp/second.md');
  assert.equal(staleSave.state.document.text, 'second');

  const edited = editDocument(initialState(), {
    kind: 'edit',
    operation: { kind: 'insert', text: 'keep this edit' }
  });
  const staleOpen = updateVellum(edited, {
    kind: 'fileOpened',
    file: { path: '/tmp/other.md', label: 'other.md', text: 'other' },
    documentId: edited.document.id,
    revision: edited.document.revision - 1
  });
  assert.equal(staleOpen.state.document.text, 'keep this edit');
  assert.match(staleOpen.state.notice?.text ?? '', /ignored/u);
});
