import assert from 'node:assert/strict';
import test from 'node:test';
import { defineTextWidthProfile, defaultTextWidthProfile } from '@ismail-elkorchi/terminal-ui/text';
import { createVellumApplication, type VellumApplication } from '../app/application.js';
import type { MarkdownPreviewAllocation } from '../markdown/render/component.js';
import type { CodeHighlightLanguage } from '../markdown/highlight.js';
import type { TuiEffectContext } from '@ismail-elkorchi/terminal-ui/tui';

function allocation(width: number, widthProfile = defaultTextWidthProfile): MarkdownPreviewAllocation {
  return { layoutRevision: `accepted-${String(width)}`, width, rows: 12, widthProfile };
}
function prepare(application: VellumApplication, bufferId: string, input: MarkdownPreviewAllocation) {
  const buffer = application.state().project.buffers[bufferId];
  assert.ok(buffer);
  const operation = application.acceptPreviewAllocation(bufferId, buffer.editor.document, buffer.previewResourceRevision, input);
  assert.ok(operation);
  return operation;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test('accepted preview allocation schedules required async work and only the latest width publishes', async () => {
  const application = createVellumApplication({ watchFiles: false });
  try {
    const id = application.openSource('```\n' + 'line of source\n'.repeat(8_000) + '```');
    await application.refreshPreviewResources(id);
    const publications: number[] = [];
    application.subscribe((update) => {
      if (update.reason === 'previewLayout') {
        const presentation = application.previewPresentation(id);
        if (presentation.kind === 'ready') publications.push(presentation.width);
      }
    });
    const buffer = application.state().project.buffers[id];
    assert.ok(buffer);
    const update = application.update({ kind: 'previewAllocation', bufferId: id, document: buffer.editor.document,
      resourceRevision: buffer.previewResourceRevision, allocation: allocation(80) });
    assert.equal(update.effects?.length, 1);
    assert.equal(update.effects?.[0]?.concurrency, 'replace');
    assert.equal(application.previewPresentation(id).kind, 'pending');
    const oldRun = prepare(application, id, allocation(70)).run(new AbortController().signal);
    await Promise.all([oldRun, prepare(application, id, allocation(34)).run(new AbortController().signal)]);
    const presentation = application.previewPresentation(id);
    assert.equal(presentation.kind, 'ready');
    if (presentation.kind !== 'ready') return;
    assert.equal(presentation.width, 34);
    assert.equal(presentation.layout.width, 32);
    assert.deepEqual(publications, [34]);
  } finally { await application.dispose(); }
});

test('source and width-profile changes cancel preparation before stale layouts become visible', async () => {
  const application = createVellumApplication({ watchFiles: false });
  try {
    const id = application.openSource('Original content');
    await application.refreshPreviewResources(id);
    const oldBuffer = application.state().project.buffers[id];
    assert.ok(oldBuffer);
    const oldRun = prepare(application, id, allocation(60)).run(new AbortController().signal);
    application.applyTextAreaTransition(id, { kind: 'edit', operation: { kind: 'insert', text: 'New content ' } });
    await oldRun;
    assert.equal(application.previewPresentation(id).kind, 'pending');
    assert.equal(application.acceptPreviewAllocation(id, oldBuffer.editor.document, oldBuffer.previewResourceRevision, allocation(60)), undefined);
    await application.refreshPreviewResources(id);
    const intermediateRun = prepare(application, id, allocation(60)).run(new AbortController().signal);
    const wide = defineTextWidthProfile({ ambiguous: 'wide', emoji: 'wide' });
    application.updateTextWidthProfile(wide);
    await intermediateRun;
    assert.equal(application.previewPresentation(id).kind, 'pending');
    await prepare(application, id, allocation(60, wide)).run(new AbortController().signal);
    const current = application.previewPresentation(id);
    assert.equal(current.kind, 'ready');
    if (current.kind !== 'ready') return;
    assert.equal(current.layout.widthProfile, wide);
    assert.match(current.layout.rows.flatMap((row) => row.inlineSpans).map((span) => span.text).join(''), /New content Original content/u);
  } finally { await application.dispose(); }
});

test('resource completion invalidates in-flight preparation and the next allocation uses new resources', async () => {
  const gate = deferred();
  const started = deferred();
  const language: CodeHighlightLanguage = {
    id: 'controlled', aliases: [], async load() { return { async tokenize(source, context) {
      started.resolve(); await gate.promise; context.signal.throwIfAborted();
      return [{ span: { start: 0, end: source.length }, style: { underline: true } }];
    } }; },
  };
  const application = createVellumApplication({ watchFiles: false, highlightLanguages: [language] });
  try {
    const id = application.openSource('```controlled\nvalue\n```');
    await started.promise;
    const oldRun = prepare(application, id, allocation(50)).run(new AbortController().signal);
    gate.resolve(); await application.refreshPreviewResources(id); await oldRun;
    assert.equal(application.previewPresentation(id).kind, 'pending');
    await prepare(application, id, allocation(50)).run(new AbortController().signal);
    const current = application.previewPresentation(id);
    assert.equal(current.kind, 'ready');
    if (current.kind !== 'ready') return;
    assert.ok(current.layout.rows.some((row) => row.inlineSpans.some((span) => span.style?.underline === true)));
  } finally { gate.resolve(); await application.dispose(); }
});

test('close and application disposal cancel pending preview publication', async () => {
  for (const action of ['close', 'dispose'] as const) {
    const application = createVellumApplication({ watchFiles: false });
    try {
      const id = application.openSource('A preview that must never publish');
      await application.refreshPreviewResources(id);
      let published = 0;
      application.subscribe((update) => { if (update.reason === 'previewLayout') published += 1; });
      const run = prepare(application, id, allocation(50)).run(new AbortController().signal);
      if (action === 'close') {
        if (!application.requestCloseBuffer(id)) await application.resolveDirtyBuffer('discard');
      } else await application.dispose();
      await run;
      assert.equal(published, 0);
      assert.equal(application.previewPresentation(id).kind, 'pending');
    } finally { await application.dispose(); }
  }
});
test('cancelled runtime effects can retry the same accepted allocation', async () => {
  const application = createVellumApplication({ watchFiles: false });
  try {
    const id = application.openSource('A reusable application');
    await application.refreshPreviewResources(id);
    const controller = new AbortController();
    const cancelled = prepare(application, id, allocation(50)).run(controller.signal);
    controller.abort();
    await cancelled;
    assert.equal(application.previewPresentation(id).kind, 'pending');
    await prepare(application, id, allocation(50)).run(new AbortController().signal);
    assert.equal(application.previewPresentation(id).kind, 'ready');
  } finally { await application.dispose(); }
});

test('tiny terminal preview allocations remain empty until a usable viewport is accepted', async () => {
  const { createMemoryTerminalHost } = await import('@ismail-elkorchi/terminal-ui/host');
  const { observedVellum } = await import('./pane-layouts.js');
  const application = createVellumApplication({ watchFiles: false });
  const id = application.openSource('A visible [target](./target.md)');
  application.dispatchCommand('view.preview');
  const allocations: MarkdownPreviewAllocation[] = [];
  const observed = observedVellum({ ...application, update(message) {
    if (message.kind === 'previewAllocation') allocations.push(message.allocation);
    return application.update(message);
  } }, createMemoryTerminalHost({ terminalSize: { columns: 1, rows: 1 } }));
  try {
    await observed.runtime.start();
    assert.equal(application.previewPresentation(id).kind, 'pending');
    assert.equal(observed.runtime.frame()?.hitTargets?.some((target) => target.id === `preview-content-${id}:content`) ?? false, false);
    assert.equal(observed.runtime.diagnostics().length, 0);
    assert.ok(allocations.length === 0 || allocations.every((value) => value.width === 0 || value.rows === 0));
    await observed.runtime.resize({ columns: 50, rows: 15 });
    await observed.settle();
    assert.equal(application.previewPresentation(id).kind, 'ready');
    assert.ok(observed.preview().width > 0 && observed.preview().rows > 0);
    assert.ok(observed.runtime.frame()?.hitTargets?.some((target) => target.id === `preview-content-${id}:content`));
    assert.equal(observed.runtime.diagnostics().length, 0);
  } finally { await observed.runtime.dispose(); await application.dispose(); }
});

test('terminal presentation preparation is cancellable and reuses accepted semantic geometry', async () => {
  const { parseMarkdown } = await import('markspan');
  const { prepareMarkdownPreview, createPreviewLayoutCache } = await import('../markdown/render/layout.js');
  const { prepareMarkdownPreviewPresentation, markdownPreview } = await import('../markdown/render/component.js');
  const { darkTerminalMarkdownTheme } = await import('../markdown/theme.js');
  const { renderElementSnapshot } = await import('@ismail-elkorchi/terminal-ui/testing');
  const { setImmediate } = await import('node:timers/promises');
  const tree = parseMarkdown('[target](./target.md)\n\n'.repeat(3_000)).tree;
  const layout = await prepareMarkdownPreview(tree, 48, darkTerminalMarkdownTheme, defaultTextWidthProfile, createPreviewLayoutCache());
  const controller = new AbortController();
  let turns = 0;
  await assert.rejects(prepareMarkdownPreviewPresentation(layout, 50, 1, 'prepared-targets', {
    signal: controller.signal, async yieldControl() {
      if (++turns === 3) controller.abort();
      await setImmediate();
    },
  }), { name: 'AbortError' });
  const presentation = await prepareMarkdownPreviewPresentation(layout, 50, 1, 'prepared-targets');
  const focus = presentation.focusTargets[0]?.id;
  assert.ok(focus);
  assert.equal(presentation.accessibility(), presentation.accessibility());
  assert.equal(presentation.accessibility(focus), presentation.accessibility(focus));
  const snapshot = renderElementSnapshot({
    element: markdownPreview({ id: 'prepared-targets', label: 'Prepared targets', version: 'one', presentation, onAction: (action) => action }),
    terminalSize: { columns: 50, rows: 8 },
  });
  assert.ok((snapshot.frame.hitTargets?.length ?? 0) <= 9);
  assert.equal(presentation.focusTargets.length, 3_000);
});


test('pending preview retains focus ownership and ready links remain keyboard-activatable without stealing navigation', async () => {
  const { createMemoryTerminalHost } = await import('@ismail-elkorchi/terminal-ui/host');
  const { keyInput } = await import('@ismail-elkorchi/terminal-ui/testing');
  const { observedVellum } = await import('./pane-layouts.js');
  for (const leavePreview of [false, true]) {
    const activated = deferred();
    const opened: string[] = [];
    const application = createVellumApplication({ watchFiles: false, async openExternalLink(url) {
      opened.push(url.href);
      activated.resolve();
    } });
    const id = application.openSource('[First link](https://example.test/first)\n\n' + 'Scrollable paragraph.\n\n'.repeat(80));
    application.dispatchCommand('view.preview');
    const gate = deferred();
    const controlled: VellumApplication = { ...application, update(message) {
      const result = application.update(message);
      return message.kind !== 'previewAllocation' || result.effects === undefined ? result : {
        ...result, effects: result.effects.map((effect) => ({ ...effect, async run(context: TuiEffectContext) {
          await gate.promise;
          return effect.run(context);
        } })),
      };
    } };
    const observed = observedVellum(controlled, createMemoryTerminalHost({ terminalSize: { columns: 60, rows: 20 } }));
    try {
      await observed.runtime.start();
      assert.equal(application.previewPresentation(id).kind, 'pending');
      const pendingFocus = observed.runtime.frame()?.accessibility.focusPath;
      assert.ok(pendingFocus?.includes(`preview-content-${id}`));
      if (leavePreview) {
        await observed.runtime.handleInput(keyInput('tab'));
        const userFocus = observed.runtime.frame()?.accessibility.focusPath;
        assert.ok(!userFocus?.includes(`preview-content-${id}`));
        gate.resolve();
        await observed.settle();
        assert.deepEqual(observed.runtime.frame()?.accessibility.focusPath, userFocus);
      } else {
        gate.resolve();
        await observed.settle();
        const readyFocus = observed.runtime.frame()?.accessibility.focusPath;
        assert.ok(readyFocus?.includes(`preview-content-${id}`));
        assert.match(readyFocus?.at(-1) ?? '', /:markdown-\d+$/u);
        await observed.runtime.handleInput(keyInput('enter'));
        let timer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([activated.promise, new Promise<void>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('Enter did not activate the focused preview link.')), 1_000);
          })]);
        } finally { if (timer !== undefined) clearTimeout(timer); }
        assert.deepEqual(opened, ['https://example.test/first']);
        await observed.runtime.handleInput(keyInput('pageDown'));
        assert.ok((application.state().project.buffers[id]?.previewScroll.offsetRow ?? 0) > 0);
        await observed.runtime.handleInput(keyInput('tab'));
        assert.ok(!observed.runtime.frame()?.accessibility.focusPath.includes(`preview-content-${id}`));
      }
    } finally { gate.resolve(); await observed.runtime.dispose(); await application.dispose(); }
  }
});
