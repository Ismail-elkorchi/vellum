import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createMemoryTerminalHost } from '@ismail-elkorchi/terminal-ui/host';
import { createTuiRuntime } from '@ismail-elkorchi/terminal-ui/tui';
import { createVellumTui } from '../tui.js';
import { textDocumentText } from '@ismail-elkorchi/terminal-ui/text';
import { createVellumApplication, restoreVellumApplication, type VellumApplication } from '../app/application.js';
import { bufferIsDirty } from '../app/types.js';
import { createRecoveryStore, type RecoveryStore } from '../recovery/recovery.js';
import { createSessionStore } from '../session/session.js';

function source(app: VellumApplication, id: string): string {
  const buffer = app.state().project.buffers[id];
  assert.ok(buffer);
  return textDocumentText(buffer.editor.document);
}
function dirty(app: VellumApplication, id: string): boolean {
  const buffer = app.state().project.buffers[id];
  assert.ok(buffer);
  return bufferIsDirty(buffer);
}
function insert(app: VellumApplication, id: string, text: string): void {
  app.update({ kind: 'editor', bufferId: id, transition: { kind: 'edit', operation: { kind: 'insert', text } } });
}
async function fixture(): Promise<{ directory: string; file: string }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vellum-authority-'));
  const file = path.join(directory, 'note.md');
  await writeFile(file, 'original\n');
  return { directory, file };
}
function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

