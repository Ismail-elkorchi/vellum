import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createMarkdownPreviewEngine,
  markdownPreviewSource
} from '../markdown/preview.js';

test('stale preview work cannot roll the active parser session backward', () => {
  const engine = createMarkdownPreviewEngine();
  engine.open(1, 0, '# First');
  const latestRevision = engine.update(1, 2, '# First\n\nLatest');

  assert.equal(engine.update(1, 1, '# First\n\nStale'), latestRevision);
  assert.equal(markdownPreviewSource(latestRevision), '# First\n\nLatest');

  const nextDocument = engine.open(2, 0, '# Second');
  assert.equal(engine.update(1, 3, '# Obsolete'), nextDocument);
  assert.equal(markdownPreviewSource(nextDocument), '# Second');
});

test('a source revision identifies exactly one text snapshot', () => {
  const engine = createMarkdownPreviewEngine();
  engine.open(4, 7, 'original');
  assert.throws(
    () => engine.update(4, 7, 'different'),
    /source revision cannot identify different Markdown text/u
  );
});
