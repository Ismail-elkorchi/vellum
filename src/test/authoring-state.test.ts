import { observedVellum } from './pane-layouts.js';
import { createTextAreaRowOffsetMap } from '@ismail-elkorchi/terminal-ui/components';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createMemoryTerminalHost } from '@ismail-elkorchi/terminal-ui/host';
import { createTuiRuntime } from '@ismail-elkorchi/terminal-ui/tui';
import { textDocumentText } from '@ismail-elkorchi/terminal-ui/text';
import { createVellumApplication, type VellumApplicationUpdate } from '../app/application.js';
import { createVellumTui } from '../tui.js';
import { createFileTreeState, reduceFileTree, terminalFileTreeSource } from '../project/file-tree.js';

test('headless and terminal edits publish the same snapshots; queued old snapshots cannot roll back edits', async () => {
  const application = createVellumApplication({ watchFiles: false });
  const updates: VellumApplicationUpdate[] = [];
  const unsubscribe = application.subscribe((update) => {
    assert.equal(update.state, application.state());
    assert.equal(update.revision, update.state.revision);
    updates.push(update);
  });
  const id = application.openSource('first');
  const stale = application.snapshot();
  const runtime = createTuiRuntime({ app: createVellumTui(application), host: createMemoryTerminalHost() });
  try {
    await runtime.start();
    await runtime.dispatch({ kind: 'editor', bufferId: id, transition: { kind: 'edit', operation: { kind: 'insert', text: 'new ' } } });
    const latest = application.state();
    await runtime.dispatch({ kind: 'applicationUpdate', update: stale });
    assert.equal(runtime.state(), latest);
    assert.equal(application.state(), latest);
    assert.equal(textDocumentText(latest.project.buffers[id]!.editor.document), 'new first');
    assert.ok(updates.length >= 2);
    assert.ok(updates.every((update, index) => index === 0 || update.revision > updates[index - 1]!.revision));
  } finally {
    unsubscribe();
    await runtime.dispose();
    await application.dispose();
  }
});

