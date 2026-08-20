import assert from 'node:assert/strict';
import test from 'node:test';
import { measureRenderSpans } from '@ismail-elkorchi/terminal-ui/renderer';
import { defaultTextWidthProfile } from '@ismail-elkorchi/terminal-ui/text';
import {
  countMarkdownWords,
  getMarkdownDocument,
  parseMarkdownDocument
} from '../markdown-model.js';
import {
  layoutMarkdownDocument,
  markdownLayoutPlainText
} from '../markdown-render.js';

function layout(source: string, width = 72) {
  return layoutMarkdownDocument(parseMarkdownDocument(source), {
    width,
    maxContentWidth: width,
    minHorizontalPadding: 0
  });
}

function plain(source: string, width = 72): string {
  return markdownLayoutPlainText(layout(source, width));
}

function allSpans(source: string, width = 72) {
  return layout(source, width).lines.flatMap((line) => line.spans);
}

test('nested inline formatting stays in the paragraph and preserves styles and links', () => {
  const source = 'A **terminal-first** editor with *live `preview`* and [documentation](https://example.com).';
  const rendered = plain(source, 100);

  assert.equal(rendered.split('\n').filter((line) => line.trim().length > 0).length, 1);
  assert.equal(
    rendered.trim(),
    'A terminal-first editor with live preview and documentation.'
  );

  const spans = allSpans(source, 100);
  assert.ok(spans.some((span) => span.text.includes('terminal-first') && span.style?.bold === true));
  assert.ok(spans.some((span) => span.text.includes('live') && span.style?.italic === true));
  assert.ok(spans.some((span) => span.text.includes('preview') && span.style?.italic === true && span.style?.bg !== undefined));
  assert.ok(spans.some((span) => span.text.includes('documentation') && span.link?.href === 'https://example.com'));
});

test('formatted loose and nested list items render without Markdown delimiters', () => {
  const source = [
    '- item with **bold** and [a link](https://example.com)',
    '',
    '  continuation paragraph',
    '',
    '  - nested *item*',
    '    - third level with `code`',
    '',
    '- [x] completed task',
    '- [ ] pending task'
  ].join('\n');
  const rendered = plain(source, 64);

  assert.match(rendered, /•\s+item with bold and a link/u);
  assert.match(rendered, /continuation paragraph/u);
  assert.match(rendered, /nested item/u);
  assert.match(rendered, /third level with code/u);
  assert.match(rendered, /completed task/u);
  assert.match(rendered, /pending task/u);
  assert.doesNotMatch(rendered, /\*\*bold\*\*/u);
  assert.doesNotMatch(rendered, /\[a link\]\(/u);

  const nonBlank = rendered.split('\n').filter((line) => line.trim().length > 0);
  assert.ok(nonBlank.every((line) => !/^\s*[•◦▪-]\s*$/u.test(line)), 'a list marker must not occupy an otherwise empty line');
});

test('headings, code, references, images, rules, quotes, and HTML have intentional terminal forms', () => {
  const source = [
    '# Vellum',
    '',
    '> A **quoted** paragraph that is long enough to wrap onto another line in a compact preview.',
    '',
    '```ts',
    'const answer = 42;',
    '```',
    '',
    '---',
    '',
    '![diagram](https://example.com/diagram.png "Architecture")',
    '',
    '<section>unsafe HTML</section>',
    '',
    '[docs]: https://example.com/docs'
  ].join('\n');
  const rendered = plain(source, 46);

  assert.match(rendered, /Vellum/u);
  assert.doesNotMatch(rendered, /^\s*#\s+Vellum/mu);
  assert.match(rendered, /quoted paragraph/u);
  assert.match(rendered, /typescript|ts/iu);
  assert.match(rendered, /const answer = 42;/u);
  assert.doesNotMatch(rendered, /```/u);
  assert.match(rendered, /IMAGE\s+diagram/u);
  assert.match(rendered, /https:\/\/example\.com\/diagram\.png/u);
  assert.match(rendered, /HTML not rendered/u);
  assert.doesNotMatch(rendered, /unsafe HTML/u);
  assert.doesNotMatch(rendered, /\[docs\]:/u);

  const horizontalRule = rendered.split('\n').find((line) => /^─+$/u.test(line));
  assert.equal(horizontalRule?.length, 46);
});

test('CRLF input, soft breaks, and hard breaks normalize correctly', () => {
  const source = 'First line\r\ncontinues softly.\r\n\r\nHard break here.  \r\nNext line.';
  const rendered = plain(source, 80);

  assert.match(rendered, /First line continues softly\./u);
  assert.match(rendered, /Hard break here\.\nNext line\./u);
  assert.doesNotMatch(rendered, /\r/u);
});

test('Unicode tables use terminal-cell width and switch to stacked rows when narrow', () => {
  const source = [
    '| Name | State | Link |',
    '| :--- | :---: | ---: |',
    '| 東京 | ✅ | [open](https://example.com/tokyo) |',
    '| café́ | 🚀 | long-value-that-will-clip |'
  ].join('\n');

  const structured = layout(source, 42);
  const structuredText = markdownLayoutPlainText(structured);
  assert.match(structuredText, /東京/u);
  assert.match(structuredText, /✅/u);
  assert.match(structuredText, /…/u);
  assert.ok(
    structured.lines.every((line) => measureRenderSpans(line.spans, { widthProfile: defaultTextWidthProfile }) <= 42),
    'every structured table line fits its layout width'
  );
  assert.ok(structured.lines.flatMap((line) => line.spans).some((span) => span.link?.href === 'https://example.com/tokyo'));

  const stacked = plain(source, 16);
  assert.match(stacked, /Row 1/u);
  assert.match(stacked, /Name:/u);
  assert.match(stacked, /東京/u);
  assert.doesNotMatch(stacked, /┌|┬|┐/u);
});

test('document and layout caches reuse immutable results by source and width', () => {
  const source = '# Cached\n\nA paragraph.';
  const firstDocument = getMarkdownDocument(source);
  const secondDocument = getMarkdownDocument(source);
  assert.equal(firstDocument, secondDocument);

  const firstLayout = layoutMarkdownDocument(firstDocument, { width: 80 });
  const secondLayout = layoutMarkdownDocument(firstDocument, { width: 80 });
  assert.equal(firstLayout, secondLayout);
  assert.ok(Object.isFrozen(firstLayout));
  assert.ok(Object.isFrozen(firstLayout.lines));
});

test('word counts use rendered document text and support Unicode words', () => {
  assert.equal(countMarkdownWords("Hello world 東京 café state-of-the-art"), 5);
  assert.equal(parseMarkdownDocument('**Hello**, [world](https://example.com)! 東京 café').wordCount, 4);
  assert.equal(parseMarkdownDocument('# One\n\nTwo three').wordCount, 3);
});

test('zero-start lists, inline HTML labels, and wrapped code retain their content', () => {
  assert.match(plain('0. zero\n1. one', 20), /^0\. zero/mu);
  assert.match(plain('Before <span>inside</span> after', 40), /HTML tag: <span>/u);
  assert.doesNotMatch(plain('Before <span>inside</span> after', 40), /‹<span>›/u);

  const code = 'const longIdentifier = "東京-café-value";';
  const rendered = plain(`\`\`\`ts\n${code}\n\`\`\``, 14);
  assert.equal(
    rendered.replace(/\bTS\b/u, '').replace(/\s/gu, ''),
    code.replace(/\s/gu, '')
  );
});
