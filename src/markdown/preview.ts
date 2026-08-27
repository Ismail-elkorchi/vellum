import type { TextChangeSet } from '@ismail-elkorchi/terminal-ui/text';
import {
  MarkdownBudgetExceededError,
  applyMarkdownTextEdits,
  createMarkdownDocumentSession,
  createMarkdownTreeIndex,
  type MarkdownDocumentSession,
  type MarkdownNode,
  type MarkdownParseOptions,
  type MarkdownSessionUpdate,
  type MarkdownSyntaxExtension,
  type MarkdownTextEdit
} from 'markspan';
import type {
  DocumentMetricUpdate,
  DocumentMetrics,
  FailedMarkdownPreview,
  MarkdownPreview,
  ReadyMarkdownPreview
} from '../app/types.js';

type WordState = 0 | 1 | 2;

interface WordTransition {
  readonly state: WordState;
  readonly completed: number;
}

interface WordSummary {
  readonly transitions: readonly [WordTransition, WordTransition, WordTransition];
}

interface NodeMetric {
  readonly nodeId: number;
  readonly words: WordSummary;
  readonly wordCount: number;
  readonly headingCount: number;
  readonly linkCount: number;
  readonly taskCount: number;
  readonly childIds: readonly number[];
  readonly nodeCount: number;
}

interface DocumentMetricCache {
  readonly entries: Map<number, NodeMetric>;
  readonly references: Map<number, number>;
  roots: ReadonlySet<number>;
}

interface MetricCounters {
  reusedNodes: number;
  recomputedNodes: number;
  removedNodes: number;
}

export interface BufferParser {
  readonly identity: object;
  source(): string;
  preview(): MarkdownPreview;
  applyChanges(changeSet: TextChangeSet, sourceRevision: number): MarkdownPreview;
  replaceSource(source: string, sourceRevision: number): MarkdownPreview;
}

function markspanEdits(changeSet: TextChangeSet): readonly MarkdownTextEdit[] {
  return Object.freeze(changeSet.changes.map((change) => Object.freeze({
    span: Object.freeze({ start: change.startOffset, end: change.endOffsetExclusive }),
    text: change.insertedText
  })));
}

export function createBufferParser(
  source: string,
  sourceRevision: number,
  parseOptions: MarkdownParseOptions = {}
): BufferParser {
  const options: MarkdownParseOptions = Object.freeze({
    dialect: 'gfm',
    extensions: Object.freeze<readonly MarkdownSyntaxExtension[]>(['frontMatter', 'callouts', 'math']),
    ...parseOptions,
    sourceRetention: 'text'
  });
  let identity = Object.freeze({});
  const metrics: DocumentMetricCache = {
    entries: new Map(),
    references: new Map(),
    roots: new Set()
  };
  let currentSource = source;
  let currentRevision = sourceRevision;
  let session: MarkdownDocumentSession | undefined;
  let current: MarkdownPreview;

  const open = (nextSource: string, revision: number): MarkdownPreview => {
    currentSource = nextSource;
    currentRevision = revision;
    identity = Object.freeze({});
    resetDocumentMetricCache(metrics);
    try {
      session = createMarkdownDocumentSession(nextSource, options);
      current = ready(identity, session.snapshot(), revision, metrics);
    } catch (error) {
      if (!(error instanceof MarkdownBudgetExceededError)) throw error;
      session = undefined;
      current = failed(revision, error);
    }
    return current;
  };

  open(source, sourceRevision);
  return Object.freeze({
    get identity() { return identity; },
    source: () => currentSource,
    preview: () => current,
    applyChanges(changeSet: TextChangeSet, revision: number) {
      if (revision <= currentRevision) throw new RangeError('A source revision must increase after a text change.');
      const edits = markspanEdits(changeSet);
      if (edits.length === 0) throw new TypeError('A parser update requires a non-empty text change set.');
      if (session === undefined) {
        const nextSource = applyMarkdownTextEdits(currentSource, edits).source;
        return open(nextSource, revision);
      }
      if (session.snapshot().source !== currentSource) {
        throw new Error('The buffer parser source revision is inconsistent.');
      }
      try {
        const update = session.applyEdits(edits);
        currentSource = update.snapshot.source;
        currentRevision = revision;
        current = ready(identity, update.snapshot, revision, metrics, update);
        return current;
      } catch (error) {
        if (!(error instanceof MarkdownBudgetExceededError)) throw error;
        currentSource = applyMarkdownTextEdits(currentSource, edits).source;
        currentRevision = revision;
        session = undefined;
        current = failed(revision, error);
        return current;
      }
    },
    replaceSource(nextSource: string, revision: number) {
      if (revision < currentRevision) throw new RangeError('A source revision cannot move backward.');
      return open(nextSource, revision);
    }
  });
}

function resetDocumentMetricCache(cache: DocumentMetricCache): void {
  cache.entries.clear();
  cache.references.clear();
  cache.roots = new Set();
}

