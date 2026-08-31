import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createMemoryTerminalHost } from '@ismail-elkorchi/terminal-ui/host';
import { defaultTextWidthProfile, textDocumentText } from '@ismail-elkorchi/terminal-ui/text';
import { createTuiRuntime } from '@ismail-elkorchi/terminal-ui/tui';
import { createVellumApplication } from '../app/application.js';
import { builtInExportProfiles, type ExportProfile } from '../export/profiles.js';
import {
  createProjectDirectory,
  createProjectFile,
  duplicateProjectPath,
  executeProjectFileTransaction,
  moveProjectPath
} from '../files/project-operations.js';
import { importAssetFile } from '../files/assets.js';
import {
  buildProjectIndex,
  emptyProjectIndex,
  overlayOpenBuffers,
  updateProjectIndexPaths
} from '../project/index.js';
import { searchProjectDirectory } from '../search/project-directory-search.js';
import { createVellumTui } from '../tui.js';
import { markdownCompletions } from '../editing/completion.js';
import { languageToolProvider, WordDictionary } from '../diagnostics/service.js';
import { vellumBodyGeometry } from '../app/viewport-geometry.js';

test('project file transactions roll back in reverse commit order and expose rollback failures', async () => {
  const operations: string[] = [];
  await assert.rejects(executeProjectFileTransaction(async (transaction) => {
    operations.push('commit:first');
    transaction.addRollback(async () => { operations.push('rollback:first'); });
    operations.push('commit:second');
    transaction.addRollback(async () => { operations.push('rollback:second'); });
    throw new Error('commit failed');
  }), /commit failed/u);
  assert.deepEqual(operations, ['commit:first', 'commit:second', 'rollback:second', 'rollback:first']);

  await assert.rejects(executeProjectFileTransaction(async (transaction) => {
    transaction.addRollback(async () => { throw new Error('rollback failed'); });
    throw new Error('commit failed');
  }), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors.length, 2);
    assert.match(String(error.errors[0]), /commit failed/u);
    assert.match(String(error.errors[1]), /rollback failed/u);
    return true;
  });
});

