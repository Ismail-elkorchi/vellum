import assert from 'node:assert/strict';
import test from 'node:test';
import { textDocumentText } from '@ismail-elkorchi/terminal-ui/text';
import { runTui } from '@ismail-elkorchi/terminal-ui/tui';
import {
  createPtyTerminalHarness,
  keyInput,
  pasteInput
} from '@ismail-elkorchi/terminal-ui/testing';
import { createVellumApplication } from '../app/application.js';
import { createVellumTui } from '../tui.js';

test('a legacy PTY preserves Unicode editing, mouse scrolling, resizing, focus checks, and terminal restoration', async (context) => {
  const result = createPtyTerminalHarness({
    id: 'vellum-pty-workflow',
    terminalSize: { columns: 100, rows: 24 }
  });
  if (result.status === 'unavailable') {
    context.skip(result.diagnostic.message);
    return;
  }
  const { harness } = result;
  const application = createVellumApplication({ watchFiles: false, createBufferId: () => 'pty-buffer' });
  const bufferId = application.newBuffer();
  const lines = Array.from({ length: 80 }, (_, index) => (
    `${String(index).padStart(2, '0')} العربية עברית français e\u0301 日本語 👨‍👩‍👧‍👦`
  ));
  const source = lines.join('\n');
  const running = runTui(createVellumTui(application), {
    host: harness.host,
    initialFocus: { kind: 'element', elementId: `vellum-editor-${bufferId}` }
  });
  try {
    await waitUntil(() => harness.frames().at(-1)?.hitTargets?.some((target) => target.id === `vellum-editor-${bufferId}:text`) === true);
    await harness.input(pasteInput(source, true));
    await waitUntil(() => textDocumentText(application.state().project.buffers[bufferId]?.editor.document as never) === source);
    assert.equal(textDocumentText(application.state().project.buffers[bufferId]?.editor.document as never), source);

    await harness.input(keyInput('f8'));
    await waitUntil(() => application.state().paneArrangement === 'editorPreview');
    const splitFrame = harness.frames().at(-1);
    const previewTarget = splitFrame?.hitTargets?.find((target) => (
      target.id.startsWith(`vellum-preview-${bufferId}:`) && target.accepts?.includes('scroll') === true
    ));
    assert.ok(previewTarget);
    const previewRow = previewTarget.bounds.row + Math.min(2, previewTarget.bounds.height - 1);
    const previewColumn = previewTarget.bounds.column + Math.min(2, previewTarget.bounds.width - 1);
    await harness.input(sgrMouse(65, previewRow, previewColumn, 'M'));
    await waitUntil(() => (application.state().project.buffers[bufferId]?.previewScroll.offsetRow ?? 0) > 0);
    assert.ok((application.state().project.buffers[bufferId]?.editor.scroll.offsetRow ?? 0) > 0);

    const editorFrame = harness.frames().at(-1);
    const editorTarget = editorFrame?.hitTargets?.find((target) => target.id === `vellum-editor-${bufferId}:text`);
    assert.ok(editorTarget);
    const pointer = {
      row: editorTarget.bounds.row + Math.min(1, editorTarget.bounds.height - 1),
      column: editorTarget.bounds.column + Math.min(6, editorTarget.bounds.width - 1)
    };
    await harness.input(sgrMouse(0, pointer.row, pointer.column, 'M'));
    await harness.input(sgrMouse(0, pointer.row, pointer.column, 'm'));
    const scrollBeforeCaretMovement = application.state().project.buffers[bufferId]?.editor.scroll.offsetRow ?? 0;
    for (let index = 0; index < 30; index += 1) await harness.input(keyInput('arrowDown'));
    await waitUntil(() => (application.state().project.buffers[bufferId]?.editor.scroll.offsetRow ?? 0) > scrollBeforeCaretMovement);
    assert.ok((application.state().project.buffers[bufferId]?.previewScroll.offsetRow ?? 0) > 0);

    await harness.resize({ columns: 120, rows: 30 });
    await waitUntil(() => harness.frames().at(-1)?.width === 120 && harness.frames().at(-1)?.height === 30);
    await harness.input({ kind: 'focus', focused: true });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  } finally {
    harness.closeInput();
    const exit = await withTimeout(running, 3_000);
    assert.notEqual(exit.status, 'error');
    assert.ok(harness.restores().some((restore) => restore.status === 'restored'));
    await application.dispose();
    await harness.dispose();
  }
});

async function waitUntil(predicate: () => boolean, timeoutMilliseconds = 3_000): Promise<void> {
  const started = performance.now();
  while (!predicate()) {
    if (performance.now() - started > timeoutMilliseconds) throw new Error('Timed out waiting for the PTY workflow.');
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

function sgrMouse(code: number, row: number, column: number, terminator: 'M' | 'm'): string {
  return `\u001b[<${String(code)};${String(column + 1)};${String(row + 1)}${terminator}`;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMilliseconds: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Timed out waiting for PTY shutdown.')), timeoutMilliseconds);
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
