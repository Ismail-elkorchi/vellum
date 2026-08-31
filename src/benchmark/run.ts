import { performance } from 'node:perf_hooks';
import type { Element } from '@ismail-elkorchi/terminal-ui';
import { createTextAreaState, textAreaReducer } from '@ismail-elkorchi/terminal-ui/behavior';
import { createTextAreaRowOffsetMap, text } from '@ismail-elkorchi/terminal-ui/components';
import { createMemoryTerminalHost } from '@ismail-elkorchi/terminal-ui/host';
import { column } from '@ismail-elkorchi/terminal-ui/layout';
import { ignoreMessage, type IgnoredMessage } from '@ismail-elkorchi/terminal-ui/interaction';
import { renderElementFrame } from '@ismail-elkorchi/terminal-ui/renderer';
import { createTuiRuntime, defineTui } from '@ismail-elkorchi/terminal-ui/tui';
import { defaultTextWidthProfile, textDocumentText } from '@ismail-elkorchi/terminal-ui/text';
import {
  countMarkdownDocumentWords,
  createMarkdownDocumentSession
} from 'markspan';
import { createBufferParser } from '../markdown/preview.js';
import { createPreviewLayoutCache, layoutMarkdownPreview } from '../markdown/render/layout.js';
import { markdownPreview } from '../markdown/render/component.js';
import { darkTerminalMarkdownTheme } from '../markdown/theme.js';
import { createVellumApplication } from '../app/application.js';
import type { ProjectDocumentIndexEntry, ProjectIndexState } from '../app/types.js';
import { quickOpenEntries } from '../project/quick-open.js';
import { searchProjectDirectory } from '../search/project-directory-search.js';
import { createVellumTui } from '../tui.js';

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

interface BenchmarkThreshold {
  readonly fixture: string;
  readonly operation: string;
  readonly maximumP95Milliseconds: number;
}

const samples = 3;
const fixtures = benchmarkFixtures();
const rows: BenchmarkRow[] = [];
const jsonOutput = process.argv.includes('--json');
const enforceThresholds = process.argv.includes('--check');

