import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import test from 'node:test';
import { matchingTreeView } from '@ismail-elkorchi/terminal-ui/behavior';
import { createMemoryTerminalHost } from '@ismail-elkorchi/terminal-ui/host';
import { renderElementFrame, renderFramePlain } from '@ismail-elkorchi/terminal-ui/renderer';
import { createTuiRuntime } from '@ismail-elkorchi/terminal-ui/tui';
import { createVellumApplication, type VellumApplication, type VellumApplicationUpdate } from '../app/application.js';
import type { AppState, FileTreeNode, FileTreeState } from '../app/types.js';
import type { VellumMessage } from '../app/messages.js';
import { initialAppState } from '../commands/registry.js';
import { commitDirectoryNodes, createFileTreeState, reduceFileTree } from '../project/file-tree.js';
import { createVellumTui } from '../tui.js';
import { VELLUM_IDS, viewVellum } from '../view.js';

function projectSeed(count = 4_096): AppState {
  const root = '/virtual/project';
  const children: FileTreeNode[] = Array.from({ length: count }, (_, index) => {
    const label = `document-${String(index).padStart(5, '0')}.md`;
    return Object.freeze({
      id: `${root}/${label}`, path: `${root}/${label}`, label, kind: 'file',
      parentId: root, loaded: true, loading: false, children: Object.freeze([])
    });
  });
  const seed = initialAppState();
  return Object.freeze({
    ...seed,
    project: Object.freeze({
      ...seed.project, rootDirectory: root,
      fileTree: commitDirectoryNodes(createFileTreeState(root), root, children)
    })
  });
}

function waitForTree(application: VellumApplication): Promise<FileTreeState> {
  const current = application.state().project.fileTree;
  if (current.view !== null) return Promise.resolve(current);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error('File tree preparation did not publish a view.'));
    }, 10_000);
    const unsubscribe = application.subscribe((update) => {
      const tree = update.state.project.fileTree;
      if (tree.view === null) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(tree);
    });
  });
}

test('large tree preparation yields, publishes exact snapshots, and retains source and view across rendering and navigation', async () => {
  const host = createMemoryTerminalHost({ terminalSize: { columns: 100, rows: 24 } });
  const capabilities = await host.getCapabilities();
  const application = createVellumApplication({ watchFiles: false, initialState: projectSeed() });
  const updates: VellumApplicationUpdate[] = [];
  application.subscribe((update) => {
    assert.equal(update.state, application.state());
    assert.equal(update.revision, update.state.revision);
    updates.push(update);
  });
  try {
    const pending = application.state();
    const source = pending.project.fileTree.source;
    assert.equal(pending.project.fileTree.view, null);
    const render = (snapshot: AppState) => renderElementFrame(viewVellum(application, snapshot, {
      terminalSize: { columns: 100, rows: 24 }, capabilities
    }), { columns: 100, rows: 24 });
    assert.doesNotMatch(renderFramePlain(render(pending)), /document-00000/u);
    assert.equal(application.state(), pending);
    await nextTurn();
    assert.equal(application.state().project.fileTree.view, null, 'large preparation must yield before publication');
    const ready = await waitForTree(application);
    assert.equal(ready.source, source);
    assert.equal(ready.view?.collection.totalCount, 4_097);
    assert.equal(matchingTreeView(source, ready.interaction, ready.view), ready.view);
    assert.equal(updates.filter((update) => update.reason === 'fileTreeView').length, 1);
    assert.match(renderFramePlain(render(application.state())), /document-00000/u);
    const accepted = application.state();
    render(accepted);
    render(pending);
    assert.equal(application.state(), accepted, 'rendering current or queued snapshots must not schedule work');
    await application.applyFileTreeTransition({ kind: 'moveActive', delta: 1 });
    assert.equal(application.state().project.fileTree.source, source);
    assert.equal(application.state().project.fileTree.view, ready.view);
    assert.equal(application.state().project.fileTree.revision, ready.revision);
    assert.equal(application.state().project.fileTree.interaction.activeId, '/virtual/project/document-00000.md');
    application.openSource('Unrelated editor update');
    await nextTurn();
    assert.equal(application.state().project.fileTree.source, source);
    assert.equal(application.state().project.fileTree.view, ready.view);
  } finally {
    await application.dispose();
    await host.dispose();
  }
});

test('replacement filters, sorting and disclosure reject obsolete preparations and stale input', async () => {
  const application = createVellumApplication({ watchFiles: false, initialState: projectSeed() });
  try {
    const old = await waitForTree(application);
    const completions: FileTreeState[] = [];
    application.subscribe((update) => {
      if (update.reason === 'fileTreeView') completions.push(update.state.project.fileTree);
    });
    application.setProjectTreeFilter('document-0');
    const superseded = application.state().project.fileTree;
    assert.equal(superseded.view, null);
    assert.equal(reduceFileTree(superseded, { kind: 'moveActive', delta: 1 }), superseded);
    application.setProjectTreeFilter('document-000');
    application.cycleProjectTreeSort();
    application.cycleProjectTreeSort();
    await application.applyFileTreeTransition({ kind: 'collapse', id: '/virtual/project' });
    await application.applyFileTreeTransition({ kind: 'expand', id: '/virtual/project' });
    const desired = application.state().project.fileTree;
    const ready = await waitForTree(application);
    assert.equal(ready.source, desired.source);
    assert.notEqual(ready.source, old.source);
    assert.notEqual(ready.source, superseded.source);
    assert.equal(ready.view?.collection.totalCount, 101);
    assert.equal(ready.view?.collection.items[1]?.row.node.label, 'document-00099.md');
    assert.deepEqual(completions, [ready]);
    const current = application.state();
    await application.applyFileTreeTransition({ kind: 'collapse', id: '/virtual/project' }, undefined, old.revision);
    await application.activateFileTreeNode('/virtual/project/document-00000.md', undefined, old.revision);
    assert.equal(application.state(), current);
    assert.equal(application.state().project.bufferOrder.length, 0);
    await nextTurn();
    assert.equal(application.state(), current);
    await application.applyFileTreeTransition({ kind: 'collapse', id: '/virtual/project' });
    const collapsed = await waitForTree(application);
    assert.equal(collapsed.source, ready.source);
    const collapsedState = application.state();
    await application.applyFileTreeTransition({ kind: 'expand', id: '/virtual/project' }, undefined, ready.revision);
    assert.equal(application.state(), collapsedState, 'a stale expansion view is rejected even for the same source');
    assert.equal(collapsed.view?.collection.totalCount, 1);
  } finally { await application.dispose(); }
});

