import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { defaultTextWidthProfile } from '@ismail-elkorchi/terminal-ui/text';
import { parseMarkdown } from 'markspan';
import { createPreviewLayoutCache, layoutMarkdownPreview, prepareMarkdownPreview } from '../markdown/render/layout.js';
import { darkTerminalMarkdownTheme } from '../markdown/theme.js';

const theme = darkTerminalMarkdownTheme;
const profile = defaultTextWidthProfile;

test('prepared preview equals the shared headless renderer across block types and widths', async () => {
  const source = '# Heading\n\nText with ``a  b`` and [link](./target.md).\n\n> quote\n>\n> - nested item\n\n```ts\n\tlet x = 1;\n\n```\n\n| A | B |\n| - | - |\n| first | second |\n\n[^one]: Footnote\n';
  const tree = parseMarkdown(source, { dialect: 'gfm' }).tree;
  for (const width of [1, 2, 12, 40, 80]) {
    const expected = layoutMarkdownPreview(tree, width, theme, profile, createPreviewLayoutCache());
    const actual = await prepareMarkdownPreview(tree, width, theme, profile, createPreviewLayoutCache());
    assert.deepEqual({ ...actual, rowOffsetMap: undefined }, { ...expected, rowOffsetMap: undefined });
    for (let row = 0; row < actual.rows.length; row += 1) {
      assert.equal(actual.rowOffsetMap.sourceOffsetAtRow(row), expected.rowOffsetMap.sourceOffsetAtRow(row));
    }
  }
});

for (const [name, source] of [
  ['long unbroken paragraph', 'x'.repeat(200_000)],
  ['large fence', '```\n' + 'x\n'.repeat(20_000) + '```'],
  ['long tabbed fence line', '```\n' + 'x\t'.repeat(100_000) + '\n```'],
  ['large table', '| A | B |\n| - | - |\n' + '| first | second |\n'.repeat(8_000)],
] as const) {
  test(`preparation cancels inside a ${name} without publishing partial cache entries`, async () => {
    const tree = parseMarkdown(source, { dialect: 'gfm' }).tree;
    const cache = createPreviewLayoutCache();
    const controller = new AbortController();
    let turns = 0;
    await assert.rejects(prepareMarkdownPreview(tree, 40, theme, profile, cache, {}, {
      signal: controller.signal,
      async yieldControl() {
        turns += 1;
        if (turns === 3) controller.abort();
        await setImmediate();
      },
    }), { name: 'AbortError' });
    assert.equal(turns, 3);
    for (const node of tree.children) assert.equal(cache.get(node.id, 40, theme, profile), undefined);
  });
}

test('warm-cache assembly remains cancellable and leaves accepted entries intact', async () => {
  const tree = parseMarkdown('paragraph\n\n'.repeat(6_000)).tree;
  const cache = createPreviewLayoutCache();
  layoutMarkdownPreview(tree, 40, theme, profile, cache);
  const first = tree.children[0];
  assert.ok(first);
  const accepted = cache.get(first.id, 40, theme, profile);
  const controller = new AbortController();
  let turns = 0;
  await assert.rejects(prepareMarkdownPreview(tree, 40, theme, profile, cache, {}, {
    signal: controller.signal,
    async yieldControl() {
      turns += 1;
      if (turns === 3) controller.abort();
      await setImmediate();
    },
  }), { name: 'AbortError' });
  assert.equal(cache.get(first.id, 40, theme, profile), accepted);
});

test('default preparation scheduling gives timers a turn before completing a long block', async () => {
  const tree = parseMarkdown('ordinary words '.repeat(10_000)).tree;
  let timerFired = false;
  const timer = setTimeout(() => { timerFired = true; }, 0);
  try {
    const pending = prepareMarkdownPreview(tree, 80, theme, profile, createPreviewLayoutCache());
    assert.equal(timerFired, false);
    await pending;
    assert.equal(timerFired, true);
  } finally {
    clearTimeout(timer);
  }
});


test('pre-aborted preparation never starts work or mutates the layout cache', async () => {
  const tree = parseMarkdown('a document').tree;
  const cache = createPreviewLayoutCache();
  let scheduled = false;
  await assert.rejects(prepareMarkdownPreview(tree, 80, theme, profile, cache, {}, {
    signal: AbortSignal.abort(),
    async yieldControl() { scheduled = true; },
  }), { name: 'AbortError' });
  assert.equal(scheduled, false);
  const node = tree.children[0];
  assert.ok(node);
  assert.equal(cache.get(node.id, 80, theme, profile), undefined);
});
