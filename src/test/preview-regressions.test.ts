import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultTextWidthProfile } from '@ismail-elkorchi/terminal-ui/text';
import { parseMarkdown } from 'markspan';
import { createPreviewLayoutCache, layoutMarkdownPreview } from '../markdown/render/layout.js';
import { darkTerminalMarkdownTheme } from '../markdown/theme.js';

function preview(source: string, width: number) {
  return layoutMarkdownPreview(
    parseMarkdown(source).tree, width, darkTerminalMarkdownTheme,
    defaultTextWidthProfile, createPreviewLayoutCache(),
  );
}

test('tab-expanded fenced code retains source-unit row offsets at narrow widths', () => {
  const source = '```\n\tx\ny\n```';
  const layout = preview(source, 1);
  assert.deepEqual(layout.rows.map((row) => row.inlineSpans.map((span) => span.text).join('')), [' ', ' ', ' ', ' ', 'x', 'y']);
  assert.deepEqual(layout.rows.map((row) => row.sourceOffset), [0, 4, 4, 4, 5, 7]);
  for (const width of [2, 3, 4, 5, 6, 10, 80]) {
    const rendered = preview(source, width);
    assert.ok(rendered.rows.every((row) => row.sourceOffset <= source.length));
  }
});

test('inline code retains parser-normalized significant spaces through wrapping', () => {
  for (const [source, expected] of [
    ['``a  b``', 'a  b'],
    ['`` a  b ``', 'a  b'],
    ['``  ``', '  '],
    ['``a\nb``', 'a b'],
  ]) {
    assert.ok(source !== undefined && expected !== undefined);
    for (const width of [1, 2, 3, 40]) {
      const rendered = preview(source, width);
      assert.equal(rendered.rows.map((row) => row.inlineSpans.map((span) => span.text).join('')).join(''), expected);
    }
  }
  assert.equal(preview('a  b', 40).rows[0]?.inlineSpans.map((span) => span.text).join(''), 'a b');
});

test('large fenced blocks append rows without a function-argument count limit', () => {
  const lines = 130_000;
  const source = '```\n' + 'x\n'.repeat(lines) + '```';
  const layout = preview(source, 80);
  assert.equal(layout.rows.length, lines);
  assert.equal(layout.rows.at(-1)?.sourceOffset, 4 + (lines - 1) * 2);
});

test('terminal projection preserves source offsets across tabs, controls, CRLF, and highlighting', async () => {
  const { renderCodeBlock } = await import('../markdown/render/code.js');
  const { wrapMarkdownPreformattedSpans } = await import('../markdown/render/wrap.js');
  const { defineTextWidthProfile, sanitizeTerminalText } = await import('@ismail-elkorchi/terminal-ui/text');
  const profile = defineTextWidthProfile({ ambiguous: 'wide', emoji: 'wide' });
  const source = '```\r\na\t界\tx\r\n\t\u001b[31mz\u001b[0m\r\n```';
  const node = parseMarkdown(source).tree.children[0];
  assert.ok(node?.kind === 'codeBlock');
  const plain = renderCodeBlock(node, darkTerminalMarkdownTheme);
  const highlighted = renderCodeBlock(node, darkTerminalMarkdownTheme, {
    language: 'text', sourceHash: 'test',
    tokens: [{ span: { start: 1, end: 4 }, style: { bold: true } }],
  });
  for (const width of [1, 2, 3, 4, 8, 80]) {
    const rows = wrapMarkdownPreformattedSpans(plain, width, profile);
    const styled = wrapMarkdownPreformattedSpans(highlighted, width, profile);
    const projection = (values: typeof rows) => values.map((row) => ({
      text: row.inlineSpans.map((span) => span.text).join(''), offset: row.sourceOffset,
    }));
    assert.deepEqual(projection(styled), projection(rows));
    assert.equal(rows.map((row) => row.inlineSpans.map((span) => span.text).join('')).join(''), sanitizeTerminalText(node.value, { widthProfile: profile }).text.replaceAll('\n', ''));
    for (const row of rows) {
      for (const span of row.inlineSpans) {
        assert.ok(span.sourceSpan.start >= 0 && span.sourceSpan.end <= source.length);
        if (span.sourceMapping === 'identity') {
          assert.equal(source.slice(span.sourceSpan.start, span.sourceSpan.end), span.text);
        }
      }
    }
  }
});

test('preview component uses prepared geometry and paints pending for unprepared allocations', async () => {
  const { markdownPreview, prepareMarkdownPreviewPresentation } = await import('../markdown/render/component.js');
  const { renderElementSnapshot } = await import('@ismail-elkorchi/terminal-ui/testing');
  const layout = preview('A stable document', 80);
  const element = markdownPreview({
    id: 'prepared-preview', label: 'Preview', version: 'one',
    presentation: await prepareMarkdownPreviewPresentation(layout, 80, 0, 'prepared-preview'),
    onAction: (action) => action,
  });
  for (const columns of [80, 90, 80, 100, 110, 80]) {
    const rendered = renderElementSnapshot({ element, terminalSize: { columns, rows: 2 } });
    assert.match(rendered.plainTextFrame, columns === 80 ? /A stable document/u : /Preparing preview/u);
    assert.equal(rendered.frame.hitTargets?.length ?? 0, columns === 80 ? 1 : 0);
  }
});