for (const fixture of fixtures) {
  const editor = createTextAreaState({ value: fixture.source });
  const parsed = createMarkdownDocumentSession(fixture.source, { dialect: 'gfm', sourceRetention: 'text' }).snapshot();
  const parser = createBufferParser(fixture.source, 0);
  const layout = parser.preview().kind === 'ready'
    ? layoutMarkdownPreview(
        parsed.document.tree,
        80,
        darkTerminalMarkdownTheme,
        defaultTextWidthProfile,
        createPreviewLayoutCache(),
      )
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
    80,
    darkTerminalMarkdownTheme,
    defaultTextWidthProfile,
    createPreviewLayoutCache()
  )));
  if (layout !== undefined) {
    rows.push(measure(fixture.name, 'complete preview line assembly', () => (
      layout.rows.map((line) => line.inlineSpans.map((span) => span.text).join('')).join('\n')
    )));
    const component = markdownPreview({
      id: 'benchmark-preview',
      label: 'Benchmark preview',
      layout,
      viewportWidth: layout.width,
      contentColumn: 0,
      onAction: ignoreMessage,
    });
    rows.push(measure(fixture.name, 'preview component render', () => (
      renderElementFrame(component, { columns: 80, rows: 24 })
    )));
    rows.push(await measureTerminalFrameCommit(fixture.name, component));
  }
  for (const position of ['beginning', 'middle', 'end'] as const) {
    const offset = position === 'beginning' ? 0 : position === 'middle' ? Math.floor(fixture.source.length / 2) : fixture.source.length;
    rows.push(measurePrepared(
      fixture.name,
      `terminal-ui text reduction (${position})`,
      () => textAreaReducer(createTextAreaState({ value: fixture.source }), {
        kind: 'pointer',
        transition: { kind: 'placeCaret', offset }
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

const instrumentationSource = '# Heading\n\nFirst block.\n\nSecond block.\n';
const instrumented = createBufferParser(instrumentationSource, 0);
const instrumentationCache = createPreviewLayoutCache();
const initialInstrumentedPreview = instrumented.preview();
if (initialInstrumentedPreview.kind === 'ready') {
  layoutMarkdownPreview(
    initialInstrumentedPreview.snapshot.document.tree,
    40,
    darkTerminalMarkdownTheme,
    defaultTextWidthProfile,
    instrumentationCache
  );
}
const update = instrumented.applyChanges({ changes: [{ startOffset: 20, endOffsetExclusive: 20, insertedText: 'changed ' }] }, 1);
const firstLayout = update.kind === 'ready'
  ? layoutMarkdownPreview(
      update.snapshot.document.tree,
      40,
      darkTerminalMarkdownTheme,
      defaultTextWidthProfile,
      instrumentationCache,
    )
  : undefined;
const instrumentation = Object.freeze({
  parsedCodeUnits: update.kind === 'ready' ? update.update?.instrumentation.parsedCodeUnits ?? instrumentationSource.length : instrumentationSource.length,
  sourceIndexCodeUnits: update.kind === 'ready' ? update.update?.instrumentation.sourceIndexCodeUnits ?? instrumentationSource.length : instrumentationSource.length,
  parsedNodes: update.kind === 'ready' ? update.update?.instrumentation.parsedNodes ?? 0 : 0,
  reconciledNodes: update.kind === 'ready' ? update.update?.instrumentation.reconciledNodes ?? 0 : 0,
  comparedCodeUnits: update.kind === 'ready' ? update.update?.instrumentation.comparedCodeUnits ?? 0 : 0,
  sourceTraversalCodeUnits: update.kind === 'ready' ? update.update?.instrumentation.sourceTraversalCodeUnits ?? instrumentationSource.length : instrumentationSource.length,
  reusedSyntaxNodes: update.kind === 'ready' ? update.update?.instrumentation.reusedNodes ?? 0 : 0,
  fullParse: update.kind === 'ready' ? update.update?.instrumentation.fullParse ?? true : true,
  reusedBlockLayouts: firstLayout?.instrumentation.reusedBlockLayouts ?? 0,
  rebuiltBlockLayouts: firstLayout?.instrumentation.rebuiltBlockLayouts ?? 0,
  fullPreviewLayout: firstLayout?.instrumentation.fullPreviewLayout ?? true
});

const syntheticIndex = benchmarkProjectIndex(10_000);
rows.push(measure('10,000-file project', 'Quick Open filtering', () => (
  quickOpenEntries(syntheticIndex, 'file-09999', Object.freeze([]))
)));
rows.push(await measureAsync('10,000-file project', 'first warm project-search result', async () => {
  await searchProjectDirectory(
    syntheticIndex,
    'needle-00000',
    { maximumResults: 1 },
    new AbortController().signal
  );
}));
rows.push(await measureSearchCancellation(syntheticIndex));
rows.push(await measureApplicationKeystrokeFrame());

const thresholds: readonly BenchmarkThreshold[] = Object.freeze([
  Object.freeze({ fixture: '1 MiB application', operation: 'keystroke-to-frame', maximumP95Milliseconds: 1_000 }),
  Object.freeze({ fixture: '10,000-file project', operation: 'Quick Open filtering', maximumP95Milliseconds: 100 }),
  Object.freeze({ fixture: '10,000-file project', operation: 'first warm project-search result', maximumP95Milliseconds: 250 }),
  Object.freeze({ fixture: '10,000-file project', operation: 'project-search cancellation acknowledgement', maximumP95Milliseconds: 100 })
]);
const violations = thresholds.flatMap((threshold) => {
  const row = rows.find((candidate) => candidate.fixture === threshold.fixture && candidate.operation === threshold.operation);
  return row === undefined || row.p95Milliseconds > threshold.maximumP95Milliseconds
    ? [Object.freeze({ ...threshold, actualP95Milliseconds: row?.p95Milliseconds })]
    : [];
});
const report = Object.freeze({
  schemaVersion: 1,
  environment: Object.freeze({ node: process.version, platform: process.platform, architecture: process.arch }),
  samples,
  rows: Object.freeze(rows),
  instrumentation,
  thresholds,
  violations: Object.freeze(violations)
});

if (jsonOutput) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
else {
  process.stdout.write('| Fixture | Operation | Median (ms) | p95 (ms) |\n');
  process.stdout.write('|---|---|---:|---:|\n');
  for (const row of rows) {
    process.stdout.write(`| ${row.fixture} | ${row.operation} | ${row.medianMilliseconds.toFixed(3)} | ${row.p95Milliseconds.toFixed(3)} |\n`);
  }
  process.stdout.write('\nDeterministic instrumentation:\n');
  process.stdout.write(JSON.stringify(instrumentation, null, 2) + '\n');
  process.stdout.write(`\nRegression gates: ${violations.length === 0 ? 'passed' : `${String(violations.length)} failed`}\n`);
}
if (enforceThresholds && violations.length > 0) process.exitCode = 1;

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

async function measureTerminalFrameCommit(
  fixture: string,
  component: Element<IgnoredMessage>
): Promise<BenchmarkRow> {
  const durations: number[] = [];
  for (let index = -1; index < samples; index += 1) {
    const host = createMemoryTerminalHost({
      terminalSize: { columns: 80, rows: 24 },
      capabilities: {
        graphics: { kitty: 'supported', sixel: 'unsupported', cellPixels: { width: 8, height: 16 } }
      }
    });
    const app = defineTui<
      { readonly revision: number },
      IgnoredMessage | { readonly kind: 'commit' }
    >({
      id: `vellum-benchmark-${fixture}`,
      init: () => ({ state: Object.freeze({ revision: 0 }) }),
      update: (state) => ({ state: Object.freeze({ revision: state.revision + 1 }) }),
      view: (state) => column([component, text({ content: `Frame ${String(state.revision)}` })])
    });
    const runtime = createTuiRuntime({ app, host, graphics: 'kitty' });
    await runtime.start();
    const start = performance.now();
    await runtime.dispatch({ kind: 'commit' });
    const duration = performance.now() - start;
    if (index >= 0) durations.push(duration);
    await runtime.dispose();
  }
  durations.sort((left, right) => left - right);
  return Object.freeze({
    fixture,
    operation: 'terminal frame commit',
    medianMilliseconds: percentile(durations, 0.5),
    p95Milliseconds: percentile(durations, 0.95)
  });
}

async function measureAsync(
  fixture: string,
  operation: string,
  callback: () => Promise<unknown>
): Promise<BenchmarkRow> {
  const durations: number[] = [];
  await callback();
  for (let index = 0; index < samples; index += 1) {
    const start = performance.now();
    await callback();
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

async function measureSearchCancellation(index: ProjectIndexState): Promise<BenchmarkRow> {
  return measureAsync('10,000-file project', 'project-search cancellation acknowledgement', async () => {
    const controller = new AbortController();
    const searching = searchProjectDirectory(index, 'term-that-does-not-exist', {}, controller.signal);
    setImmediate(() => controller.abort());
    try {
      await searching;
      throw new Error('The benchmark search completed before cancellation.');
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    }
  });
}

async function measureApplicationKeystrokeFrame(): Promise<BenchmarkRow> {
  const source = exactSourceLength('A paragraph with stable Markdown text.\n\n', 1_048_576);
  const application = createVellumApplication({ watchFiles: false, createBufferId: () => 'benchmark-buffer' });
  const bufferId = application.openSource(source, 'large.md');
  const runtime = createTuiRuntime({
    app: createVellumTui(application),
    host: createMemoryTerminalHost({ terminalSize: { columns: 120, rows: 34 } })
  });
  const durations: number[] = [];
  try {
    await runtime.start();
    for (let index = -1; index < samples; index += 1) {
      const start = performance.now();
      await runtime.dispatch({
        kind: 'editor',
        bufferId,
        transition: { kind: 'edit', operation: { kind: 'insert', text: 'x' } }
      });
      if (index >= 0) durations.push(performance.now() - start);
    }
  } finally {
    await runtime.dispose();
    await application.dispose();
  }
  durations.sort((left, right) => left - right);
  return Object.freeze({
    fixture: '1 MiB application',
    operation: 'keystroke-to-frame',
    medianMilliseconds: percentile(durations, 0.5),
    p95Milliseconds: percentile(durations, 0.95)
  });
}

function benchmarkProjectIndex(count: number): ProjectIndexState {
  const documents: Record<string, ProjectDocumentIndexEntry> = {};
  const orderedPaths: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const padded = String(index).padStart(5, '0');
    const filePath = `/benchmark/file-${padded}.md`;
    const source = `# File ${padded}\n\nneedle-${padded}\n`;
    orderedPaths.push(filePath);
    documents[filePath] = Object.freeze({
      path: filePath,
      relativePath: `file-${padded}.md`,
      size: source.length,
      modifiedMilliseconds: 0,
      contentHash: padded.padEnd(64, '0'),
      headings: Object.freeze([{ text: `File ${padded}`, depth: 1, sourceOffset: 0 }]),
      links: Object.freeze([]),
      properties: Object.freeze({}),
      taskStates: Object.freeze([]),
      tags: Object.freeze([]),
      citationKeys: Object.freeze([]),
      searchableText: source
    });
  }
  return Object.freeze({
    documents: Object.freeze(documents),
    orderedPaths: Object.freeze(orderedPaths),
    assetPaths: Object.freeze([]),
    indexing: false,
    revision: 1
  });
}

function exactSourceLength(seed: string, length: number): string {
  return seed.repeat(Math.ceil(length / seed.length)).slice(0, length);
}

function percentile(values: readonly number[], fraction: number): number {
  return values[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)] ?? 0;
}

function benchmarkFixtures(): readonly BenchmarkFixture[] {
  return Object.freeze([
    Object.freeze({ name: 'small prose', source: '# Notes\n\nA small prose document with **strong text** and [a link](./target.md).\n' }),
    Object.freeze({ name: '100,000 characters', source: exactSourceLength('A paragraph with words and punctuation.\n\n', 100_000) }),
    Object.freeze({ name: '1,000,000 characters', source: exactSourceLength('A larger paragraph with stable Markdown text.\n\n', 1_000_000) }),
    Object.freeze({ name: 'thousands of short paragraphs', source: Array.from({ length: 4_000 }, (_, index) => `Paragraph ${String(index)}.`).join('\n\n') }),
    Object.freeze({ name: 'one very large paragraph', source: exactSourceLength('one very large paragraph ', 250_000) }),
    Object.freeze({ name: 'one very large fenced code block', source: `\`\`\`text\n${exactSourceLength('const value = 1;\n', 250_000)}\n\`\`\`\n` }),
    Object.freeze({ name: 'large nested lists', source: Array.from({ length: 8_000 }, (_, index) => `${'  '.repeat(index % 12)}- item ${String(index)}`).join('\n') }),
    Object.freeze({ name: 'large tables', source: ['| A | B | C |', '| - | - | - |', ...Array.from({ length: 4_000 }, (_, index) => `| ${String(index)} | value | text |`)].join('\n') }),
    Object.freeze({ name: 'many links and footnotes', source: Array.from({ length: 3_000 }, (_, index) => `[link ${String(index)}][ref-${String(index)}] and note[^${String(index)}].\n\n[ref-${String(index)}]: ./file-${String(index)}.md\n\n[^${String(index)}]: footnote ${String(index)}.`).join('\n\n') })
  ]);
}