test('keyboard and palette save commands share execution and retain the selected document identity', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vellum-command-owner-'));
  const firstPath = path.join(directory, 'first.md');
  const secondPath = path.join(directory, 'second.md');
  await writeFile(firstPath, 'first');
  await writeFile(secondPath, 'second');
  const application = createVellumApplication({ watchFiles: false });
  try {
    const first = await application.openFile(firstPath);
    application.applyTextAreaTransition(first, { kind: 'edit', operation: { kind: 'insert', text: 'edited ' } });
    const command = application.dispatchCommand('file.save');
    const second = await application.openFile(secondPath);
    for (const operation of command.operations) await operation.run(new AbortController().signal);
    assert.equal(await readFile(firstPath, 'utf8'), 'edited first');
    assert.equal(await readFile(secondPath, 'utf8'), 'second');
    assert.equal(application.state().project.activeBufferId, second);
    application.applyTextAreaTransition(second, { kind: 'edit', operation: { kind: 'insert', text: 'palette ' } });
    application.dispatchCommand('application.commandPalette');
    await application.submitSelectionDialog('file.save');
    assert.equal(await readFile(secondPath, 'utf8'), 'palette second');
    assert.equal(application.state().dialogState, undefined);
  } finally {
    await application.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a cancelled lazy read does not commit nodes and can be retried', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vellum-cancel-tree-'));
  const application = createVellumApplication({ watchFiles: false });
  try {
    await application.openProjectDirectory(directory);
    await writeFile(path.join(directory, 'later.md'), 'later');
    const controller = new AbortController();
    const pending = application.loadFileTreeDirectory(directory, controller.signal);
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(application.state().project.fileTree.nodes[directory]?.loading, false);
    assert.equal(application.state().project.fileTree.nodes[path.join(directory, 'later.md')], undefined);
    await application.loadFileTreeDirectory(directory);
    assert.ok(application.state().project.fileTree.nodes[path.join(directory, 'later.md')]);
  } finally {
    await application.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('tree interaction is owned directly and preserved when deriving a source', () => {
  const root = path.resolve('workspace');
  const initial = createFileTreeState(root);
  assert.deepEqual(initial.interaction.expandedIds, [root]);
  const next = reduceFileTree(initial, { kind: 'toggle', id: root });
  assert.deepEqual(next.interaction.expandedIds, []);
  assert.equal(next.source, initial.source);
  assert.equal(next.view, null);
  const interaction = next.interaction;
  terminalFileTreeSource(next);
  assert.equal(next.interaction, interaction);
  assert.equal(next.interaction.selection.mode, 'single');
});

test('accepted Unicode editor geometry follows divider drag, preview toggles and terminal resize without stale feedback', async () => {
  const application = createVellumApplication({ watchFiles: false });
  const source = Array.from({ length: 80 }, (_, index) => `${index} 界 é 👨‍👩‍👧‍👦 Markdown wraps around a wide Unicode gutter.`).join('\n');
  const bufferId = application.openSource(source);
  application.dispatchCommand('view.editorPreview');
  const observed = observedVellum(application, createMemoryTerminalHost({ terminalSize: { columns: 120, rows: 24 } }));
  const runtime = observed.runtime;
  const settle = () => observed.settle();
  try {
    await runtime.start();
    await settle();
    const before = observed.editor();
    assert.ok(before.allocatedBounds.width > before.contentBounds.width);
    assert.ok(before.contentBounds.height > 0);
    const assertExactMap = () => {
      const snapshot = observed.editor();
      const expected = createTextAreaRowOffsetMap({
        document: snapshot.document,
        terminalWidth: snapshot.allocatedBounds.width,
        terminalRows: snapshot.allocatedBounds.height,
        lineNumbers: { minWidth: 3 }, wrap: { mode: 'soft' }, scrollbar: { visible: 'auto' }
      });
      assert.equal(snapshot.rowOffsetMap.rowCount, expected.rowCount);
      for (let row = 0; row < expected.rowCount; row += 1) {
        assert.equal(snapshot.rowOffsetMap.sourceOffsetAtRow(row), expected.sourceOffsetAtRow(row));
      }
    };
    assertExactMap();
    await runtime.dispatch({ kind: 'split', transition: { kind: 'beginResize', dividerIndex: 0 } });
    await runtime.dispatch({ kind: 'split', transition: { kind: 'resizeFromAnchor', dividerIndex: 0, deltaShare: 0.2 } });
    await runtime.dispatch({ kind: 'split', transition: { kind: 'endResize', dividerIndex: 0 } });
    await settle();
    assert.ok(observed.editor().allocatedBounds.width > before.allocatedBounds.width);
    assertExactMap();
    await runtime.dispatch({ kind: 'command', commandId: 'view.editorSource' });
    await settle();
    assert.equal(observed.editor().allocatedBounds.width, 120);
    await runtime.resize({ columns: 72, rows: 18 });
    await settle();
    assert.equal(observed.editor().allocatedBounds.width, 72);
    assertExactMap();
    const old = observed.editor();
    await runtime.dispatch({ kind: 'editor', bufferId, transition: { kind: 'edit', operation: { kind: 'insert', text: 'new ' } } });
    await settle();
    const current = application.state();
    application.commitEditorLayout(bufferId, old);
    assert.equal(application.state(), current);
    const revision = current.revision;
    await settle();
    await settle();
    assert.equal(application.state().revision, revision);
  } finally {
    await runtime.dispose();
    await application.dispose();
  }
});

test('queued view snapshots resolve their own Markdown source after newer edits and buffer closure', async () => {
  const application = createVellumApplication({ watchFiles: false });
  try {
    const bufferId = application.openSource('# Before\n\n**original**');
    const before = application.state();
    application.applyTextAreaTransition(bufferId, { kind: 'edit', operation: { kind: 'insert', text: '# After\n\n' } });
    const current = application.state();
    const oldLayout = application.previewLayout(bufferId, 80, undefined, undefined, before);
    assert.ok(oldLayout);
    const lines = oldLayout.rows.map((row) => row.inlineSpans.map((span) => span.text).join('')).join('\n');
    assert.match(lines, /Before/u);
    assert.doesNotMatch(lines, /After/u);
    assert.equal(application.state(), current);
    application.requestCloseBuffer(bufferId);
    await application.resolveDirtyBuffer('discard');
    assert.ok(application.previewLayout(bufferId, 80, undefined, undefined, before));
    assert.doesNotThrow(() => application.hybridDecorations(bufferId, before));
  } finally { await application.dispose(); }
});

test('Save As retains its document when another buffer becomes active before submission', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vellum-save-as-owner-'));
  const destination = path.join(directory, 'first.md');
  const application = createVellumApplication({ watchFiles: false });
  try {
    const first = application.openSource('first source');
    application.dispatchCommand('file.saveAs');
    const second = application.openSource('second source');
    await application.submitFilePathDialog(destination);
    assert.equal(await readFile(destination, 'utf8'), 'first source');
    assert.equal(application.state().project.buffers[first]?.path, destination);
    assert.equal(application.state().project.buffers[second]?.path, undefined);
  } finally {
    await application.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