for (const watchFiles of [false, true]) for (const edited of [false, true]) {
  test(`rename plus same-inode rewrite reconciles ${edited ? 'dirty' : 'clean'} contents through ${watchFiles ? 'watcher' : 'API'}`, async () => {
    const { directory, file } = await fixture();
    const app = createVellumApplication({ watchFiles });
    try {
      await app.openProjectDirectory(directory);
      const id = await app.openFile(file);
      if (edited) insert(app, id, 'local ');
      const moved = path.join(directory, 'moved.md');
      const observed = deferred();
      app.subscribe((update) => {
        const buffer = update.state.project.buffers[id];
        if (update.reason === 'externalFileRevision' && buffer?.path === moved
          && (edited ? buffer.externalFileState.kind === 'conflict' : source(app, id) === 'external\n')) observed.resolve();
      });
      await rename(file, moved);
      await writeFile(moved, 'external\n');
      if (watchFiles) await Promise.race([observed.promise, new Promise<never>((_, reject) => {
        const timeout = setTimeout(() => reject(new Error('Watcher did not reconcile renamed source')), 3000);
        timeout.unref();
      })]);
      else await app.checkExternalFile(id);
      assert.equal(app.state().project.buffers[id]?.path, moved);
      assert.equal(source(app, id), edited ? 'local original\n' : 'external\n');
      assert.equal(app.state().project.buffers[id]?.externalFileState.kind, edited ? 'conflict' : 'current');
      assert.equal(await app.saveBuffer(id), !edited);
      assert.equal(await readFile(moved, 'utf8'), 'external\n');
    } finally {
      await app.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test('file reopen uses live identity and current disk contents rather than a closed snapshot', async () => {
  const { directory, file } = await fixture();
  const app = createVellumApplication({ watchFiles: false });
  try {
    const first = await app.openFile(file);
    assert.equal(app.requestCloseBuffer(first), true);
    const live = await app.openFile(file);
    assert.equal(await app.reopenRecentlyClosed(), live);
    assert.deepEqual(app.state().project.bufferOrder, [live]);
    assert.equal(app.requestCloseBuffer(live), true);
    await writeFile(file, 'new disk\n');
    const reopened = await app.reopenRecentlyClosed();
    assert.ok(reopened);
    assert.equal(source(app, reopened), 'new disk\n');
    assert.equal(dirty(app, reopened), false);
  } finally {
    await app.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('saved content remains authoritative through undo, redo, saves, and branching histories', async () => {
  const { directory, file } = await fixture();
  const app = createVellumApplication({ watchFiles: false });
  try {
    const id = await app.openFile(file);
    insert(app, id, 'a');
    assert.equal(dirty(app, id), true);
    app.update({ kind: 'command', commandId: 'edit.undo' });
    assert.equal(dirty(app, id), false);
    app.update({ kind: 'command', commandId: 'edit.redo' });
    assert.equal(dirty(app, id), true);
    await app.saveBuffer(id);
    assert.equal(dirty(app, id), false);
    app.update({ kind: 'command', commandId: 'edit.undo' });
    assert.equal(dirty(app, id), true);
    app.update({ kind: 'command', commandId: 'edit.redo' });
    assert.equal(dirty(app, id), false);
    app.update({ kind: 'command', commandId: 'edit.undo' });
    insert(app, id, 'b');
    assert.equal(dirty(app, id), true);
    app.update({ kind: 'command', commandId: 'edit.undo' });
    insert(app, id, 'a');
    assert.equal(source(app, id), 'aoriginal\n');
    assert.equal(dirty(app, id), false);
  } finally {
    await app.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

for (const cancel of [false, true]) test(`paused save-and-quit ${cancel ? 'cancel and later edit' : 'later edit'} cannot close newer contents`, async () => {
  const { directory, file } = await fixture();
  const entered = deferred();
  const release = deferred();
  let pause = true;
  const store: RecoveryStore = {
    filePath: path.join(directory, 'recovery.json'),
    async read() { return undefined; },
    async write() { if (pause) { entered.resolve(); await release.promise; } },
    async delete() {},
    diagnostics() { return []; }
  };
  const app = createVellumApplication({ watchFiles: false, recoveryStore: store, persistenceDelayMilliseconds: 60000 });
  try {
    const id = await app.openFile(file);
    insert(app, id, 'saved ');
    app.update({ kind: 'command', commandId: 'application.quit' });
    const closing = app.resolveCloseApplication('saveAll');
    await entered.promise;
    if (cancel) app.update({ kind: 'resolveDirty', action: 'cancel' });
    insert(app, id, 'newer ');
    pause = false;
    release.resolve();
    assert.equal(await closing, false);
    assert.equal(source(app, id), 'saved newer original\n');
    assert.equal(dirty(app, id), true);
    assert.equal(await readFile(file, 'utf8'), 'saved original\n');
  } finally {
    pause = false;
    release.resolve();
    await app.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('clean and save-and-quit preserve the same workspace in the next session', async () => {
  for (const edited of [false, true]) {
    const { directory, file } = await fixture();
    const sessionStore = createSessionStore(path.join(directory, 'state'));
    const recoveryStore = createRecoveryStore(path.join(directory, 'state'));
    const app = createVellumApplication({ watchFiles: false, sessionStore, recoveryStore, persistenceDelayMilliseconds: 60000 });
    try {
      const id = await app.openFile(file);
      if (edited) insert(app, id, 'saved ');
      assert.equal(app.requestCloseApplication(), !edited);
      if (edited) assert.equal(await app.resolveCloseApplication('saveAll'), true);
      await app.dispose();
      const restored = await restoreVellumApplication(sessionStore, recoveryStore, { watchFiles: false });
      try {
        assert.equal(restored.state().project.bufferOrder.length, 1);
        const restoredId = restored.state().project.activeBufferId;
        assert.ok(restoredId);
        assert.equal(source(restored, restoredId), edited ? 'saved original\n' : 'original\n');
        assert.equal(dirty(restored, restoredId), false);
      } finally { await restored.dispose(); }
    } finally {
      await app.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  }
});


test('real quit input and Escape cancel the save effect without losing later edits or recovery', async () => {
  const { directory, file } = await fixture();
  const sessionStore = createSessionStore(path.join(directory, 'state'));
  const underlying = createRecoveryStore(path.join(directory, 'state'));
  const entered = deferred();
  const release = deferred();
  const completed = deferred();
  let pause = true;
  const recoveryStore: RecoveryStore = {
    ...underlying,
    async write(state) {
      if (pause) { entered.resolve(); await release.promise; }
      await underlying.write(state);
      completed.resolve();
    }
  };
  const app = createVellumApplication({ watchFiles: false, sessionStore, recoveryStore, persistenceDelayMilliseconds: 60000 });
  const runtime = createTuiRuntime({ app: createVellumTui(app), host: createMemoryTerminalHost() });
  try {
    const id = await app.openFile(file);
    insert(app, id, 'saved ');
    await runtime.start();
    await runtime.handleInputChunk({ data: '\u0011' });
    assert.equal(app.state().dialogState?.kind, 'dirtyBuffer');
    // The dialog starts on Cancel. Traverse Discard to Save and activate it.
    await runtime.handleInputChunk({ data: '\t' });
    await runtime.handleInputChunk({ data: '\t' });
    await runtime.handleInputChunk({ data: '\r' });
    await entered.promise;
    await runtime.handleInputChunk({ data: '\u001b' });
    await runtime.flushInput();
    assert.equal(app.state().dialogState, undefined);
    await runtime.dispatch({ kind: 'editor', bufferId: id, transition: { kind: 'edit', operation: { kind: 'insert', text: 'newer ' } } });
    pause = false;
    release.resolve();
    await completed.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(runtime.exit(), undefined);
    assert.equal(source(app, id), 'saved newer original\n');
    assert.equal(dirty(app, id), true);
    await app.persistState();
    const restored = await restoreVellumApplication(sessionStore, underlying, { watchFiles: false });
    try {
      assert.equal(source(restored, id), 'saved newer original\n');
      assert.equal(dirty(restored, id), true);
    } finally { await restored.dispose(); }
  } finally {
    pause = false;
    release.resolve();
    await runtime.dispose();
    await app.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

for (const closeApplication of [false, true]) test(`Save As ${closeApplication ? 'quit' : 'close'} cannot discard an edit made during the write`, async () => {
  const { directory } = await fixture();
  const entered = deferred();
  const release = deferred();
  let pause = true;
  const app = createVellumApplication({
    watchFiles: false,
    persistenceDelayMilliseconds: 60000,
    recoveryStore: {
      filePath: path.join(directory, 'recovery.json'),
      async read() { return undefined; },
      async write() { if (pause) { entered.resolve(); await release.promise; } },
      async delete() {},
      diagnostics() { return []; }
    }
  });
  try {
    const id = app.openSource('draft');
    if (closeApplication) {
      app.requestCloseApplication();
      await app.resolveCloseApplication('saveAll');
    } else {
      app.requestCloseBuffer(id);
      await app.resolveDirtyBuffer('save');
    }
    assert.equal(app.state().dialogState?.kind, 'filePath');
    const saved = app.submitFilePathDialog(path.join(directory, 'draft.md'));
    await entered.promise;
    insert(app, id, 'later ');
    pause = false;
    release.resolve();
    assert.equal(await saved, false);
    assert.equal(source(app, id), 'later draft');
    assert.equal(dirty(app, id), true);
    assert.equal(await readFile(path.join(directory, 'draft.md'), 'utf8'), 'draft');
  } finally {
    pause = false;
    release.resolve();
    await app.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('failed save-and-quit preserves open buffers and their recoverable source', async () => {
  const { directory, file } = await fixture();
  let fail = true;
  const underlying = createRecoveryStore(path.join(directory, 'state'));
  const sessionStore = createSessionStore(path.join(directory, 'state'));
  const app = createVellumApplication({
    watchFiles: false, sessionStore, persistenceDelayMilliseconds: 60000,
    recoveryStore: { ...underlying, async write(state) {
      if (fail) throw new Error('Paused storage failed');
      await underlying.write(state);
    } }
  });
  try {
    const id = await app.openFile(file);
    insert(app, id, 'local ');
    app.requestCloseApplication();
    await assert.rejects(app.resolveCloseApplication('saveAll'), /Paused storage failed/u);
    assert.deepEqual(app.state().project.bufferOrder, [id]);
    assert.equal(source(app, id), 'local original\n');
    assert.equal(app.state().dialogState?.kind, 'dirtyBuffer');
    assert.equal(await readFile(file, 'utf8'), 'local original\n');
    fail = false;
    insert(app, id, 'later ');
    await app.persistState();
    const restored = await restoreVellumApplication(sessionStore, underlying, { watchFiles: false });
    try { assert.equal(source(restored, id), 'local later original\n'); }
    finally { await restored.dispose(); }
  } finally {
    fail = false;
    await app.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('an exit completion queued before a later edit has no closing authority', async () => {
  const { directory, file } = await fixture();
  const app = createVellumApplication({ watchFiles: false });
  try {
    const id = await app.openFile(file);
    insert(app, id, 'saved ');
    app.requestCloseApplication();
    assert.equal(await app.resolveCloseApplication('saveAll'), true);
    const project = app.state().project;
    assert.deepEqual(app.update({ kind: 'exit', project }).exit, { reason: 'quit' });
    insert(app, id, 'later ');
    assert.equal(app.update({ kind: 'exit', project }).exit, undefined);
    assert.equal(source(app, id), 'saved later original\n');
  } finally {
    await app.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('external edits remain watched after an atomic save replaces the inode', async () => {
  const { directory, file } = await fixture();
  const app = createVellumApplication({ watchFiles: true });
  try {
    const id = await app.openFile(file);
    insert(app, id, 'saved ');
    await app.saveBuffer(id);
    const observed = deferred();
    app.subscribe((update) => {
      if (update.reason === 'externalFileRevision' && source(app, id) === 'after save\n') observed.resolve();
    });
    await writeFile(file, 'after save\n');
    await Promise.race([observed.promise, new Promise<never>((_, reject) => {
      const timeout = setTimeout(() => reject(new Error('Save detached file watcher')), 3000);
      timeout.unref();
    })]);
    assert.equal(source(app, id), 'after save\n');
    assert.equal(dirty(app, id), false);
  } finally {
    await app.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('undoing to saved contents removes the recovery entry even though parser revision increases', async () => {
  const { directory, file } = await fixture();
  const recoveryStore = createRecoveryStore(path.join(directory, 'state'));
  const app = createVellumApplication({ watchFiles: false, recoveryStore, persistenceDelayMilliseconds: 60000 });
  try {
    const id = await app.openFile(file);
    insert(app, id, 'local ');
    await app.persistState();
    assert.equal((await recoveryStore.read())?.snapshots.at(-1)?.buffers[0]?.id, id);
    app.update({ kind: 'command', commandId: 'edit.undo' });
    assert.equal(dirty(app, id), false);
    await app.persistState();
    assert.equal(await recoveryStore.read(), undefined);
  } finally {
    await app.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});


test('a disk write failure preserves the dirty buffer, close prompt, and restart recovery', async () => {
  const { directory, file } = await fixture();
  const sessionStore = createSessionStore(path.join(directory, 'state'));
  const recoveryStore = createRecoveryStore(path.join(directory, 'state'));
  const app = createVellumApplication({ watchFiles: false, sessionStore, recoveryStore, persistenceDelayMilliseconds: 60000 });
  try {
    const id = await app.openFile(file);
    insert(app, id, 'unsaved ');
    await rm(file);
    await mkdir(file);
    app.requestCloseApplication();
    await assert.rejects(app.resolveCloseApplication('saveAll'), /save target is not a file/u);
    assert.equal(source(app, id), 'unsaved original\n');
    assert.equal(dirty(app, id), true);
    assert.equal(app.state().dialogState?.kind, 'dirtyBuffer');
    await app.persistState();
    const restored = await restoreVellumApplication(sessionStore, recoveryStore, { watchFiles: false });
    try {
      assert.equal(source(restored, id), 'unsaved original\n');
      assert.equal(dirty(restored, id), true);
    } finally { await restored.dispose(); }
  } finally {
    await app.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('save command detects an unobserved disk rewrite instead of advancing its saved baseline', async () => {
  const { directory, file } = await fixture();
  const app = createVellumApplication({ watchFiles: false });
  try {
    const id = await app.openFile(file);
    insert(app, id, 'local ');
    await writeFile(file, 'external\n');
    const saving = app.dispatchCommand('file.save');
    for (const operation of saving.operations) await operation.run(new AbortController().signal);
    assert.equal(app.state().project.buffers[id]?.externalFileState.kind, 'conflict');
    assert.equal(app.state().project.buffers[id]?.savedSource, 'original\n');
    assert.equal(source(app, id), 'local original\n');
    assert.equal(await readFile(file, 'utf8'), 'external\n');
  } finally {
    await app.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a pure external rename preserves a dirty buffer baseline and permits its authorized save', async () => {
  const { directory, file } = await fixture();
  const app = createVellumApplication({ watchFiles: false });
  try {
    await app.openProjectDirectory(directory);
    const id = await app.openFile(file);
    insert(app, id, 'local ');
    const moved = path.join(directory, 'moved.md');
    await rename(file, moved);
    await app.checkExternalFile(id);
    assert.equal(app.state().project.buffers[id]?.path, moved);
    assert.equal(app.state().project.buffers[id]?.externalFileState.kind, 'current');
    assert.equal(await app.saveBuffer(id), true);
    assert.equal(await readFile(moved, 'utf8'), 'local original\n');
    assert.equal(dirty(app, id), false);
  } finally {
    await app.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('discard-and-quit retains file tabs while omitting discarded source from recovery', async () => {
  const { directory, file } = await fixture();
  const sessionStore = createSessionStore(path.join(directory, 'state'));
  const recoveryStore = createRecoveryStore(path.join(directory, 'state'));
  const app = createVellumApplication({ watchFiles: false, sessionStore, recoveryStore, persistenceDelayMilliseconds: 60000 });
  try {
    const id = await app.openFile(file);
    insert(app, id, 'discard ');
    app.openSource('discard this draft');
    app.requestCloseApplication();
    assert.equal(await app.resolveCloseApplication('discardAll'), true);
    await app.dispose();
    const restored = await restoreVellumApplication(sessionStore, recoveryStore, { watchFiles: false });
    try {
      assert.deepEqual(restored.state().project.bufferOrder, [id]);
      assert.equal(source(restored, id), 'original\n');
      assert.equal(dirty(restored, id), false);
      assert.equal(await recoveryStore.read(), undefined);
    } finally { await restored.dispose(); }
  } finally {
    await app.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});


test('reopen reuses a live renamed identity even when the closed record path is gone', async () => {
  const { directory, file } = await fixture();
  const app = createVellumApplication({ watchFiles: false });
  try {
    await app.openProjectDirectory(directory);
    const first = await app.openFile(file);
    app.requestCloseBuffer(first);
    const live = await app.openFile(file);
    const moved = path.join(directory, 'moved.md');
    await rename(file, moved);
    await app.checkExternalFile(live);
    insert(app, live, 'keep ');
    assert.equal(await app.reopenRecentlyClosed(), live);
    assert.deepEqual(app.state().project.bufferOrder, [live]);
    assert.equal(source(app, live), 'keep original\n');
  } finally {
    await app.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

for (const resolution of ['reload', 'overwrite', 'saveAs'] as const) test(`resolving a disk conflict by ${resolution} atomically retires its dialog`, async () => {
  const { directory, file } = await fixture();
  const app = createVellumApplication({ watchFiles: false });
  try {
    const id = await app.openFile(file);
    insert(app, id, 'local ');
    await writeFile(file, 'external\n');
    await app.checkExternalFile(id);
    assert.equal(app.state().dialogState?.kind, 'externalConflict');
    const inconsistent: string[] = [];
    app.subscribe(({ state }) => {
      const dialog = state.dialogState;
      if (dialog?.kind !== 'externalConflict') return;
      const kind = state.project.buffers[dialog.bufferId]?.externalFileState.kind;
      if (kind !== 'conflict' && kind !== 'deleted') inconsistent.push(String(kind));
    });
    if (resolution === 'reload') await app.reloadExternalFile(id);
    else if (resolution === 'overwrite') await app.saveBuffer(id, undefined, true);
    else await app.saveBuffer(id, path.join(directory, 'copy.md'));
    assert.equal(app.state().project.buffers[id]?.externalFileState.kind, 'current');
    assert.equal(app.state().dialogState, undefined);
    assert.deepEqual(inconsistent, []);
  } finally {
    await app.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('real watchers never mistake an atomic self-save for an external conflict or revoke quit', async () => {
  const { directory, file } = await fixture();
  const app = createVellumApplication();
  try {
    const id = await app.openFile(file);
    const conflicts: string[] = [];
    app.subscribe(({ state }) => {
      if (state.dialogState?.kind === 'externalConflict') conflicts.push(state.project.buffers[id]?.externalFileState.kind ?? 'missing');
    });
    for (let iteration = 0; iteration < 10; iteration += 1) {
      insert(app, id, 'x');
      assert.equal(await app.saveBuffer(id), true);
      await app.checkExternalFile(id);
      assert.equal(app.state().dialogState, undefined);
    }
    insert(app, id, 'last');
    app.requestCloseApplication();
    assert.equal(await app.resolveCloseApplication('saveAll'), true);
    await app.checkExternalFile(id);
    assert.equal(app.state().dialogState, undefined);
    assert.deepEqual(conflicts, []);
  } finally {
    await app.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

for (const externalWriter of [false, true]) test(`disk observations wait for a paused save baseline${externalWriter ? ' and preserve a newer external write' : ' without changing the close prompt'}`, async () => {
  const { directory, file } = await fixture();
  const entered = deferred();
  const release = deferred();
  let pause = true;
  const app = createVellumApplication({
    watchFiles: true,
    persistenceDelayMilliseconds: 60000,
    recoveryStore: {
      filePath: path.join(directory, 'recovery.json'),
      async read() { return undefined; },
      async write() { if (pause) { entered.resolve(); await release.promise; } },
      async delete() {},
      diagnostics() { return []; }
    }
  });
  try {
    const id = await app.openFile(file);
    insert(app, id, 'saved ');
    app.requestCloseApplication();
    const dialog = app.state().dialogState;
    const saving = app.saveBuffer(id);
    await entered.promise;
    assert.equal(await readFile(file, 'utf8'), 'saved original\n');
    if (externalWriter) {
      insert(app, id, 'newer ');
      await writeFile(file, 'external writer\n');
    }
    let observed = false;
    const checking = app.checkExternalFile(id).then(() => { observed = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(observed, false);
    assert.equal(app.state().dialogState, dialog);
    pause = false;
    release.resolve();
    assert.equal(await saving, true);
    await checking;
    if (externalWriter) {
      assert.equal(app.state().project.buffers[id]?.externalFileState.kind, 'conflict');
      assert.equal(app.state().dialogState?.kind, 'externalConflict');
      assert.equal(app.state().project.buffers[id]?.savedSource, 'saved original\n');
      assert.equal(await app.saveBuffer(id), false);
      assert.equal(await readFile(file, 'utf8'), 'external writer\n');
    } else {
      assert.equal(app.state().project.buffers[id]?.externalFileState.kind, 'current');
      assert.equal(app.state().dialogState, dialog);
      assert.equal(await app.resolveCloseApplication('saveAll'), true);
    }
  } finally {
    pause = false;
    release.resolve();
    await app.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

for (const externalWriter of [false, true]) test(`a stale reload preserves later edits with ${externalWriter ? 'changed' : 'unchanged'} disk contents`, async () => {
  const { directory, file } = await fixture();
  const entered = deferred();
  const release = deferred();
  let pause = true;
  const app = createVellumApplication({
    watchFiles: false, persistenceDelayMilliseconds: 60000,
    recoveryStore: {
      filePath: path.join(directory, 'recovery.json'),
      async read() { return undefined; },
      async write() { if (pause) { entered.resolve(); await release.promise; } },
      async delete() {}, diagnostics() { return []; }
    }
  });
  try {
    const id = await app.openFile(file);
    insert(app, id, 'saved ');
    const saving = app.saveBuffer(id);
    await entered.promise;
    const reloading = app.reloadExternalFile(id);
    insert(app, id, 'later ');
    if (externalWriter) await writeFile(file, 'external\n');
    pause = false;
    release.resolve();
    await saving;
    assert.equal(await reloading, externalWriter);
    assert.equal(source(app, id), 'saved later original\n');
    assert.equal(dirty(app, id), true);
    assert.equal(app.state().project.buffers[id]?.externalFileState.kind, externalWriter ? 'conflict' : 'current');
    assert.equal(app.state().dialogState?.kind, externalWriter ? 'externalConflict' : undefined);
    if (externalWriter) assert.equal(await app.saveBuffer(id), false);
    assert.equal(await readFile(file, 'utf8'), externalWriter ? 'external\n' : 'saved original\n');
  } finally {
    pause = false;
    release.resolve();
    await app.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

for (const action of ['overwriteDisk', 'recreate', 'reloadDisk'] as const) test(`completed ${action} cannot dismiss a newer dialog`, async () => {
  const { directory, file } = await fixture();
  const entered = deferred();
  const release = deferred();
  let pause = action !== 'reloadDisk';
  const app = createVellumApplication({
    watchFiles: false, persistenceDelayMilliseconds: 60000,
    recoveryStore: {
      filePath: path.join(directory, 'recovery.json'),
      async read() { return undefined; },
      async write() { if (pause) { entered.resolve(); await release.promise; } },
      async delete() {}, diagnostics() { return []; }
    }
  });
  try {
    const id = await app.openFile(file);
    insert(app, id, 'local ');
    if (action === 'recreate') await rm(file);
    else await writeFile(file, 'external\n');
    await app.checkExternalFile(id);
    const resolving = app.resolveExternalFileAction(action);
    if (action !== 'reloadDisk') await entered.promise;
    app.dispatchCommand('edit.find');
    const dialog = app.state().dialogState;
    assert.equal(dialog?.kind, 'documentSearch');
    pause = false;
    release.resolve();
    await resolving;
    assert.equal(app.state().project.buffers[id]?.externalFileState.kind, 'current');
    assert.equal(app.state().dialogState, dialog);
  } finally {
    pause = false;
    release.resolve();
    await app.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
