import assert from 'node:assert/strict';
import test from 'node:test';
import { textDocumentText } from '@ismail-elkorchi/terminal-ui/text';
import { createVellumApplication } from '../app/application.js';
import { findDocumentMatches } from '../search/document-search.js';

type Application = ReturnType<typeof createVellumApplication>;

const pairs = [
  ['(', ')'], ['[', ']'], ['*', '*'], ['**', '**'],
  ['_', '_'], ['__', '__'], ['`', '`']
] as const;

for (const [opening, closing] of pairs) {
  const prefix = '😀 é\r\nhello ';
  const source = `${prefix}${opening}${closing} world`;
  const middle = prefix.length + opening.length;
  const selections = [
    { name: 'selection ending inside the pair', anchor: 0, offset: middle },
    { name: 'reverse selection ending inside the pair', anchor: source.length, offset: middle },
    { name: 'selection enclosing the pair', anchor: prefix.length, offset: middle + closing.length },
    { name: 'reverse selection enclosing the pair', anchor: middle + closing.length, offset: prefix.length }
  ];
  for (const { name, anchor, offset } of selections) {
    test(`Backspace deletes the ${name} for ${opening}${closing}`, async () => {
      const application = createVellumApplication({ watchFiles: false });
      try {
        const id = application.openSource(source);
        application.applyTextAreaTransition(id, {
          kind: 'pointer', transition: { kind: 'endSelection', anchor, offset }
        });
        application.applyTextAreaTransition(id, { kind: 'edit', operation: { kind: 'deleteBackward' } });
        const expected = source.slice(0, Math.min(anchor, offset)) + source.slice(Math.max(anchor, offset));
        assertUndoRedo(application, id, source, expected);
      } finally {
        await application.dispose();
      }
    });
  }

  for (const collapsedSelection of [false, true]) {
    test(`Backspace deletes empty ${opening}${closing} with ${collapsedSelection ? 'a collapsed selection' : 'a caret'}`, async () => {
      const application = createVellumApplication({ watchFiles: false });
      try {
        const id = application.openSource(source);
        application.applyTextAreaTransition(id, {
          kind: 'pointer', transition: collapsedSelection
            ? { kind: 'endSelection', anchor: middle, offset: middle }
            : { kind: 'placeCaret', offset: middle }
        });
        application.applyTextAreaTransition(id, { kind: 'edit', operation: { kind: 'deleteBackward' } });
        assert.equal(application.state().project.buffers[id]?.editor.caret.position.offset, prefix.length);
        assertUndoRedo(application, id, source, `${prefix} world`);
      } finally {
        await application.dispose();
      }
    });
  }
}

const literalReplacements = ['$1', '$12', '$&', '$$', '$`', "$'", '$<name>', 'before $1 $$ $& after'];

test('literal search preserves every replacement token without regex expansion', () => {
  for (const options of [{}, { regularExpression: false }]) {
    for (const replacement of literalReplacements) {
      const result = findDocumentMatches('abc 😀 abc', 'abc', options, replacement);
      assert.deepEqual(result.matches.map((match) => match.replacementText), [replacement, replacement]);
    }
  }
});

for (const scope of ['current', 'all'] as const) {
  for (const replacement of literalReplacements) {
    test(`literal Replace ${scope} preserves ${JSON.stringify(replacement)} and exact undo/redo`, async () => {
      const application = createVellumApplication({ watchFiles: false });
      try {
        const source = 'abc 😀 é\r\nabc tail';
        const id = application.openSource(source);
        application.dispatchCommand('edit.replace');
        application.updateDocumentSearch('query', { kind: 'setValue', value: 'abc' });
        application.updateDocumentSearch('replacement', { kind: 'setValue', value: replacement });
        application.replaceDocumentSearch(scope);
        const expected = `${replacement} 😀 é\r\n${scope === 'all' ? replacement : 'abc'} tail`;
        assertUndoRedo(application, id, source, expected);
      } finally {
        await application.dispose();
      }
    });
  }

  test(`regex Replace ${scope} expands captures and tokens through the normal undo/redo path`, async () => {
    const application = createVellumApplication({ watchFiles: false });
    try {
      const source = '😀 a-1\r\nbb-22 tail';
      const id = application.openSource(source);
      application.dispatchCommand('edit.replace');
      application.configureDocumentSearch('regularExpression');
      application.updateDocumentSearch('query', { kind: 'setValue', value: '\\b([a-z]+)-(\\d+)\\b' });
      application.updateDocumentSearch('replacement', { kind: 'setValue', value: '$2:$1/$$/$&' });
      application.replaceDocumentSearch(scope);
      const expected = `😀 1:a/$/a-1\r\n${scope === 'all' ? '22:bb/$/bb-22' : 'bb-22'} tail`;
      assertUndoRedo(application, id, source, expected);
    } finally {
      await application.dispose();
    }
  });
}

test('regex search retains prefix, suffix, whole-match and optional capture replacement semantics', () => {
  const result = findDocumentMatches('before a after', '(a)(b)?', {
    regularExpression: true,
    wholeWord: true
  }, "$`|$&|$1|$2|$'|$$");
  assert.deepEqual(result.matches.map((match) => match.replacementText), ['before |a|a|| after|$']);
});

function assertUndoRedo(application: Application, id: string, before: string, after: string): void {
  assertSource(application, id, after);
  assert.equal(application.state().project.buffers[id]?.editor.history.undo.length, 1);
  application.executeMarkdownCommand(id, 'edit.undo');
  assertSource(application, id, before);
  application.executeMarkdownCommand(id, 'edit.redo');
  assertSource(application, id, after);
}

function assertSource(application: Application, id: string, source: string): void {
  const buffer = application.state().project.buffers[id];
  assert.ok(buffer);
  assert.equal(textDocumentText(buffer.editor.document), source);
  assert.equal(buffer.preview.kind === 'ready' ? buffer.preview.snapshot.source : undefined, source);
}
