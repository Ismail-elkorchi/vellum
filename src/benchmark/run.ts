import { performance } from 'node:perf_hooks';
import { createTextAreaState, textAreaReducer } from '@ismail-elkorchi/terminal-ui/behavior';
import { createTextAreaRowOffsetMap, richText } from '@ismail-elkorchi/terminal-ui/components';
import { renderElementSnapshot } from '@ismail-elkorchi/terminal-ui/testing';
import { textDocumentText } from '@ismail-elkorchi/terminal-ui/text';
import {
  countMarkdownDocumentWords,
  createMarkdownDocumentSession
} from 'markspan';
import { createBufferParser } from '../markdown/preview.js';
import { createPreviewLayoutCache, layoutMarkdownPreview } from '../markdown/render/layout.js';
import { darkTerminalMarkdownTheme } from '../markdown/theme.js';

interface BenchmarkFixture {
  readonly name: string;
  readonly source: string;
}

interface BenchmarkRow {
  readonly fixture: string;
  readonly operation: string;
  readonly medianMilliseconds: number;
  readonly p95Milliseconds: number;
}

const samples = 3;
const fixtures = benchmarkFixtures();
const rows: BenchmarkRow[] = [];

for (const fixture of fixtures) {
  const editor = createTextAreaState({ value: fixture.source });
  const parsed = createMarkdownDocumentSession(fixture.source, { dialect: 'gfm', sourceRetention: 'text' }).snapshot();
  const parser = createBufferParser(fixture.source, 0);
  const layout = parser.preview().kind === 'ready'
    ? layoutMarkdownPreview(parsed.document.tree, fixture.source, 80, darkTerminalMarkdownTheme, createPreviewLayoutCache())
    : undefined;
  rows.push(measure(fixture.name, 'source-document text extraction', () => textDocumentText(editor.document)));
  rows.push(measure(fixture.name, 'Markspan full parse', () => createMarkdownDocumentSession(fixture.source, { dialect: 'gfm' })));
  rows.push(measure(fixture.name, 'word-count update', () => countMarkdownDocumentWords(parsed.document.tree)));
  rows.push(measure(fixture.name, 'source row-offset map creation', () => createTextAreaRowOffsetMap({
    document: editor.document,
    terminalWidth: 80,
    terminalRows: 24,
    lineNumbers: { minWidth: 3 },
    wrap: { mode: 'soft' },
    scrollbar: { visible: 'auto' }
  })));
  rows.push(measure(fixture.name, 'preview block layout', () => layoutMarkdownPreview(
    parsed.document.tree,
    fixture.source,
    80,
    darkTerminalMarkdownTheme,
    createPreviewLayoutCache()
  )));
  if (layout !== undefined) {
    rows.push(measure(fixture.name, 'complete preview line assembly', () => (
      layout.lines.map((line) => line.inlineSpans.map((span) => span.text).join('')).join('\n')
    )));
    const frameText = layout.lines.slice(0, 24).map((line) => line.inlineSpans.map((span) => span.text).join('')).join('\n');
    rows.push(measure(fixture.name, 'terminal frame commit', () => renderElementSnapshot({
      element: richText({ id: 'benchmark-preview', segments: [{ kind: 'text', text: frameText }] }),
      terminalSize: { columns: 80, rows: 24 }
    })));
  }
  for (const position of ['beginning', 'middle', 'end'] as const) {
    const offset = position === 'beginning' ? 0 : position === 'middle' ? Math.floor(fixture.source.length / 2) : fixture.source.length;
    rows.push(measurePrepared(
      fixture.name,
      `terminal-ui text reduction (${position})`,
      () => textAreaReducer(createTextAreaState({ value: fixture.source }), {
        kind: 'pointer',
        action: { kind: 'placeCaret', offset }
      }).state,
      (state) => textAreaReducer(state, { kind: 'edit', operation: { kind: 'insert', text: 'x' } })
    ));
    rows.push(measurePrepared(
      fixture.name,
      `Markspan edit application (${position})`,
      () => createMarkdownDocumentSession(fixture.source, { dialect: 'gfm', sourceRetention: 'text' }),
      (session) => session.applyEdits([{ span: { start: offset, end: offset }, text: 'x' }])
    ));
  }
}

process.stdout.write('| Fixture | Operation | Median (ms) | p95 (ms) |\n');
process.stdout.write('|---|---|---:|---:|\n');
for (const row of rows) {
  process.stdout.write(`| ${row.fixture} | ${row.operation} | ${row.medianMilliseconds.toFixed(3)} | ${row.p95Milliseconds.toFixed(3)} |\n`);
}