test('project directories cannot be moved or duplicated inside themselves', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vellum-project-recursion-'));
  try {
    await mkdir(path.join(directory, 'source'));
    await writeFile(path.join(directory, 'source', 'note.md'), '# Note\n', 'utf8');
    await assert.rejects(moveProjectPath(directory, 'source', 'source/moved'), /inside itself/u);
    await assert.rejects(duplicateProjectPath(directory, 'source', 'source/copy'), /inside itself/u);
    assert.equal(await readFile(path.join(directory, 'source', 'note.md'), 'utf8'), '# Note\n');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('project moves commit path and source-exact link changes as one editor transaction', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vellum-project-move-'));
  const chapterPath = path.join(directory, 'docs', 'chapter.md');
  const targetPath = path.join(directory, 'target.md');
  const movedPath = path.join(directory, 'notes', 'target.md');
  await mkdir(path.dirname(chapterPath), { recursive: true });
  await mkdir(path.dirname(movedPath), { recursive: true });
  await writeFile(chapterPath, '# Chapter\n\n[Target](../target.md)\n', 'utf8');
  await writeFile(targetPath, '# Target\n', 'utf8');
  const application = createVellumApplication({ watchFiles: false });
  try {
    await application.openProjectDirectory(directory);
    await application.refreshFileTree();
    const chapterId = await application.openFile(chapterPath);
    const targetId = await application.openFile(targetPath);
    application.applyTextAreaTransition(targetId, {
      kind: 'edit', operation: { kind: 'insert', text: 'Draft ' }
    });

    await application.moveProjectEntry('target.md', 'notes/target.md');

    assert.equal(await readFile(chapterPath, 'utf8'), '# Chapter\n\n[Target](../notes/target.md)\n');
    assert.equal(await readFile(movedPath, 'utf8'), '# Target\n');
    assert.equal(application.state().project.buffers[targetId]?.path, movedPath);
    assert.equal(textDocumentText(application.state().project.buffers[targetId]?.editor.document as never), 'Draft # Target\n');
    assert.equal(application.state().project.buffers[targetId]?.savedRevision, 0);
    assert.equal(textDocumentText(application.state().project.buffers[chapterId]?.editor.document as never), '# Chapter\n\n[Target](../notes/target.md)\n');
    assert.equal(application.state().project.buffers[chapterId]?.savedRevision, application.state().project.buffers[chapterId]?.sourceRevision);
    await assert.rejects(readFile(targetPath, 'utf8'), /ENOENT/u);
  } finally {
    await application.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('project moves reject a stale indexed link document before changing the filesystem', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vellum-project-stale-move-'));
  const chapterPath = path.join(directory, 'chapter.md');
  const targetPath = path.join(directory, 'target.md');
  const movedPath = path.join(directory, 'moved.md');
  await writeFile(chapterPath, '[Target](./target.md)\n', 'utf8');
  await writeFile(targetPath, '# Target\n', 'utf8');
  const application = createVellumApplication({ watchFiles: false });
  try {
    await application.openProjectDirectory(directory);
    await application.refreshFileTree();
    await writeFile(chapterPath, 'external change\n[Target](./target.md)\n', 'utf8');
    await assert.rejects(application.moveProjectEntry('target.md', 'moved.md'), /index is stale/u);
    assert.equal(await readFile(targetPath, 'utf8'), '# Target\n');
    assert.equal(await readFile(chapterPath, 'utf8'), 'external change\n[Target](./target.md)\n');
    await assert.rejects(readFile(movedPath, 'utf8'), /ENOENT/u);
  } finally {
    await application.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('the maintained index honors ignore files, filters document types, reuses revisions, and overlays live buffers', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vellum-project-index-'));
  await mkdir(path.join(directory, 'nested'), { recursive: true });
  await mkdir(path.join(directory, 'assets'), { recursive: true });
  await writeFile(path.join(directory, '.gitignore'), '/ignored.md\n', 'utf8');
  await writeFile(path.join(directory, 'nested', '.ignore'), 'skip.md\n', 'utf8');
  await writeFile(path.join(directory, 'keep.md'), '---\nstatus: draft\n---\n# Keep\n\n- [ ] task\n#tag [@cite]\n[Nested](nested/keep.markdown)\n', 'utf8');
  await writeFile(path.join(directory, 'ignored.md'), '# Ignored\n', 'utf8');
  await writeFile(path.join(directory, 'nested', 'keep.markdown'), '# Nested\n\nneedle\n', 'utf8');
  await writeFile(path.join(directory, 'nested', 'skip.md'), '# Skip\n', 'utf8');
  await writeFile(path.join(directory, 'notes.txt'), 'not Markdown', 'utf8');
  await writeFile(path.join(directory, 'binary.md'), new Uint8Array([0, 1, 2]));
  await writeFile(path.join(directory, 'large.md'), 'x'.repeat(200));
  await writeFile(path.join(directory, 'assets', 'image.png'), new Uint8Array([1, 2, 3]));

  try {
    const first = await buildProjectIndex(directory, emptyProjectIndex(), { maximumFileBytes: 180 });
    const relative = first.state.orderedPaths.map((filePath) => path.relative(directory, filePath).replaceAll(path.sep, '/'));
    assert.deepEqual(relative, ['keep.md', 'nested/keep.markdown']);
    assert.deepEqual(first.state.assetPaths, [path.join(directory, 'assets', 'image.png')]);
    const keep = first.state.documents[path.join(directory, 'keep.md')];
    assert.deepEqual(keep?.properties, { status: 'draft' });
    assert.deepEqual(keep?.taskStates, [false]);
    assert.deepEqual(keep?.tags, ['tag']);
    assert.deepEqual(keep?.citationKeys, ['cite']);

    const second = await buildProjectIndex(directory, first.state, { maximumFileBytes: 180 });
    assert.equal(second.state.documents[path.join(directory, 'keep.md')], keep);
    const included = await buildProjectIndex(directory, emptyProjectIndex(), {
      maximumFileBytes: 180,
      includePatterns: ['nested/**']
    });
    assert.deepEqual(included.state.orderedPaths, [path.join(directory, 'nested', 'keep.markdown')]);

    const nestedPath = path.join(directory, 'nested', 'keep.markdown');
    const live = overlayOpenBuffers(second.state, [{ path: nestedPath, source: '# Live heading\n\nunsaved needle\n' }]);
    assert.notEqual(live.documents[nestedPath], second.state.documents[nestedPath]);
    const batches: number[] = [];
    const results = await searchProjectDirectory(live, 'path:nested/** heading:"Live heading" "unsaved needle"', {
      maximumResults: 10,
      onBatch: (batch) => batches.push(batch.length)
    }, new AbortController().signal);
    assert.equal(results.length, 1);
    assert.equal(results[0]?.path, nestedPath);
    assert.deepEqual(batches, [1]);
    const withoutNestedLink = await searchProjectDirectory(live, '-link:nested/keep.markdown', {
      maximumResults: 10,
      sort: 'modified'
    }, new AbortController().signal);
    assert.equal(withoutNestedLink.some((result) => result.path === path.join(directory, 'keep.md')), false);
    assert.equal(withoutNestedLink.some((result) => result.path === nestedPath), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('project index watcher updates are path-scoped and request traversal only for structural changes', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vellum-project-index-delta-'));
  const firstPath = path.join(directory, 'first.md');
  const secondPath = path.join(directory, 'second.md');
  const addedPath = path.join(directory, 'added.md');
  const assetPath = path.join(directory, 'asset.webp');
  await writeFile(firstPath, new Uint8Array([0xef, 0xbb, 0xbf, ...Buffer.from('# First\n', 'utf8')]));
  await writeFile(secondPath, '# Second\n', 'utf8');
  try {
    const initial = (await buildProjectIndex(directory, emptyProjectIndex())).state;
    const untouched = initial.documents[secondPath];
    assert.equal(initial.documents[firstPath]?.headings[0]?.text, 'First');
    assert.equal(initial.documents[firstPath]?.searchableText.startsWith('\ufeff'), false);

    await writeFile(firstPath, '# Changed heading\n\nchanged body\n', 'utf8');
    const changed = await updateProjectIndexPaths(directory, initial, [firstPath]);
    assert.ok(changed);
    assert.equal(changed.documents[firstPath]?.headings[0]?.text, 'Changed heading');
    assert.equal(changed.documents[secondPath], untouched);

    await writeFile(addedPath, '# Added\n', 'utf8');
    await writeFile(assetPath, new Uint8Array([1, 2, 3]));
    const added = await updateProjectIndexPaths(directory, changed, [addedPath, assetPath]);
    assert.ok(added);
    assert.equal(added.orderedPaths.includes(addedPath), true);
    assert.equal(added.assetPaths.includes(assetPath), true);

    await rm(secondPath);
    await rm(assetPath);
    const removed = await updateProjectIndexPaths(directory, added, [secondPath, assetPath]);
    assert.ok(removed);
    assert.equal(removed.documents[secondPath], undefined);
    assert.equal(removed.assetPaths.includes(assetPath), false);

    assert.equal(await updateProjectIndexPaths(directory, removed, [directory]), undefined);
    const ignorePath = path.join(directory, '.gitignore');
    await writeFile(ignorePath, 'added.md\n', 'utf8');
    assert.equal(await updateProjectIndexPaths(directory, removed, [ignorePath]), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('unrelated TUI operation domains overlap without cancelling one another', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vellum-operation-domains-'));
  const sourcePath = path.join(directory, 'document.md');
  const scriptPath = path.join(directory, 'slow-export.mjs');
  const outputPath = path.join(directory, 'document.slow');
  await writeFile(sourcePath, '# Concurrent export\n', 'utf8');
  await writeFile(scriptPath, [
    "import { readFile, writeFile } from 'node:fs/promises';",
    "const output = process.argv[process.argv.indexOf('--output') + 1];",
    "const input = process.argv.at(-1);",
    'await new Promise((resolve) => setTimeout(resolve, 150));',
    "await writeFile(output, await readFile(input, 'utf8'), 'utf8');"
  ].join('\n'), 'utf8');
  const profile: ExportProfile = Object.freeze({
    ...(builtInExportProfiles[0] as ExportProfile),
    id: 'slow-test',
    label: 'Slow test',
    outputExtension: '.slow',
    executable: process.execPath,
    arguments: Object.freeze([scriptPath])
  });
  const application = createVellumApplication({ watchFiles: false, exportProfiles: [profile] });
  const runtime = createTuiRuntime({
    app: createVellumTui(application),
    host: createMemoryTerminalHost()
  });
  try {
    await application.openProjectDirectory(directory);
    await application.openFile(sourcePath);
    await runtime.start();
    await runtime.dispatch({ kind: 'command', commandId: 'export.activeBuffer' });
    await runtime.dispatch({ kind: 'submitExportProfile', value: profile.id });
    await runtime.dispatch({ kind: 'checkExternalFiles' });
    await waitUntil(() => application.state().exports.history[0]?.status === 'succeeded');
    assert.equal(await readFile(outputPath, 'utf8'), '# Concurrent export\n');
    assert.equal(application.state().exports.history[0]?.profileId, profile.id);
    assert.equal(application.state().project.buffers[application.state().project.activeBufferId as string]?.externalFileState.kind, 'current');
  } finally {
    await runtime.dispose();
    await application.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('contextual completion returns exact source replacement ranges across Markdown contexts', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vellum-completion-'));
  const targetPath = path.join(directory, 'target.md');
  await writeFile(targetPath, [
    '---', 'status: draft', '---', '# Deep Heading', '', 'Text with #known and [@citation].', '', '[reference]: ./target.md'
  ].join('\n'), 'utf8');
  try {
    const index = (await buildProjectIndex(directory, emptyProjectIndex())).state;
    const cases = [
      { source: '```typ', label: 'typescript', replacement: 'typescript', query: 'typ' },
      { source: '> [!war', label: 'warning', replacement: 'warning', query: 'war' },
      { source: '[link](target#Dee', label: 'Deep Heading', replacement: 'deep-heading', query: 'Dee' },
      { source: '[link][ref', label: 'reference', replacement: 'reference', query: 'ref' },
      { source: '#kno', label: 'known', replacement: 'known', query: 'kno' },
      { source: '[@cit', label: 'citation', replacement: 'citation', query: 'cit' },
      { source: '::tab', label: 'table', replacement: '| Column | Column |\n| --- | --- |\n| Value | Value |', query: '::tab' }
    ] as const;
    for (const entry of cases) {
      const application = createVellumApplication({ watchFiles: false });
      try {
        const id = application.openSource(entry.source);
        application.applyTextAreaTransition(id, {
          kind: 'pointer', transition: { kind: 'placeCaret', offset: entry.source.length }
        });
        const buffer = application.state().project.buffers[id];
        assert.ok(buffer);
        const completion = markdownCompletions(buffer, index).find((candidate) => candidate.label === entry.label);
        assert.ok(completion, `${entry.label} completion was missing`);
        assert.equal(completion.replacement, entry.replacement);
        assert.equal(entry.source.slice(completion.range.start, completion.range.end), entry.query);
      } finally {
        await application.dispose();
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('unified diagnostics report prose, spelling, broken links, and assets with applicable exact fixes', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vellum-diagnostics-'));
  const documentPath = path.join(directory, 'document.md');
  const source = 'hello hello  \n\n[missing](missing.md) ![asset](missing.png) mispelled\n';
  await writeFile(documentPath, source, 'utf8');
  const dictionary = WordDictionary.fromWords(['hello', 'missing', 'asset']);
  const application = createVellumApplication({ watchFiles: false, wordDictionary: dictionary });
  try {
    await application.openProjectDirectory(directory);
    await application.refreshFileTree();
    const id = await application.openFile(documentPath);
    await application.refreshDiagnostics(id);
    const diagnostics = application.state().diagnostics[id] ?? [];
    assert.equal(diagnostics.some((diagnostic) => diagnostic.rule === 'markdown.trailingWhitespace'), true);
    assert.equal(diagnostics.some((diagnostic) => diagnostic.rule === 'markdown.repeatedWord'), true);
    assert.equal(diagnostics.some((diagnostic) => diagnostic.source === 'spelling' && diagnostic.message.includes('mispelled')), true);
    assert.equal(diagnostics.some((diagnostic) => diagnostic.source === 'links' && diagnostic.message.includes('missing.md')), true);
    assert.equal(diagnostics.some((diagnostic) => diagnostic.source === 'assets' && diagnostic.message.includes('missing.png')), true);
    assert.equal(diagnostics.some((diagnostic) => diagnostic.source === 'spelling' && /Unknown word: (md|png)/u.test(diagnostic.message)), false);
    const trailing = diagnostics.find((diagnostic) => diagnostic.rule === 'markdown.trailingWhitespace');
    assert.ok(trailing);
    application.applyDiagnosticFix(id, trailing.id);
    assert.equal(textDocumentText(application.state().project.buffers[id]?.editor.document as never).startsWith('hello hello\n'), true);
  } finally {
    await application.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('external grammar diagnostics accept only source-bounded exact spans', async () => {
  const application = createVellumApplication({ watchFiles: false });
  try {
    const id = application.openSource('hello world');
    const buffer = application.state().project.buffers[id];
    assert.ok(buffer);
    const provider = languageToolProvider({
      endpoint: new URL('http://127.0.0.1:8081/v2/check'),
      language: 'en',
      async fetch() {
        return new Response(JSON.stringify({
          matches: [
            { offset: -1, length: 2, message: 'negative' },
            { offset: 8, length: 20, message: 'past end' },
            { offset: 6, length: 5, message: 'valid', replacements: [{ value: 'earth' }] }
          ]
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
    });
    const diagnostics = await provider.diagnose(buffer, emptyProjectIndex(), buffer.sourceRevision);
    assert.deepEqual(diagnostics.map((diagnostic) => ({ message: diagnostic.message, span: diagnostic.span })), [
      { message: 'valid', span: { start: 6, end: 11 } }
    ]);
    assert.deepEqual(diagnostics[0]?.fixes[0]?.span, { start: 6, end: 11 });
  } finally {
    await application.dispose();
  }
});

test('project file management and asset workflows remain inside the maintained workspace model', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vellum-file-manager-'));
  const sourceDirectory = await mkdtemp(path.join(os.tmpdir(), 'vellum-asset-source-'));
  const importedSource = path.join(sourceDirectory, 'source.png');
  await writeFile(path.join(directory, 'README.md'), '# Workspace\n', 'utf8');
  await writeFile(importedSource, new Uint8Array([1, 2, 3, 4]));
  const application = createVellumApplication({ watchFiles: false });
  try {
    await application.openProjectDirectory(directory);
    const notesDirectory = await application.createProjectDirectory('notes');
    assert.equal(notesDirectory, path.join(directory, 'notes'));
    const documentId = await application.createProjectFile('notes/draft.md', '# Draft\n');
    await application.duplicateProjectEntry('notes/draft.md', 'notes/copy.md');
    assert.equal(await readFile(path.join(directory, 'notes', 'copy.md'), 'utf8'), '# Draft\n');

    application.setProjectTreeFilter('draft');
    assert.equal(application.state().project.fileTree.filter, 'draft');
    const initialSort = application.state().project.fileTree.sort;
    application.cycleProjectTreeSort();
    assert.notEqual(application.state().project.fileTree.sort, initialSort);
    application.toggleProjectPin();
    assert.deepEqual(application.state().project.pinnedProjects, [directory]);

    application.activateBuffer(documentId);
    const imported = await application.importProjectAsset(importedSource);
    assert.equal(imported, path.join(directory, 'assets', 'source.png'));
    assert.match(textDocumentText(application.state().project.buffers[documentId]?.editor.document as never), /!\[source\]\(\.\.\/assets\/source\.png\)/u);
    assert.deepEqual(await application.refreshUnusedAssets(), []);

    const unused = path.join(directory, 'assets', 'unused.gif');
    await writeFile(unused, new Uint8Array([5, 6, 7]));
    await application.refreshFileTree();
    assert.deepEqual(await application.refreshUnusedAssets(), [unused]);
  } finally {
    await application.dispose();
    await rm(directory, { recursive: true, force: true });
    await rm(sourceDirectory, { recursive: true, force: true });
  }
});

test('project mutations reject symlinked ancestors that escape the workspace', {
  skip: process.platform === 'win32' ? 'Creating test symlinks requires elevated privileges on Windows.' : false
}, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vellum-contained-project-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'vellum-outside-project-'));
  const sourcePath = path.join(directory, 'source.md');
  const assetPath = path.join(outside, 'asset.png');
  try {
    await writeFile(sourcePath, '# Source\n', 'utf8');
    await writeFile(assetPath, new Uint8Array([1, 2, 3]));
    await symlink(outside, path.join(directory, 'escape'), 'dir');
    await assert.rejects(createProjectFile(directory, 'escape/new.md'), /outside the project root/u);
    await assert.rejects(createProjectDirectory(directory, 'escape/new-directory'), /outside the project root/u);
    await assert.rejects(moveProjectPath(directory, 'source.md', 'escape/moved.md'), /outside the project root/u);
    await assert.rejects(duplicateProjectPath(directory, 'source.md', 'escape/copy.md'), /outside the project root/u);
    await assert.rejects(importAssetFile(directory, assetPath, 'escape/assets'), /outside the project root/u);
    assert.equal(await readFile(sourcePath, 'utf8'), '# Source\n');
    await assert.rejects(readFile(path.join(outside, 'new.md')), /ENOENT/u);
    await assert.rejects(readFile(path.join(outside, 'moved.md')), /ENOENT/u);
    await assert.rejects(readFile(path.join(outside, 'copy.md')), /ENOENT/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('focus, typewriter, and distraction-free writing modes alter the editor at their owning boundaries', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vellum-writing-modes-'));
  const source = Array.from({ length: 80 }, (_, index) => `Paragraph ${String(index + 1)}.\n`).join('\n');
  const documentPath = path.join(directory, 'long.md');
  await writeFile(documentPath, source, 'utf8');
  const application = createVellumApplication({ watchFiles: false });
  try {
    await application.openProjectDirectory(directory);
    const id = await application.openFile(documentPath);
    application.dispatchCommand('view.editorHybrid');
    const ordinaryDecorationCount = application.hybridDecorations(id).count;
    application.dispatchCommand('view.toggleFocusMode');
    assert.equal(application.state().writingMode.focus, true);
    assert.equal(application.hybridDecorations(id).count > ordinaryDecorationCount, true);

    application.resizeTerminal(
      Object.freeze({ columns: 80, rows: 24 }),
      Object.freeze({ columns: 120, rows: 30 }),
      defaultTextWidthProfile
    );
    assert.equal(vellumBodyGeometry(application.state(), { columns: 120, rows: 30 }).fileTreeWidth > 0, true);
    application.dispatchCommand('view.toggleTypewriterMode');
    application.applyTextAreaTransition(id, {
      kind: 'pointer', transition: { kind: 'placeCaret', offset: source.length }
    });
    assert.equal((application.state().project.buffers[id]?.editor.scroll.offsetRow ?? 0) > 0, true);

    application.dispatchCommand('view.toggleDistractionFreeMode');
    assert.equal(vellumBodyGeometry(application.state(), { columns: 120, rows: 30 }).fileTreeWidth, 0);
  } finally {
    await application.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('preview resources are shared across buffers and remain bounded at workspace scope', async () => {
  const application = createVellumApplication({
    watchFiles: false,
    highlightSettings: { maximumCacheEntries: 2 },
    mathSettings: { maximumCacheEntries: 2 }
  });
  try {
    const sharedSource = '```javascript\nconst shared = true;\n```\n\n$\\frac{1}{2}$\n';
    const first = application.openSource(sharedSource, 'first.md');
    const second = application.openSource(sharedSource, 'second.md');
    await application.refreshPreviewResources(first);
    await application.refreshPreviewResources(second);
    assert.equal(application.previewResourceStats().highlighting.cacheEntries, 1);
    assert.equal(application.previewResourceStats().math.cacheEntries, 1);

    for (let index = 0; index < 3; index += 1) {
      const id = application.openSource(
        `\`\`\`javascript\nconst value = ${String(index)};\n\`\`\`\n\n$x_${String(index)}$\n`,
        `unique-${String(index)}.md`
      );
      await application.refreshPreviewResources(id);
    }
    const stats = application.previewResourceStats();
    assert.equal(stats.highlighting.cacheEntries, 2);
    assert.equal(stats.math.cacheEntries, 2);
  } finally {
    await application.dispose();
  }
});

async function waitUntil(predicate: () => boolean, timeoutMilliseconds = 3_000): Promise<void> {
  const started = performance.now();
  while (!predicate()) {
    if (performance.now() - started > timeoutMilliseconds) throw new Error('Timed out waiting for application state.');
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}
