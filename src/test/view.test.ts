import assert from 'node:assert/strict';
import test from 'node:test';
import { renderElementSnapshot } from '@ismail-elkorchi/terminal-ui/testing';
import type { TuiContext } from '@ismail-elkorchi/terminal-ui/tui';
import {
  activatePane,
  editDocument,
  initialState,
  openDocument,
  setFileDialogError,
  setMode,
  showHelpDialog,
  showQuitConfirmation,
  startFileDialog,
  type AppState
} from '../editor-state.js';
import { VELLUM_IDS, view } from '../view.js';

const SAMPLE_MARKDOWN = [
  '# Vellum',
  '',
  'A **terminal-first** Markdown editor with *live preview* and [links](https://example.com).',
  '',
  '> A blockquote with enough text to demonstrate wrapping in the rendered document.',
  '',
  '- [x] Structured Markdown blocks',
  '- Nested content',
  '  - Inline `code` and emphasis',
  '',
  '```ts',
  'const answer = 42;',
  '```',
  '',
  '| Feature | State |',
  '| :--- | ---: |',
  '| Unicode | 東京 ✅ |',
  '| Links | [Open](https://example.com) |',
  '',
  '---',
  '',
  '![Architecture](https://example.com/architecture.png)'
].join('\n');

function context(columns: number, rows: number): TuiContext {
  return { terminalSize: { columns, rows } } as TuiContext;
}

function sampleState(mode: 'edit' | 'split' | 'preview', pane: 'editor' | 'preview' = 'editor'): AppState {
  let state = openDocument(initialState(), '/tmp/README.md', 'README.md', SAMPLE_MARKDOWN);
  state = setMode(state, mode);
  return activatePane(state, pane);
}

function render(state: AppState, columns: number, rows: number, focusPath?: readonly string[]) {
  const terminalSize = { columns, rows };
  return renderElementSnapshot({
    element: view(state, context(columns, rows)),
    terminalSize,
    ...(focusPath === undefined ? {} : { focusPath })
  });
}

test('60×18 Split mode shows one useful active pane instead of two cramped panes', () => {
  const result = render(sampleState('split', 'editor'), 60, 18);
  assert.match(result.plainTextFrame, /\[ SOURCE · ACTIVE \]/u);
  assert.doesNotMatch(result.plainTextFrame, /\[ PREVIEW · ACTIVE \]/u);
  assert.match(result.plainTextFrame, /# Vellum/u);
  assert.match(result.plainTextFrame, /\[SPLIT\]/u);
});

test('80×24 Split mode stacks Source above Preview', () => {
  const result = render(sampleState('split', 'editor'), 80, 24);
  const lines = result.plainTextFrame.split('\n');
  const sourceRow = lines.findIndex((line) => line.includes('SOURCE'));
  const previewRow = lines.findIndex((line) => line.includes('PREVIEW') && !line.includes('[SPLIT]'));
  assert.ok(sourceRow >= 0);
  assert.ok(previewRow > sourceRow);
  assert.match(result.plainTextFrame, /terminal-first Markdown editor with live preview/u);
});

test('120×34 Split mode lays Source and Preview out horizontally', () => {
  const result = render(sampleState('split', 'preview'), 120, 34);
  const workspaceTitle = result.plainTextFrame.split('\n').find((line) => line.includes('SOURCE')) ?? '';
  assert.match(workspaceTitle, /SOURCE/u);
  assert.match(workspaceTitle, /PREVIEW/u);
  assert.match(result.plainTextFrame, /const answer = 42;/u);
  assert.match(result.plainTextFrame, /東京/u);
});

test('full Preview uses a centered reading column and never shows source syntax', () => {
  const result = render(sampleState('preview', 'preview'), 160, 40);
  assert.match(result.plainTextFrame, /\[ PREVIEW · ACTIVE \]/u);
  assert.doesNotMatch(result.plainTextFrame, /SOURCE/u);
  assert.doesNotMatch(result.plainTextFrame, /# Vellum/u);
  assert.doesNotMatch(result.plainTextFrame, /```ts/u);
  assert.match(result.plainTextFrame, /IMAGE\s+Architecture/u);

  const headingLine = result.plainTextFrame.split('\n').find((line) => line.includes('Vellum') && !line.includes('VELLUM'));
  assert.ok(headingLine !== undefined);
  assert.ok((headingLine?.indexOf('Vellum') ?? 0) > 20, 'the reading column has horizontal gutters');
});

test('preview focus is valid and agrees with accessibility focus', () => {
  const focusPath = [
    'vellum-root',
    VELLUM_IDS.split,
    'vellum-preview-surface',
    'vellum-preview-viewport',
    VELLUM_IDS.preview
  ] as const;
  const result = render(sampleState('split', 'preview'), 120, 34, focusPath);
  assert.deepEqual(result.frame.focusPath, focusPath);
  assert.deepEqual(result.frame.accessibility.focusPath, focusPath);
});

test('the empty editor and preview have deliberate welcome states', () => {
  const editor = render(initialState(), 80, 24);
  assert.match(editor.plainTextFrame, /Start a Markdown document here\./u);
  assert.match(editor.plainTextFrame, /untitled\.md · UNSAVED/u);

  const preview = render(setMode(initialState(), 'preview'), 80, 24);
  assert.match(preview.plainTextFrame, /Nothing to preview/u);
  assert.match(preview.plainTextFrame, /Write Markdown in the source pane\./u);
  assert.match(preview.plainTextFrame, /Rows 1-/u);
});

test('Open, Save As, confirmation, and Help render as bounded modal dialogs', () => {
  const open = render(startFileDialog(sampleState('edit'), 'open'), 80, 24);
  assert.match(open.plainTextFrame, /Open Markdown file/u);
  assert.match(open.plainTextFrame, /Enter confirms · Esc cancels/u);
  assert.ok(open.frame.focusPath?.includes(VELLUM_IDS.fileInput));

  const saveError = render(
    setFileDialogError(startFileDialog(sampleState('edit'), 'saveAs'), 'Destination is not writable.'),
    80,
    24
  );
  assert.match(saveError.plainTextFrame, /Save Markdown file as/u);
  assert.match(saveError.plainTextFrame, /Destination is not writable\./u);

  let modified = editDocument(sampleState('edit'), {
    kind: 'edit',
    operation: { kind: 'insert', text: 'changed' }
  });
  modified = showQuitConfirmation(modified);
  const confirm = render(modified, 80, 24);
  assert.match(confirm.plainTextFrame, /Unsaved changes/u);
  assert.match(confirm.plainTextFrame, /Keep Editing/u);
  assert.match(confirm.plainTextFrame, /Discard and Quit/u);
  assert.ok(confirm.frame.focusPath?.includes(VELLUM_IDS.confirmCancel));

  const help = render(showHelpDialog(sampleState('edit')), 80, 24);
  assert.match(help.plainTextFrame, /Vellum keyboard shortcuts/u);
  assert.match(help.plainTextFrame, /Ctrl\+P\s+Edit → Split → Preview/u);
  assert.ok(help.frame.focusPath?.includes(VELLUM_IDS.helpClose));
});