const instrumentationSource = '# Heading\n\nFirst block.\n\nSecond block.\n';
const instrumented = createBufferParser(instrumentationSource, 0);
const instrumentationCache = createPreviewLayoutCache();
const initialInstrumentedPreview = instrumented.preview();
if (initialInstrumentedPreview.kind === 'ready') {
  layoutMarkdownPreview(
    initialInstrumentedPreview.snapshot.document.tree,
    initialInstrumentedPreview.snapshot.source,
    40,
    darkTerminalMarkdownTheme,
    instrumentationCache
  );
}
const update = instrumented.applyChanges({ changes: [{ startOffset: 20, endOffsetExclusive: 20, insertedText: 'changed ' }] }, 1);
const firstLayout = update.kind === 'ready'
  ? layoutMarkdownPreview(update.snapshot.document.tree, update.snapshot.source, 40, darkTerminalMarkdownTheme, instrumentationCache)
  : undefined;
process.stdout.write('\nDeterministic instrumentation:\n');
process.stdout.write(JSON.stringify({
  completeSourceScans: update.kind === 'ready' ? update.update?.instrumentation.completeSourceScans ?? 1 : 1,
  parsedNodes: update.kind === 'ready' ? update.update?.instrumentation.parsedNodes ?? 0 : 0,
  reusedSyntaxNodes: update.kind === 'ready' ? update.update?.instrumentation.reusedNodes ?? 0 : 0,
  fullParse: update.kind === 'ready' ? update.update?.instrumentation.fullParse ?? true : true,
  reusedBlockLayouts: firstLayout?.instrumentation.reusedBlockLayouts ?? 0,
  rebuiltBlockLayouts: firstLayout?.instrumentation.rebuiltBlockLayouts ?? 0,
  fullPreviewLayout: firstLayout?.instrumentation.fullPreviewLayout ?? true
}, null, 2) + '\n');

function measure(fixture: string, operation: string, callback: () => unknown): BenchmarkRow {
  const durations: number[] = [];
  callback();
  for (let index = 0; index < samples; index += 1) {
    const start = performance.now();
    callback();
    durations.push(performance.now() - start);
  }
  durations.sort((left, right) => left - right);
  return Object.freeze({
    fixture,
    operation,
    medianMilliseconds: percentile(durations, 0.5),
    p95Milliseconds: percentile(durations, 0.95)
  });
}

function measurePrepared<T>(
  fixture: string,
  operation: string,
  prepare: () => T,
  callback: (prepared: T) => unknown
): BenchmarkRow {
  const durations: number[] = [];
  callback(prepare());
  for (let index = 0; index < samples; index += 1) {
    const prepared = prepare();
    const start = performance.now();
    callback(prepared);
    durations.push(performance.now() - start);
  }
  durations.sort((left, right) => left - right);
  return Object.freeze({
    fixture,
    operation,
    medianMilliseconds: percentile(durations, 0.5),
    p95Milliseconds: percentile(durations, 0.95)
  });
}

function percentile(values: readonly number[], fraction: number): number {
  return values[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)] ?? 0;
}

function benchmarkFixtures(): readonly BenchmarkFixture[] {
  const exactLength = (seed: string, length: number): string => seed.repeat(Math.ceil(length / seed.length)).slice(0, length);
  return Object.freeze([
    Object.freeze({ name: 'small prose', source: '# Notes\n\nA small prose document with **strong text** and [a link](./target.md).\n' }),
    Object.freeze({ name: '100,000 characters', source: exactLength('A paragraph with words and punctuation.\n\n', 100_000) }),
    Object.freeze({ name: '1,000,000 characters', source: exactLength('A larger paragraph with stable Markdown text.\n\n', 1_000_000) }),
    Object.freeze({ name: 'thousands of short paragraphs', source: Array.from({ length: 4_000 }, (_, index) => `Paragraph ${String(index)}.`).join('\n\n') }),
    Object.freeze({ name: 'one very large paragraph', source: exactLength('one very large paragraph ', 250_000) }),
    Object.freeze({ name: 'one very large fenced code block', source: `\`\`\`text\n${exactLength('const value = 1;\n', 250_000)}\n\`\`\`\n` }),
    Object.freeze({ name: 'large nested lists', source: Array.from({ length: 8_000 }, (_, index) => `${'  '.repeat(index % 12)}- item ${String(index)}`).join('\n') }),
    Object.freeze({ name: 'large tables', source: ['| A | B | C |', '| - | - | - |', ...Array.from({ length: 4_000 }, (_, index) => `| ${String(index)} | value | text |`)].join('\n') }),
    Object.freeze({ name: 'many links and footnotes', source: Array.from({ length: 3_000 }, (_, index) => `[link ${String(index)}][ref-${String(index)}] and note[^${String(index)}].\n\n[ref-${String(index)}]: ./file-${String(index)}.md\n\n[^${String(index)}]: footnote ${String(index)}.`).join('\n\n') })
  ]);
}
