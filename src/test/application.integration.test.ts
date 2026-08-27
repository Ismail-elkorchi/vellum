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
import { createRecoveryStore, type RecoveryStore } from '../recovery/recovery.js';
import type { BufferState } from '../app/types.js';
import { bufferIsDirty } from '../app/types.js';

test('background recovery failures enter the application update flow', async () => {
  let rejectWrite = true;
  const store: RecoveryStore = {
    filePath: '/virtual/vellum-recovery.json',
    async read() { return undefined; },
    async write() {
      if (rejectWrite) throw new Error('Recovery storage is unavailable.');
    },
    async delete() {}
  };
  const application = createVellumApplication({
    recoveryStore: store,
    recoveryDelayMilliseconds: 0,
    watchFiles: false,
    createBufferId: () => 'recovery-failure'
  });
  try {
    const update = new Promise<{ readonly reason: string }>((resolve) => {
      application.subscribe((value) => {
        if (value.reason === 'recoveryFailure') resolve(value);
      });
    });
    application.openSource('unsaved source');
    assert.equal((await update).reason, 'recoveryFailure');
    assert.equal(application.state().notice?.status, 'error');
    assert.match(application.state().notice?.message ?? '', /Recovery storage is unavailable/u);
  } finally {
    rejectWrite = false;
    await application.dispose();
  }
});

test('recovery writes are serialized so an older snapshot cannot replace the latest source document', async () => {
  const writtenSources: string[] = [];
  let releaseFirstWrite: (() => void) | undefined;
  const firstWrite = new Promise<void>((resolve) => { releaseFirstWrite = resolve; });
  const store: RecoveryStore = {
    filePath: '/virtual/serialized-recovery.json',
    async read() { return undefined; },
    async write(state) {
      const id = state.project.activeBufferId;
      const buffer = id === undefined ? undefined : state.project.buffers[id];
      writtenSources.push(buffer === undefined ? '' : textDocumentText(buffer.editor.document));
      if (writtenSources.length === 1) await firstWrite;
    },
    async delete() {}
  };
  const application = createVellumApplication({
    recoveryStore: store,
    recoveryDelayMilliseconds: 60_000,
    watchFiles: false,
    createBufferId: () => 'serialized-recovery'
  });
  try {
    const bufferId = application.openSource('source');
    const older = application.persistRecoveryRecord();
    await new Promise<void>((resolve) => setImmediate(resolve));
    application.applyTextAreaTransition(bufferId, { kind: 'edit', operation: { kind: 'insert', text: 'newer ' } });
    const newer = application.persistRecoveryRecord();
    releaseFirstWrite?.();
    await Promise.all([older, newer]);
    assert.deepEqual(writtenSources, ['source', 'newer source']);
  } finally {
    await application.dispose();
  }
});