test('lazy IO stays lazy through filtering, then accepted directory contents replace the source and reach the existing TUI subscription', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vellum-prepared-tree-'));
  const lazy = path.join(directory, 'nested');
  await mkdir(lazy);
  await mkdir(path.join(directory, 'node_modules'));
  await writeFile(path.join(directory, 'keep.md'), '# Keep');
  await writeFile(path.join(directory, 'other.md'), '# Other');
  await writeFile(path.join(lazy, 'keep-child.md'), '# Child');
  const application = createVellumApplication({ watchFiles: false });
  const host = createMemoryTerminalHost({ terminalSize: { columns: 100, rows: 24 } });
  const runtime = createTuiRuntime({
    app: createVellumTui(application),
    host
  });
  try {
    await runtime.start();
    await application.openProjectDirectory(directory);
    const loaded = await waitForTree(application);
    assert.equal(loaded.nodes[lazy]?.loaded, false);
    assert.equal(loaded.nodes[path.join(directory, 'node_modules')], undefined);
    assert.equal(loaded.nodes[path.join(lazy, 'keep-child.md')], undefined);
    application.setProjectTreeFilter('keep');
    const filtered = await waitForTree(application);
    assert.equal(filtered.nodes[lazy]?.loaded, false);
    assert.deepEqual(filtered.view?.collection.items.map((item) => item.row.node.label), [path.basename(directory), 'nested', 'keep.md']);
    application.subscribe((update) => {
      const tree = update.state.project.fileTree;
      if (tree.nodes[lazy]?.loading === true) assert.equal(tree.source, filtered.source);
      if (tree.view !== null) assert.equal(matchingTreeView(tree.source, tree.interaction, tree.view), tree.view);
    });
    await application.applyFileTreeTransition({ kind: 'setActive', id: lazy });
    await application.applyFileTreeTransition({ kind: 'expand', id: lazy });
    const expanded = await waitForTree(application);
    assert.equal(expanded.nodes[lazy]?.loaded, true);
    assert.notEqual(expanded.source, filtered.source);
    assert.ok(expanded.view?.collection.items.some((item) => item.id === path.join(lazy, 'keep-child.md')));
    // The actual event source delivers accepted preparation without manual dispatch.
    const deadline = Date.now() + 5_000;
    while (runtime.state().project.fileTree.view !== expanded.view && Date.now() < deadline) {
      host.clock.advance(8);
      await nextTurn();
    }
    assert.equal(runtime.state().project.fileTree.view, expanded.view);
    assert.match(renderFramePlain(runtime.frame()!), /keep-child/u);
    await application.openProjectDirectory(directory);
    const reopened = await waitForTree(application);
    assert.ok(reopened.revision > expanded.revision, 'reopening a project must not recycle an input revision');
    const reopenedState = application.state();
    await application.applyFileTreeTransition({ kind: 'expand', id: lazy }, undefined, expanded.revision);
    assert.equal(application.state(), reopenedState);
    assert.equal(reopened.nodes[lazy]?.loaded, false);
  } finally {
    await runtime.dispose();
    await application.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('disposing during cooperative preparation cancels publication and keeps the last snapshot', async () => {
  const application = createVellumApplication({ watchFiles: false, initialState: projectSeed() });
  let completions = 0;
  application.subscribe((update) => { if (update.reason === 'fileTreeView') completions += 1; });
  const pending = application.state();
  await application.dispose();
  await nextTurn();
  await nextTurn();
  assert.equal(application.state(), pending);
  assert.equal(completions, 0);
  assert.equal(pending.project.fileTree.view, null);
});

test('tree key messages carry only a bounded projection revision rather than domain nodes or prepared rows', async () => {
  const application = createVellumApplication({ watchFiles: false, initialState: projectSeed(512) });
  const messages: Extract<VellumMessage, { readonly kind: 'fileTree' }>[] = [];
  const observed: VellumApplication = {
    ...application,
    update(message) {
      if (message.kind === 'fileTree') messages.push(message);
      return application.update(message);
    }
  };
  const runtime = createTuiRuntime({
    app: createVellumTui(observed),
    host: createMemoryTerminalHost({ terminalSize: { columns: 100, rows: 24 } }),
    initialFocus: { kind: 'element', elementId: VELLUM_IDS.fileTree }
  });
  try {
    const ready = await waitForTree(application);
    await runtime.start();
    await runtime.handleInputChunk({ data: '\u001b[B' });
    assert.equal(messages.length, 1);
    assert.deepEqual(messages[0], { kind: 'fileTree', transition: { kind: 'moveActive', delta: 1 }, treeRevision: ready.revision });
    assert.ok(JSON.stringify(messages[0]).length < 200);
  } finally {
    await runtime.dispose();
    await application.dispose();
  }
});
