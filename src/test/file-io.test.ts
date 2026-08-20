import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ensureMarkdownExtension,
  loadMarkdownPath,
  openMarkdownFile,
  saveMarkdownFile
} from '../file-io.js';

test('Markdown paths gain a .md extension without changing existing case-insensitive extensions', () => {
  assert.equal(ensureMarkdownExtension('notes'), 'notes.md');
  assert.equal(ensureMarkdownExtension('notes.md'), 'notes.md');
  assert.equal(ensureMarkdownExtension('NOTES.MD'), 'NOTES.MD');
  assert.equal(ensureMarkdownExtension('   '), '');
});

test('saving creates parent directories and opening returns the same UTF-8 document', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vellum-file-io-'));
  try {
    const target = path.join(directory, 'nested', 'document');
    const text = '# Vellum\n\n東京 café ✅\n';
    const saved = await saveMarkdownFile(target, text, new AbortController().signal);

    assert.equal(saved.path, path.join(directory, 'nested', 'document.md'));
    assert.equal(saved.label, 'document.md');
    assert.equal(await readFile(saved.path, 'utf8'), text);

    const opened = await openMarkdownFile(target, new AbortController().signal);
    assert.equal(opened.path, saved.path);
    assert.equal(opened.label, 'document.md');
    assert.equal(opened.text, text);
    assert.equal(loadMarkdownPath(target), saved.path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('opening a missing document returns a path-specific error', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vellum-missing-'));
  try {
    const target = path.join(directory, 'missing');
    await assert.rejects(
      openMarkdownFile(target, new AbortController().signal),
      (error: unknown) => error instanceof Error
        && error.message.includes(path.join(directory, 'missing.md'))
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