test('multiple buffers preserve independent editing state and parser sessions through tab switching', async () => {
  const originalSources = ['A', 'B', 'C'].map((label) => (
    `# ${label}\n\n${Array.from({ length: 12 }, (_, row) => `${label} row ${String(row)}`).join('\n')}\n`
  ));
  const directory = await fixtureDirectory(Object.fromEntries(
    ['a.md', 'b.md', 'c.md'].map((name, index) => [name, originalSources[index] ?? ''])
  ));
  const application = createVellumApplication({ watchFiles: false, createBufferId: sequentialIds() });
  try {
    await application.openProjectDirectory(directory);
    const ids = await Promise.all(['a.md', 'b.md', 'c.md'].map((name) => application.openFile(path.join(directory, name))));
    const identities = ids.map((id) => application.runtimeBufferInfo(id)?.parserIdentity);
    const expectedStates: Array<{
      readonly source: string;
      readonly caret: BufferState['editor']['caret'];
      readonly selection: BufferState['editor']['selection'];
      readonly history: BufferState['editor']['history'];
      readonly sourceScroll: BufferState['editor']['scroll'];
      readonly previewScroll: BufferState['previewScroll'];
    }> = [];
    for (let index = 0; index < ids.length; index += 1) {
      const id = ids[index] as string;
      application.activateBuffer(id);
      application.applyTextAreaTransition(id, { kind: 'pointer', transition: { kind: 'placeCaret', offset: 4 } });
      application.applyTextAreaTransition(id, { kind: 'edit', operation: { kind: 'insert', text: ` edit-${String(index)}` } });
      application.executeMarkdownCommand(id, 'edit.undo');
      assert.equal(textDocumentText(application.state().project.buffers[id]?.editor.document as never), originalSources[index]);
      application.executeMarkdownCommand(id, 'edit.redo');
      application.applyTextAreaTransition(id, {
        kind: 'pointer', transition: { kind: 'extendSelection', anchor: 0, offset: 3 + index }
      });
      application.applyTextAreaTransition(id, { kind: 'scroll', request: {
        nextState: { offsetRow: index + 1, offsetColumn: 0, followTail: false },
        source: 'keyboard',
        target: 'content'
      } });
      application.updatePreviewScroll(id, {
        nextState: { offsetRow: index + 2, offsetColumn: 0, followTail: false },
        source: 'keyboard',
        target: 'content'
      });
      const current = application.state().project.buffers[id];
      assert.ok(current);
      expectedStates.push({
        source: textDocumentText(current.editor.document),
        caret: current.editor.caret,
        selection: current.editor.selection,
        history: current.editor.history,
        sourceScroll: current.editor.scroll,
        previewScroll: current.previewScroll
      });
    }
    for (let round = 0; round < 5; round += 1) for (const id of ids) application.activateBuffer(id);
    for (let index = 0; index < ids.length; index += 1) {
      const buffer = application.state().project.buffers[ids[index] as string];
      const expected = expectedStates[index];
      assert.equal(textDocumentText(buffer?.editor.document as never), expected?.source);
      assert.deepEqual(buffer?.editor.caret, expected?.caret);
      assert.deepEqual(buffer?.editor.selection, expected?.selection);
      assert.deepEqual(buffer?.editor.history, expected?.history);
      assert.deepEqual(buffer?.editor.scroll, expected?.sourceScroll);
      assert.deepEqual(buffer?.previewScroll, expected?.previewScroll);
      assert.equal(buffer === undefined ? undefined : bufferIsDirty(buffer), true);
      assert.equal(application.runtimeBufferInfo(ids[index] as string)?.parserIdentity, identities[index]);
      assert.ok((buffer?.editor.history.undo.length ?? 0) > 0);
    }
    await application.saveAll();
    for (const id of ids) {
      const buffer = application.state().project.buffers[id];
      assert.equal(buffer === undefined ? undefined : bufferIsDirty(buffer), false);
    }
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

test('closing a buffer removes navigation entries that cannot be activated again', async () => {
  const application = createVellumApplication({ watchFiles: false, createBufferId: sequentialIds() });
  try {
    const firstId = application.openSource('first', 'first.md');
    const secondId = application.openSource('second', 'second.md');
    application.activateBuffer(firstId);
    application.navigateTo(secondId, 2);
    assert.equal(application.state().commandState.navigation.back.some((entry) => entry.bufferId === firstId), true);
    assert.equal(application.requestCloseBuffer(firstId), false);
    await application.resolveDirtyBuffer('discard');
    const navigation = application.state().commandState.navigation;
    assert.equal([...navigation.back, ...navigation.forward].some((entry) => entry.bufferId === firstId), false);
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
      kind: 'pointer', transition: { kind: 'extendSelection', anchor: 20, offset: 23 }
    });
    application.applyTextAreaTransition(id, { kind: 'scroll', request: {
      nextState: { offsetRow: 2, offsetColumn: 1, followTail: false },
      source: 'keyboard',
      target: 'content'
    } });
    application.updatePreviewScroll(id, {
      nextState: { offsetRow: 3, offsetColumn: 0, followTail: false },
      source: 'keyboard',
      target: 'content'
    });
    application.applyTextAreaTransition(id, {
      kind: 'edit',
      operation: { kind: 'replaceRange', range: { startOffset: 0, endOffsetExclusive: 15 }, text: '' }
    });
    const recovered = application.state().project.buffers[id];
    assert.equal(recovered?.preview.kind, 'ready');
    assert.equal(textDocumentText(recovered?.editor.document as never), '456789012345');
    assert.equal(recovered === undefined ? undefined : bufferIsDirty(recovered), true);
    assert.equal(recovered?.editor.selection, undefined);
    assert.equal(recovered?.editor.caret.position.offset, 0);
    assert.deepEqual(recovered?.editor.scroll, { offsetRow: 2, offsetColumn: 1, followTail: false });
    assert.deepEqual(recovered?.previewScroll, { offsetRow: 3, offsetColumn: 0, followTail: false });
    assert.ok((recovered?.editor.history.undo.length ?? 0) >= 2);
    application.executeMarkdownCommand(id, 'edit.undo');
    const undone = application.state().project.buffers[id];
    assert.equal(undone?.preview.kind, 'failed');
    assert.deepEqual(undone?.editor.selection, {
      anchor: { offset: 20, affinity: 'downstream' },
      focus: { offset: 23, affinity: 'downstream' }
    });
    assert.equal(undone?.editor.caret.position.offset, 23);
    assert.equal(undone?.editor.history.redo.length, 1);
    application.executeMarkdownCommand(id, 'edit.redo');
    assert.equal(application.state().project.buffers[id]?.preview.kind, 'ready');
    assert.equal(application.state().project.buffers[id]?.editor.selection, undefined);
    assert.equal(application.state().project.buffers[id]?.editor.caret.position.offset, 0);
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
    first.applyTextAreaTransition(ids[1] as string, {
      kind: 'pointer', transition: { kind: 'extendSelection', anchor: 1, offset: 4 }
    });
    first.applyTextAreaTransition(ids[1] as string, { kind: 'scroll', request: {
      nextState: { offsetRow: 3, offsetColumn: 1, followTail: false },
      source: 'keyboard',
      target: 'content'
    } });
    first.updatePreviewScroll(ids[1] as string, {
      nextState: { offsetRow: 2, offsetColumn: 0, followTail: false },
      source: 'keyboard',
      target: 'content'
    });
    first.dispatchCommand('view.editorHybrid');
    first.dispatchCommand('view.editorPreview');
    await first.persistRecoveryRecord();
    const restored = await restoreVellumApplication(store, { watchFiles: false });
    try {
      const state = restored.state();
      assert.equal(state.project.rootDirectory, directory);
      assert.deepEqual(state.project.bufferOrder, ids);
      assert.equal(state.project.activeBufferId, ids[1]);
      assert.equal(textDocumentText(state.project.buffers[ids[0] as string]?.editor.document as never), 'changed # A');
      assert.equal(state.project.buffers[ids[1] as string]?.editor.caret.position.offset, 4);
      assert.deepEqual(state.project.buffers[ids[1] as string]?.editor.selection, {
        anchor: { offset: 1, affinity: 'downstream' },
        focus: { offset: 4, affinity: 'downstream' }
      });
      assert.equal(state.project.buffers[ids[1] as string]?.editor.scroll.offsetColumn, 1);
      assert.equal(state.project.buffers[ids[1] as string]?.previewScroll.offsetRow, 2);
      assert.equal(state.editorMode, 'hybrid');
      assert.equal(state.paneArrangement, 'editorPreview');
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

test('file watchers publish only after the external file revision is committed', async () => {
  const directory = await fixtureDirectory({ 'watched.md': 'disk source\n' });
  const filePath = path.join(directory, 'watched.md');
  const application = createVellumApplication({ watchFiles: true, createBufferId: sequentialIds() });
  try {
    const id = await application.openFile(filePath);
    const observed = new Promise<string>((resolve) => {
      application.subscribe((update) => {
        if (update.reason !== 'externalFileRevision' || update.bufferId !== id) return;
        const buffer = application.state().project.buffers[id];
        resolve(textDocumentText(buffer?.editor.document as never));
      });
    });
    await writeFile(filePath, 'disk source changed and longer\n', 'utf8');
    assert.equal(await withTimeout(observed, 5_000), 'disk source changed and longer\n');
    assert.equal(application.state().project.buffers[id]?.externalFileState.kind, 'current');
  } finally {
    await application.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('saving an older source revision never replaces edits made while disk I/O is in flight', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vellum-save-race-'));
  const destination = path.join(directory, 'note.md');
  const application = createVellumApplication({ watchFiles: false, createBufferId: () => 'save-race' });
  try {
    const id = application.openSource('original source');
    const saving = application.saveBuffer(id, destination);
    application.applyTextAreaTransition(id, { kind: 'edit', operation: { kind: 'insert', text: 'new ' } });
    assert.equal(await saving, true);
    const buffer = application.state().project.buffers[id];
    assert.equal(textDocumentText(buffer?.editor.document as never), 'new original source');
    assert.equal(await readFile(destination, 'utf8'), 'original source');
    assert.equal(buffer === undefined ? undefined : bufferIsDirty(buffer), true);
    assert.equal(buffer?.savedRevision, 1);
    assert.equal(buffer?.sourceRevision, 2);
  } finally {
    await application.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('external file checks classify the latest buffer revision and never reload over a concurrent edit', async () => {
  const directory = await fixtureDirectory({ 'note.md': 'original source\n' });
  const filePath = path.join(directory, 'note.md');
  const application = createVellumApplication({ watchFiles: false, createBufferId: () => 'external-race' });
  try {
    const id = await application.openFile(filePath);
    await writeFile(filePath, 'changed on disk\n', 'utf8');
    const checking = application.checkExternalFile(id);
    application.applyTextAreaTransition(id, { kind: 'edit', operation: { kind: 'insert', text: 'buffer ' } });
    assert.equal(await checking, true);
    const buffer = application.state().project.buffers[id];
    assert.equal(textDocumentText(buffer?.editor.document as never), 'buffer original source\n');
    assert.equal(buffer?.externalFileState.kind, 'conflict');
    assert.equal(buffer === undefined ? undefined : bufferIsDirty(buffer), true);
  } finally {
    await application.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('concurrent external checks converge on one clean disk revision without creating a false conflict', async () => {
  const directory = await fixtureDirectory({ 'note.md': 'original' });
  const filePath = path.join(directory, 'note.md');
  const application = createVellumApplication({ watchFiles: false, createBufferId: () => 'concurrent-reload' });
  try {
    const bufferId = await application.openFile(filePath);
    const originalParserIdentity = application.runtimeBufferInfo(bufferId)?.parserIdentity;
    const originalLayout = application.previewLayout(bufferId, 40);
    assert.equal(originalLayout?.lines.flatMap((line) => line.inlineSpans).map((span) => span.text).join(''), 'original');
    await writeFile(filePath, '# Disk revision\n\nreplacement words', 'utf8');
    const changed = await Promise.all([
      application.checkExternalFile(bufferId),
      application.checkExternalFile(bufferId)
    ]);
    const buffer = application.state().project.buffers[bufferId];
    assert.equal(changed.filter(Boolean).length, 1);
    assert.equal(textDocumentText(buffer?.editor.document as never), '# Disk revision\n\nreplacement words');
    assert.equal(buffer?.externalFileState.kind, 'current');
    assert.equal(buffer === undefined ? undefined : bufferIsDirty(buffer), false);
    assert.notEqual(application.runtimeBufferInfo(bufferId)?.parserIdentity, originalParserIdentity);
    assert.deepEqual(buffer?.preview.kind === 'ready' ? buffer.preview.metrics : undefined, {
      wordCount: 4,
      headingCount: 1,
      linkCount: 0,
      taskCount: 0
    });
    const replacementLayout = application.previewLayout(bufferId, 40);
    const replacementText = replacementLayout?.lines.flatMap((line) => line.inlineSpans).map((span) => span.text).join('\n') ?? '';
    assert.match(replacementText, /Disk revision/u);
    assert.doesNotMatch(replacementText, /original/u);
  } finally {
    await application.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('recovery persists pathless source and external conflict state without allowing an implicit overwrite', async () => {
  const directory = await fixtureDirectory({ 'tracked.md': 'disk source\n' });
  const recoveryDirectory = await mkdtemp(path.join(os.tmpdir(), 'vellum-recovery-safety-'));
  const store = createRecoveryStore(recoveryDirectory);
  const first = createVellumApplication({
    recoveryStore: store,
    watchFiles: false,
    createBufferId: sequentialIds('recovery-safety')
  });
  let restored: Awaited<ReturnType<typeof restoreVellumApplication>> | undefined;
  try {
    const pathlessId = first.openSource('pathless unsaved source', 'pathless.md');
    const trackedId = await first.openFile(path.join(directory, 'tracked.md'));
    first.applyTextAreaTransition(trackedId, { kind: 'edit', operation: { kind: 'insert', text: 'buffer ' } });
    await writeFile(path.join(directory, 'tracked.md'), 'disk changed\n', 'utf8');
    await first.checkExternalFile(trackedId);
    assert.equal(first.state().project.buffers[trackedId]?.externalFileState.kind, 'conflict');
    await first.persistRecoveryRecord();

    restored = await restoreVellumApplication(store, { watchFiles: false });
    const pathless = restored.state().project.buffers[pathlessId];
    const tracked = restored.state().project.buffers[trackedId];
    assert.equal(textDocumentText(pathless?.editor.document as never), 'pathless unsaved source');
    assert.equal(pathless === undefined ? undefined : bufferIsDirty(pathless), true);
    assert.equal(tracked?.externalFileState.kind, 'conflict');
    assert.equal(await restored.saveBuffer(trackedId), false);
    assert.equal(await readFile(path.join(directory, 'tracked.md'), 'utf8'), 'disk changed\n');
  } finally {
    await restored?.dispose();
    await first.dispose();
    await rm(directory, { recursive: true, force: true });
    await rm(recoveryDirectory, { recursive: true, force: true });
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
    assert.equal(reopened === undefined ? undefined : bufferIsDirty(reopened), true);
    assert.equal(reopened?.preview.sourceRevision, before.sourceRevision);
    application.applyTextAreaTransition(reopenedId, { kind: 'edit', operation: { kind: 'insert', text: 'again ' } });
    const editedAgain = application.state().project.buffers[reopenedId];
    assert.equal(editedAgain?.sourceRevision, before.sourceRevision + 1);
    assert.equal(editedAgain?.preview.sourceRevision, before.sourceRevision + 1);
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
    const savedFirst = application.state().project.buffers[first];
    const savedSecond = application.state().project.buffers[second];
    assert.equal(savedFirst === undefined ? undefined : bufferIsDirty(savedFirst), false);
    assert.equal(savedSecond === undefined ? undefined : bufferIsDirty(savedSecond), false);
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
    await writeFile(store.filePath, JSON.stringify({ schemaVersion: 1, buffers: [], openBufferOrder: [] }), 'utf8');
    await assert.rejects(() => store.read(), /Unsupported recovery schema version: 1/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('recovery rejects malformed current-schema state instead of normalizing it silently', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vellum-recovery-validation-'));
  const store = createRecoveryStore(directory);
  const application = createVellumApplication({
    recoveryStore: store,
    watchFiles: false,
    createBufferId: () => 'validated-buffer'
  });
  try {
    application.openSource('unsaved');
    await application.persistRecoveryRecord();
    const record = JSON.parse(await readFile(store.filePath, 'utf8')) as {
      buffers: Array<Record<string, unknown>>;
      openBufferOrder: string[];
    };
    const buffer = record.buffers[0];
    assert.ok(buffer);
    buffer['cursor'] = 999;
    record.openBufferOrder.push('missing-buffer');
    await writeFile(store.filePath, JSON.stringify(record), 'utf8');
    await assert.rejects(() => store.read(), /cursor exceeds|open-buffer order/iu);
  } finally {
    await application.dispose().catch(() => undefined);
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

async function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Operation exceeded ${String(milliseconds)} milliseconds.`)), milliseconds);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
