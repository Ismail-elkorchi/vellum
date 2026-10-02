import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCliArguments, commandHelp } from '../cli-options.js';

test('terminal emoji width is an explicit editor-only capability choice', () => {
  for (const emojiWidth of ['narrow', 'wide', 'codepoint'] as const) {
    assert.deepEqual(parseCliArguments(['notes.md', '--emoji-width', emojiWidth]), {
      kind: 'open', path: 'notes.md', emojiWidth, help: false,
    });
  }
  assert.equal('emojiWidth' in parseCliArguments(['notes.md']), false);
  assert.throws(() => parseCliArguments(['--emoji-width']), /requires wide, narrow, or codepoint/);
  assert.throws(() => parseCliArguments(['--emoji-width', 'guess']), /requires wide, narrow, or codepoint/);
  assert.throws(() => parseCliArguments(['export', 'notes.md', '--profile', 'html', '--emoji-width', 'codepoint']), /Editor options/);
  assert.throws(() => parseCliArguments(['--keyboard-report', '--emoji-width', 'codepoint']), /cannot be combined/);
  assert.match(commandHelp(), /--emoji-width/);
});
