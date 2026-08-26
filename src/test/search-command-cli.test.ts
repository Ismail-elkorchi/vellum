import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { textDocumentText } from '@ismail-elkorchi/terminal-ui/text';
import { parseCliArguments, commandHelp } from '../cli-options.js';
import { commandPaletteEntries } from '../commands/palette.js';
import { defaultKeymap, parseKeyBinding, validateKeymap } from '../commands/keymap.js';
import { initialAppState } from '../commands/registry.js';
import { findDocumentMatches, replacementChangeSet } from '../search/document-search.js';
import { createVellumApplication } from '../app/application.js';
import { quickOpenEntries } from '../project/quick-open.js';

test('CLI definitions parse POSIX, Windows, stdin, presentation, line, and export forms', () => {
  assert.deepEqual(parseCliArguments(['README.md', '--line', '72', '--hybrid']), {
    kind: 'open', path: 'README.md', line: 72, editorMode: 'hybrid', paneArrangement: 'editor', help: false
  });
  assert.equal((parseCliArguments(['C:\\docs\\README.md', '--preview']) as { path?: string }).path, 'C:\\docs\\README.md');
  assert.equal((parseCliArguments(['\\\\server\\share\\README.md']) as { path?: string }).path, '\\\\server\\share\\README.md');
  assert.equal((parseCliArguments(['-', '--source']) as { path?: string }).path, '-');
  assert.deepEqual(parseCliArguments(['export', 'README.md', '--profile', 'html', '--output', 'site.html']), {
    kind: 'export', path: 'README.md', profileId: 'html', outputPath: 'site.html', overwrite: false, help: false
  });
  assert.throws(() => parseCliArguments(['--line', '0']), /positive/u);
  assert.throws(() => parseCliArguments(['--preview', '--hybrid']), /conflict/u);
  assert.throws(() => parseCliArguments(['--unknown']), /Unknown/u);
  assert.match(commandHelp(), /vellum export/u);
});

test('document search uses UTF-16 spans, validates expressions, and returns ordered exact replacement changes', () => {
  const source = '😀 alpha ALPHA alphabet alpha';
  const result = findDocumentMatches(source, 'alpha', { wholeWord: true }, 'β');
  assert.deepEqual(result.matches.map((match) => [match.start, match.end]), [[3, 8], [9, 14], [24, 29]]);
  const changeSet = replacementChangeSet(result);
  assert.deepEqual(changeSet.changes.map((change) => change.insertedText), ['β', 'β', 'β']);
  const invalid = findDocumentMatches(source, '[', { regularExpression: true }, 'never');
  assert.ok(invalid.error);
  assert.throws(() => replacementChangeSet(invalid), /character class|unterminated/iu);
});

test('keymap validation reports malformed, unknown, duplicate, and conflicting entries', () => {
  assert.equal(parseKeyBinding('Ctrl+ArrowUp').key, 'arrowUp');
  assert.equal(defaultKeymap().diagnostics.length, 0);
  const result = validateKeymap([
    { command: 'file.new', key: 'ctrl+n' },
    { command: 'file.open', key: 'ctrl+n' },
    { command: 'missing.command', key: 'ctrl+x' },
    { command: 'file.save', key: 'ctrl+?' }
  ]);
  assert.equal(result.entries.length, 1);
  assert.equal(result.diagnostics.length, 3);
});

test('command palette keeps disabled commands visible and ranks fuzzy title matches', () => {
  const entries = commandPaletteEntries(initialAppState(), 'save');
  const save = entries.find((entry) => entry.commandId === 'file.save');
  assert.equal(save?.enabled, false);
  assert.equal(entries[0]?.commandId, 'file.save');
  assert.ok(entries.every((entry) => entry.category.length > 0));
});

test('document Replace All applies one exact multi-range change set and one undo entry', async () => {
  const application = createVellumApplication({ watchFiles: false, createBufferId: () => 'search' });
  try {
    const id = application.openSource('alpha 😀 alpha alphabet alpha');
    application.dispatchCommand('edit.replace');
    application.updateDocumentSearch('query', { kind: 'setValue', value: 'alpha' });
    application.configureDocumentSearch('wholeWord');
    application.updateDocumentSearch('replacement', { kind: 'setValue', value: 'β' });
    application.replaceDocumentSearch('all');
    const changed = application.state().project.buffers[id];
    assert.equal(textDocumentText(changed?.editor.document as never), 'β 😀 β alphabet β');
    assert.equal(changed?.editor.history.undo.length, 1);
    assert.deepEqual(changed?.preview.kind === 'ready' ? changed.preview.update?.changedOldSpan : undefined, { start: 0, end: 29 });
    application.executeMarkdownCommand(id, 'edit.undo');
    assert.equal(textDocumentText(application.state().project.buffers[id]?.editor.document as never), 'alpha 😀 alpha alphabet alpha');
  } finally {
    await application.dispose();
  }
});

test('project-directory search opens a result and selects its exact UTF-16 source span', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vellum-project-directory-search-'));
  try {
    await mkdir(path.join(directory, 'nested'));
    await mkdir(path.join(directory, '.git'));
    await writeFile(path.join(directory, 'a.md'), 'first needle\n', 'utf8');
    await writeFile(path.join(directory, 'b.md'), '😀 second needle\n', 'utf8');
    await writeFile(path.join(directory, 'nested', 'c.md'), 'nested needle\n', 'utf8');
    await writeFile(path.join(directory, '.git', 'ignored.md'), 'ignored needle\n', 'utf8');
    await writeFile(path.join(directory, 'binary.md'), Buffer.from([0, 1, 2]));
    const application = createVellumApplication({ watchFiles: false, createBufferId: (() => {
      let value = 0;
      return () => `project-${String(value++)}`;
    })() });
    try {
      await application.openProjectDirectory(directory);
      application.dispatchCommand('file.searchProjectDirectory');
      application.updateProjectDirectorySearch({ kind: 'setValue', value: 'needle' });
      await application.runProjectDirectorySearch({}, new AbortController().signal);
      const dialog = application.state().dialogState;
      assert.equal(dialog?.kind, 'projectDirectorySearch');
      if (dialog?.kind !== 'projectDirectorySearch') return;
      assert.deepEqual(dialog.results.map((result) => [path.basename(result.path), result.line, result.column]), [
        ['a.md', 1, 7], ['b.md', 1, 11], ['c.md', 1, 8]
      ]);
      assert.equal(quickOpenEntries(application.state().project.fileTree, 'c.md', []).at(0)?.relativePath, path.join('nested', 'c.md'));
      await application.activateProjectDirectorySearchResult(1);
      const buffer = application.state().project.buffers[application.state().project.activeBufferId as string];
      assert.equal(buffer?.editor.selection?.anchor.offset, 10);
      assert.equal(buffer?.editor.selection?.focus.offset, 16);
    } finally {
      await application.dispose();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
