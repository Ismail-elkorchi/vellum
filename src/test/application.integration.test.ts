import assert from 'node:assert/strict';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { textDocumentText } from '@ismail-elkorchi/terminal-ui/text';
import {
  createVellumApplication,
  restoreVellumApplication
} from '../app/application.js';
import { createRecoveryStore } from '../recovery/recovery.js';

test('multiple buffers preserve independent editing state and parser sessions through tab switching', async () => {
  const directory = await fixtureDirectory({
    'a.md': '# A\n',
    'b.md': '# B\n',
    'c.md': '# C\n'
  });
  const application = createVellumApplication({ watchFiles: false, createBufferId: sequentialIds() });
  try {
    await application.openProjectDirectory(directory);
    const ids = await Promise.all(['a.md', 'b.md', 'c.md'].map((name) => application.openFile(path.join(directory, name))));
    const identities = ids.map((id) => application.runtimeBufferInfo(id)?.parserIdentity);
    for (let index = 0; index < ids.length; index += 1) {
      const id = ids[index] as string;
      application.activateBuffer(id);
      application.applyTextAreaTransition(id, { kind: 'pointer', transition: { kind: 'placeCaret', offset: 4 } });
      application.applyTextAreaTransition(id, { kind: 'edit', operation: { kind: 'insert', text: ` edit-${String(index)}` } });
      application.applyTextAreaTransition(id, { kind: 'scroll', request: {
        nextState: { offsetRow: index + 1, offsetColumn: 0, followTail: false },
        source: 'keyboard',
        target: 'content'
      } });
    }
    for (let round = 0; round < 5; round += 1) for (const id of ids) application.activateBuffer(id);
    for (let index = 0; index < ids.length; index += 1) {
      const buffer = application.state().project.buffers[ids[index] as string];
      assert.equal(textDocumentText(buffer?.editor.document as never), `# A\n`.replace('A', String.fromCharCode(65 + index)) + ` edit-${String(index)}`);
      assert.equal(buffer?.dirty, true);
      assert.equal(application.runtimeBufferInfo(ids[index] as string)?.parserIdentity, identities[index]);
      assert.ok((buffer?.editor.history.undo.length ?? 0) > 0);
    }
    await application.saveAll();
    for (const id of ids) assert.equal(application.state().project.buffers[id]?.dirty, false);
    for (const id of [...ids]) assert.equal(application.requestCloseBuffer(id), true);
    assert.deepEqual(application.state().project.bufferOrder, []);
  } finally {
    await application.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Vellum application factories do not share buffers, parser sessions, or navigation state', async () => {
  const first = createVellumApplication({ watchFiles: false, createBufferId: sequentialIds('first') });
  const second = createVellumApplication({ watchFiles: false, createBufferId: sequentialIds('second') });
  try {
    const firstId = first.openSource('# First');
    const secondId = second.openSource('# Second');
    assert.notEqual(first.runtimeBufferInfo(firstId)?.parserIdentity, second.runtimeBufferInfo(secondId)?.parserIdentity);
    first.applyTextAreaTransition(firstId, { kind: 'edit', operation: { kind: 'insert', text: 'changed ' } });
    first.navigateTo(firstId, 3);
    assert.equal(textDocumentText(second.state().project.buffers[secondId]?.editor.document as never), '# Second');
    assert.deepEqual(second.state().commandState.navigation.back, []);
  } finally {
    await first.dispose();
    await second.dispose();
  }
});

test('navigation history restores selections across buffers without duplicate locations', async () => {
  const application = createVellumApplication({ watchFiles: false, createBufferId: sequentialIds() });
  try {
    const firstId = application.openSource('alpha beta', 'first.md');
    const secondId = application.openSource('gamma delta', 'second.md');
    application.activateBuffer(firstId);
    application.applyTextAreaTransition(firstId, {
      kind: 'pointer',
      transition: { kind: 'extendSelection', anchor: 0, offset: 5 }
    });
    application.navigateTo(secondId, 6);
    application.navigateTo(secondId, 6);
    assert.equal(application.state().commandState.navigation.back.length, 2);
    application.navigateHistory('back');
    application.navigateHistory('back');
    const restored = application.state().project.buffers[firstId];
    assert.equal(application.state().project.activeBufferId, firstId);
    assert.deepEqual(restored?.editor.selection, {
      anchor: { offset: 0, affinity: 'downstream' },
      focus: { offset: 5, affinity: 'downstream' }
    });
  } finally {
    await application.dispose();
  }
});

test('preview budget failure never replaces source and recovers after an exact deletion', async () => {
  const application = createVellumApplication({
    watchFiles: false,
    createBufferId: sequentialIds(),
    parseOptions: { budgets: { maxInputCodeUnits: 20 } }
  });
  try {
    const source = '01234567890123456789012345';
    const id = application.openSource(source);
    assert.equal(application.state().project.buffers[id]?.preview.kind, 'failed');
    application.applyTextAreaTransition(id, { kind: 'pointer', transition: { kind: 'placeCaret', offset: 10 } });
    application.applyTextAreaTransition(id, { kind: 'edit', operation: { kind: 'insert', text: 'x' } });
    assert.equal(application.state().project.buffers[id]?.preview.kind, 'failed');
    application.applyTextAreaTransition(id, {
      kind: 'edit',
      operation: { kind: 'replaceRange', range: { startOffset: 0, endOffsetExclusive: 15 }, text: '' }
    });
    const recovered = application.state().project.buffers[id];
    assert.equal(recovered?.preview.kind, 'ready');
    assert.equal(textDocumentText(recovered?.editor.document as never), '456789012345');
    assert.equal(recovered?.dirty, true);
    assert.ok((recovered?.editor.history.undo.length ?? 0) >= 2);
    application.executeMarkdownCommand(id, 'edit.undo');
    assert.equal(application.state().project.buffers[id]?.preview.kind, 'failed');
    application.executeMarkdownCommand(id, 'edit.redo');
    assert.equal(application.state().project.buffers[id]?.preview.kind, 'ready');
  } finally {
    await application.dispose();
  }
});

test('recovery restores project directory, buffer order, active buffer, source, caret, and scroll', async () => {
  const directory = await fixtureDirectory({ 'a.md': '# A', 'b.md': '# B', 'c.md': '# C' });
  const recoveryDirectory = await mkdtemp(path.join(os.tmpdir(), 'vellum-recovery-'));
  const store = createRecoveryStore(recoveryDirectory);
  const first = createVellumApplication({ recoveryStore: store, watchFiles: false, createBufferId: sequentialIds() });
  try {
    await first.openProjectDirectory(directory);
    const ids = [];
    for (const name of ['a.md', 'b.md', 'c.md']) ids.push(await first.openFile(path.join(directory, name)));
    for (const id of ids.slice(0, 2)) first.applyTextAreaTransition(id, { kind: 'edit', operation: { kind: 'insert', text: 'changed ' } });
    first.activateBuffer(ids[1] as string);
    first.applyTextAreaTransition(ids[1] as string, { kind: 'pointer', transition: { kind: 'placeCaret', offset: 4 } });
    first.applyTextAreaTransition(ids[1] as string, { kind: 'scroll', request: {
      nextState: { offsetRow: 3, offsetColumn: 1, followTail: false },
      source: 'keyboard',
      target: 'content'
    } });
    await first.persistRecoveryRecord();
    const restored = await restoreVellumApplication(store, { watchFiles: false });
    try {
      const state = restored.state();
      assert.equal(state.project.rootDirectory, directory);
      assert.deepEqual(state.project.bufferOrder, ids);
      assert.equal(state.project.activeBufferId, ids[1]);
      assert.equal(textDocumentText(state.project.buffers[ids[0] as string]?.editor.document as never), 'changed # A');
      assert.equal(state.project.buffers[ids[1] as string]?.editor.caret.position.offset, 4);
      assert.equal(state.project.buffers[ids[1] as string]?.editor.scroll.offsetColumn, 1);
    } finally {
      await restored.dispose();
    }
  } finally {
    await first.dispose();
    await rm(directory, { recursive: true, force: true });
    await rm(recoveryDirectory, { recursive: true, force: true });
  }
});

test('external conflict comparison and Save As preserve disk and buffer versions', async () => {
  const directory = await fixtureDirectory({ 'note.md': 'disk original\n' });
  const sourcePath = path.join(directory, 'note.md');
  const destination = path.join(directory, 'buffer.md');
  const application = createVellumApplication({ watchFiles: false, createBufferId: sequentialIds() });
  try {
    const id = await application.openFile(sourcePath);
    application.applyTextAreaTransition(id, { kind: 'edit', operation: { kind: 'insert', text: 'buffer ' } });
    await writeFile(sourcePath, 'disk changed\n', 'utf8');
    await application.checkExternalFile(id);
    assert.equal(application.state().project.buffers[id]?.externalFileState.kind, 'conflict');
    const comparison = await application.compareExternalFile(id);
    assert.ok(comparison.some((line) => line.kind === 'removed' && line.text.includes('buffer')));
    assert.ok(comparison.some((line) => line.kind === 'added' && line.text.includes('changed')));
    application.keepBuffer(id);
    assert.equal(application.state().project.buffers[id]?.externalFileState.kind, 'conflict');
    assert.equal(await application.saveBuffer(id), false);
    assert.equal(application.state().dialogState?.kind, 'externalConflict');
    assert.equal(await readFile(sourcePath, 'utf8'), 'disk changed\n');
    application.dismissDialog();
    assert.equal(application.requestCloseBuffer(id), false);
    assert.equal(await application.resolveDirtyBuffer('save'), false);
    assert.equal(application.state().project.buffers[id]?.externalFileState.kind, 'conflict');
    assert.equal(await readFile(sourcePath, 'utf8'), 'disk changed\n');
    await application.saveBuffer(id, destination);
    assert.equal(await readFile(sourcePath, 'utf8'), 'disk changed\n');
    assert.equal(await readFile(destination, 'utf8'), 'buffer disk original\n');
  } finally {
    await application.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('reopening a recently closed buffer restores its complete editing state', async () => {
  const application = createVellumApplication({ watchFiles: false, createBufferId: sequentialIds() });
  try {
    const id = application.openSource('alpha\nbeta\n', 'notes.md');
    application.applyTextAreaTransition(id, { kind: 'pointer', transition: { kind: 'placeCaret', offset: 8 } });
    application.applyTextAreaTransition(id, { kind: 'edit', operation: { kind: 'insert', text: 'changed ' } });
    application.applyTextAreaTransition(id, { kind: 'scroll', request: {
      nextState: { offsetRow: 1, offsetColumn: 2, followTail: false },
      source: 'keyboard',
      target: 'content'
    } });
    const before = application.state().project.buffers[id];
    assert.ok(before);
    assert.equal(application.requestCloseBuffer(id), false);
    await application.resolveDirtyBuffer('discard');
    const reopenedId = application.reopenRecentlyClosed();
    assert.ok(reopenedId);
    const reopened = application.state().project.buffers[reopenedId];
    assert.equal(textDocumentText(reopened?.editor.document as never), textDocumentText(before.editor.document));
    assert.equal(reopened?.editor.caret.position.offset, before.editor.caret.position.offset);
    assert.deepEqual(reopened?.editor.selection, before.editor.selection);
    assert.deepEqual(reopened?.editor.history, before.editor.history);
    assert.deepEqual(reopened?.editor.scroll, before.editor.scroll);
    assert.deepEqual(reopened?.previewScroll, before.previewScroll);
    assert.equal(reopened?.sourceRevision, before.sourceRevision);
    assert.equal(reopened?.savedRevision, before.savedRevision);
    assert.equal(reopened?.dirty, true);
  } finally {
    await application.dispose();
  }
});

test('saving pathless dirty buffers during close uses Save As and completes the requested close', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vellum-close-save-as-'));
  const application = createVellumApplication({ watchFiles: false, createBufferId: sequentialIds() });
  try {
    const first = application.openSource('first changed', 'first.md');
    const second = application.openSource('second changed', 'second.md');
    assert.equal(application.requestCloseBuffer(first), false);
    assert.equal(await application.resolveDirtyBuffer('save'), false);
    assert.equal(application.state().dialogState?.kind, 'filePath');
    assert.equal(await application.submitFilePathDialog(path.join(directory, 'first.md')), false);
    assert.equal(application.state().project.buffers[first], undefined);
    assert.equal(await readFile(path.join(directory, 'first.md'), 'utf8'), 'first changed');

    application.activateBuffer(second);
    assert.equal(application.requestCloseApplication(), false);
    assert.equal(await application.resolveCloseApplication('saveAll'), false);
    assert.equal(await application.submitFilePathDialog(path.join(directory, 'second.md')), true);
    assert.deepEqual(application.state().project.bufferOrder, []);
    assert.equal(await readFile(path.join(directory, 'second.md'), 'utf8'), 'second changed');
  } finally {
    await application.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Save All requests one destination for each pathless dirty buffer', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vellum-save-all-'));
  const application = createVellumApplication({ watchFiles: false, createBufferId: sequentialIds() });
  try {
    const first = application.openSource('first source', 'first.md');
    const second = application.openSource('second source', 'second.md');
    assert.equal(await application.saveAll(), false);
    assert.equal(application.state().project.activeBufferId, first);
    assert.equal(await application.submitFilePathDialog(path.join(directory, 'first.md')), false);
    assert.equal(application.state().project.activeBufferId, second);
    assert.equal(application.state().dialogState?.kind, 'filePath');
    assert.equal(await application.submitFilePathDialog(path.join(directory, 'second.md')), false);
    assert.equal(application.state().dialogState, undefined);
    assert.equal(application.state().project.buffers[first]?.dirty, false);
    assert.equal(application.state().project.buffers[second]?.dirty, false);
    assert.equal(await readFile(path.join(directory, 'first.md'), 'utf8'), 'first source');
    assert.equal(await readFile(path.join(directory, 'second.md'), 'utf8'), 'second source');
  } finally {
    await application.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('external rename updates the buffer, file tree, and recent path while deletion requires an explicit action', async () => {
  const directory = await fixtureDirectory({ 'before.md': '# Before\n' });
  const before = path.join(directory, 'before.md');
  const after = path.join(directory, 'after.md');
  const application = createVellumApplication({ watchFiles: false, createBufferId: sequentialIds() });
  try {
    await application.openProjectDirectory(directory);
    const id = await application.openFile(before);
    await rename(before, after);
    await application.checkExternalFile(id);
    const renamedBuffer = application.state().project.buffers[id];
    assert.equal(renamedBuffer?.path, after);
    assert.equal(renamedBuffer?.label, 'after.md');
    assert.ok(application.state().project.recentlyOpenedPaths.includes(after));
    assert.ok(Object.hasOwn(application.state().project.fileTree.nodes, after));

    await rm(after);
    await application.checkExternalFile(id);
    assert.equal(application.state().project.buffers[id]?.externalFileState.kind, 'deleted');
    assert.equal(application.state().dialogState?.kind, 'externalConflict');
    await application.resolveExternalFileAction('recreate');
    assert.equal(await readFile(after, 'utf8'), '# Before\n');
    assert.equal(application.state().project.buffers[id]?.externalFileState.kind, 'current');
  } finally {
    await application.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('unknown recovery schemas are rejected with a clear diagnostic', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vellum-recovery-schema-'));
  const store = createRecoveryStore(directory);
  try {
    await writeFile(store.filePath, JSON.stringify({ schemaVersion: 99, buffers: [], openBufferOrder: [] }), 'utf8');
    await assert.rejects(() => store.read(), /Unsupported recovery schema version: 99/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function fixtureDirectory(files: Readonly<Record<string, string>>): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vellum-project-'));
  await Promise.all(Object.entries(files).map(([name, source]) => writeFile(path.join(directory, name), source, 'utf8')));
  return directory;
}

function sequentialIds(prefix = 'buffer'): () => string {
  let next = 0;
  return () => `${prefix}-${String(next++)}`;
}