function ready(
  identity: object,
  snapshot: ReturnType<MarkdownDocumentSession['snapshot']>,
  sourceRevision: number,
  cache: DocumentMetricCache,
  update?: MarkdownSessionUpdate
): ReadyMarkdownPreview {
  const calculated = documentMetrics(snapshot.document.tree.children, cache);
  return Object.freeze({
    kind: 'ready',
    sourceRevision,
    identity,
    snapshot,
    treeIndex: createMarkdownTreeIndex(snapshot.document.tree),
    metrics: calculated.metrics,
    metricUpdate: calculated.update,
    ...(update === undefined ? {} : { update })
  });
}

function failed(sourceRevision: number, error: MarkdownBudgetExceededError): FailedMarkdownPreview {
  return Object.freeze({
    kind: 'failed',
    sourceRevision,
    message: error.message,
    diagnostics: Object.freeze([])
  });
}

function documentMetrics(
  blocks: readonly MarkdownNode[],
  cache: DocumentMetricCache
): { readonly metrics: DocumentMetrics; readonly update: DocumentMetricUpdate } {
  const counters: MetricCounters = { reusedNodes: 0, recomputedNodes: 0, removedNodes: 0 };
  const rootMetrics = blocks.map((block) => metricForNode(block, cache, counters));
  const nextRoots = new Set(blocks.map((block) => block.id));
  for (const root of nextRoots) if (!cache.roots.has(root)) retainMetric(root, cache);
  for (const root of cache.roots) if (!nextRoots.has(root)) releaseMetric(root, cache, counters);
  cache.roots = nextRoots;
  const aggregate = combineMetrics(rootMetrics);
  return Object.freeze({
    metrics: Object.freeze({
      wordCount: aggregate.wordCount,
      headingCount: aggregate.headingCount,
      linkCount: aggregate.linkCount,
      taskCount: aggregate.taskCount
    }),
    update: Object.freeze(counters)
  });
}

function metricForNode(
  node: MarkdownNode,
  cache: DocumentMetricCache,
  counters: MetricCounters
): NodeMetric {
  const cached = cache.entries.get(node.id);
  if (cached !== undefined) {
    counters.reusedNodes += cached.nodeCount;
    return cached;
  }
  let children: readonly NodeMetric[] = Object.freeze([]);
  let words = emptyWordSummary;
  let headingCount = 0;
  let linkCount = 0;
  let taskCount = 0;
  let includeChildWords = true;
  switch (node.kind) {
    case 'document':
      children = node.children.map((child) => metricForNode(child, cache, counters));
      break;
    case 'paragraph':
      children = node.children.map((child) => metricForNode(child, cache, counters));
      words = appendSeparator(combineMetrics(children).words, blockSeparator);
      break;
    case 'heading':
      children = node.children.map((child) => metricForNode(child, cache, counters));
      words = appendSeparator(combineMetrics(children).words, blockSeparator);
      headingCount = 1;
      break;
    case 'blockQuote':
    case 'callout':
      children = node.children.map((child) => metricForNode(child, cache, counters));
      break;
    case 'list':
      children = node.items.map((item) => metricForNode(item, cache, counters));
      break;
    case 'listItem':
      children = node.children.map((child) => metricForNode(child, cache, counters));
      words = appendSeparator(combineMetrics(children).words, lineSeparator);
      taskCount = node.task === null ? 0 : 1;
      break;
    case 'codeBlock':
    case 'mathBlock':
      words = appendSeparator(wordSummary(node.value), blockSeparator);
      break;
    case 'frontMatter':
      break;
    case 'thematicBreak':
      words = blockSeparator;
      break;
    case 'htmlBlock':
      words = blockSeparator;
      break;
    case 'linkDefinition':
      break;
    case 'footnoteDefinition':
      children = node.children.map((child) => metricForNode(child, cache, counters));
      includeChildWords = false;
      break;
    case 'table':
      children = [node.header, ...node.rows].map((row) => metricForNode(row, cache, counters));
      words = appendSeparator(combineMetrics(children).words, blockSeparator);
      break;
    case 'tableRow':
      children = node.cells.map((cell) => metricForNode(cell, cache, counters));
      words = appendSeparator(interleaveMetrics(children, tabSeparator).words, lineSeparator);
      break;
    case 'tableCell':
      children = node.children.map((child) => metricForNode(child, cache, counters));
      break;
    case 'text':
    case 'escape':
    case 'characterReference':
    case 'codeSpan':
    case 'mathInline':
      words = wordSummary(node.value);
      break;
    case 'emphasis':
    case 'strong':
    case 'strikethrough':
    case 'image':
      children = node.children.map((child) => metricForNode(child, cache, counters));
      break;
    case 'link':
      children = node.children.map((child) => metricForNode(child, cache, counters));
      linkCount = 1;
      break;
    case 'softBreak':
      words = spaceSeparator;
      break;
    case 'hardBreak':
      words = lineSeparator;
      break;
    case 'htmlInline':
      break;
    case 'footnoteReference':
      words = wordSummary(node.label);
      break;
  }
  const aggregate = combineMetrics(children);
  const resolvedWords = words === emptyWordSummary && children.length > 0 && includeChildWords ? aggregate.words : words;
  const childIds = Object.freeze(children.map((child) => child.nodeId));
  const metric: NodeMetric = Object.freeze({
    nodeId: node.id,
    words: resolvedWords,
    wordCount: completedWords(resolvedWords),
    headingCount: aggregate.headingCount + headingCount,
    linkCount: aggregate.linkCount + linkCount,
    taskCount: aggregate.taskCount + taskCount,
    childIds,
    nodeCount: 1 + children.reduce((sum, child) => sum + child.nodeCount, 0)
  });
  cache.entries.set(node.id, metric);
  cache.references.set(node.id, cache.references.get(node.id) ?? 0);
  for (const child of children) {
    retainMetric(child.nodeId, cache);
  }
  counters.recomputedNodes += 1;
  return metric;
}

