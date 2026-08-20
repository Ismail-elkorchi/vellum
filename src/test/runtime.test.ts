import assert from 'node:assert/strict';
import test from 'node:test';
import type { KeyEvent, KeyName } from '@ismail-elkorchi/terminal-ui/input';
import { createTerminalHarness } from '@ismail-elkorchi/terminal-ui/testing';
import { runTui } from '@ismail-elkorchi/terminal-ui/tui';
import { vellumApp } from '../main.js';
import { VELLUM_IDS } from '../view.js';

function key(
  name: KeyName,
  modifiers: Partial<KeyEvent['modifiers']> = {}
): KeyEvent {
  return {
    kind: 'key',
    key: name,
    modifiers: {
      ctrl: false,
      alt: false,
      shift: false,
      meta: false,
      ...modifiers
    },
    eventType: 'press',
    location: 'standard'
  };
}

async function waitForFrames(
  count: number,
  frames: () => readonly unknown[]
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (frames().length >= count) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail(`Expected at least ${String(count)} rendered frames, received ${String(frames().length)}.`);
}

test('the public runtime handles editing, modal focus, mode changes, preview keys, and restoration', async () => {
  const harness = createTerminalHarness({ terminalSize: { columns: 80, rows: 24 } });
  const running = harness.run((host) => runTui(vellumApp, host, {
    initialFocus: { kind: 'element', elementId: VELLUM_IDS.editor }
  }));

  await waitForFrames(1, harness.frames);
  assert.deepEqual(harness.snapshot().focusPath?.at(-1), VELLUM_IDS.editor);

  let expectedFrames = harness.frames().length + 1;
  await harness.input(key('f1'));
  await waitForFrames(expectedFrames, harness.frames);
  assert.equal(harness.snapshot().focusPath?.at(-1), VELLUM_IDS.helpClose);

  expectedFrames = harness.frames().length + 1;
  await harness.input(key('escape'));
  await new Promise<void>((resolve) => setImmediate(resolve));
  harness.clock.advance(100);
  await waitForFrames(expectedFrames, harness.frames);
  assert.equal(harness.snapshot().focusPath?.at(-1), VELLUM_IDS.editor);

  const longDocument = [
    '# Runtime preview',
    '',
    ...Array.from(
      { length: 10 },
      (_, index) => `Paragraph ${String(index + 1)} with **bold** text and [a link](https://example.com/${String(index + 1)}).\n`
    )
  ].join('\n');
  expectedFrames = harness.frames().length + 1;
  await harness.input({ kind: 'paste', text: longDocument, bracketed: true });
  await waitForFrames(expectedFrames, harness.frames);

  expectedFrames = harness.frames().length + 1;
  await harness.input(key('p', { ctrl: true }));
  await waitForFrames(expectedFrames, harness.frames);
  expectedFrames = harness.frames().length + 1;
  await harness.input(key('p', { ctrl: true }));
  await waitForFrames(expectedFrames, harness.frames);
  assert.equal(harness.snapshot().focusPath?.at(-1), VELLUM_IDS.preview);

  expectedFrames = harness.frames().length + 1;
  await harness.input(key('pageDown'));
  await waitForFrames(expectedFrames, harness.frames);
  assert.equal(harness.snapshot().focusPath?.at(-1), VELLUM_IDS.preview);

  await harness.input({ kind: 'end' });
  const exit = await running;
  assert.equal(exit.status, 'completed');
  assert.ok('state' in exit);
  if (!('state' in exit)) return;
  assert.equal(exit.state.mode, 'preview');
  assert.ok(exit.state.previewScroll.offsetRow > 0);
  assert.equal(harness.restores().length, 1);
  assert.ok(exit.diagnostics.every((diagnostic) => diagnostic.diagnostic.severity !== 'error' && diagnostic.diagnostic.severity !== 'fatal'));
});