function combineMetrics(values: readonly NodeMetric[]): NodeMetric {
  let words = emptyWordSummary;
  let headingCount = 0;
  let linkCount = 0;
  let taskCount = 0;
  let nodeCount = 0;
  for (const metric of values) {
    words = composeWordSummaries(words, metric.words);
    headingCount += metric.headingCount;
    linkCount += metric.linkCount;
    taskCount += metric.taskCount;
    nodeCount += metric.nodeCount;
  }
  return Object.freeze({
    nodeId: -1,
    words,
    wordCount: completedWords(words),
    headingCount,
    linkCount,
    taskCount,
    childIds: Object.freeze([]),
    nodeCount
  });
}

function interleaveMetrics(values: readonly NodeMetric[], separator: WordSummary): NodeMetric {
  const aggregate = combineMetrics(values);
  let words = emptyWordSummary;
  for (let index = 0; index < values.length; index += 1) {
    if (index > 0) words = composeWordSummaries(words, separator);
    words = composeWordSummaries(words, values[index]?.words ?? emptyWordSummary);
  }
  return Object.freeze({ ...aggregate, words, wordCount: completedWords(words) });
}

function retainMetric(nodeId: number, cache: DocumentMetricCache): void {
  if (!cache.entries.has(nodeId)) throw new Error(`Document metric cache is missing syntax node ${String(nodeId)}.`);
  cache.references.set(nodeId, (cache.references.get(nodeId) ?? 0) + 1);
}

function releaseMetric(nodeId: number, cache: DocumentMetricCache, counters: MetricCounters): void {
  const references = cache.references.get(nodeId);
  if (references === undefined || references < 1) {
    throw new Error(`Document metric cache has an invalid reference count for syntax node ${String(nodeId)}.`);
  }
  if (references > 1) {
    cache.references.set(nodeId, references - 1);
    return;
  }
  const metric = cache.entries.get(nodeId);
  cache.references.delete(nodeId);
  cache.entries.delete(nodeId);
  if (metric === undefined) throw new Error(`Document metric cache is missing syntax node ${String(nodeId)}.`);
  counters.removedNodes += 1;
  for (const childId of metric.childIds) releaseMetric(childId, cache, counters);
}

function appendSeparator(value: WordSummary, separator: WordSummary): WordSummary {
  return composeWordSummaries(value, separator);
}

function composeWordSummaries(left: WordSummary, right: WordSummary): WordSummary {
  const transition = (state: WordState): WordTransition => {
    const first = left.transitions[state];
    const second = right.transitions[first.state];
    return Object.freeze({ state: second.state, completed: first.completed + second.completed });
  };
  const transitions: [WordTransition, WordTransition, WordTransition] = [transition(0), transition(1), transition(2)];
  return Object.freeze({ transitions: Object.freeze(transitions) });
}

function wordSummary(value: string): WordSummary {
  const transition = (initial: WordState): WordTransition => {
    let state: WordState = initial;
    let completed = 0;
    for (const character of value) {
      if (wordBasePattern.test(character)) {
        state = 1;
      } else if (wordConnectors.has(character)) {
        if (state === 1) state = 2;
        else if (state === 2) {
          completed += 1;
          state = 0;
        }
      } else {
        if (state !== 0) completed += 1;
        state = 0;
      }
    }
    return Object.freeze({ state, completed });
  };
  const transitions: [WordTransition, WordTransition, WordTransition] = [transition(0), transition(1), transition(2)];
  return Object.freeze({ transitions: Object.freeze(transitions) });
}

function completedWords(summary: WordSummary): number {
  const transition = summary.transitions[0];
  return transition.completed + (transition.state === 0 ? 0 : 1);
}

const wordBasePattern = /^[\p{L}\p{N}]$/u;
const wordConnectors = new Set(["'", '’', '-']);
const emptyWordSummary: WordSummary = wordSummary('');
const spaceSeparator: WordSummary = wordSummary(' ');
const lineSeparator: WordSummary = wordSummary('\n');
const tabSeparator: WordSummary = wordSummary('\t');
const blockSeparator: WordSummary = wordSummary('\n\n');
