import type { TextChangeSet } from '@ismail-elkorchi/terminal-ui/text';
import {
  MarkdownBudgetExceededError,
  applyMarkdownTextEdits,
  collectMarkdownNodes,
  countMarkdownDocumentWords,
  createMarkdownDocumentSession,
  createMarkdownTreeIndex,
  type MarkdownBlockNode,
  type MarkdownDocumentSession,
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

interface BlockMetric {
  readonly wordCount: number;
  readonly headingCount: number;
  readonly linkCount: number;
  readonly taskCount: number;
}

export interface BufferParser {
  readonly identity: object;
  source(): string;
  preview(): MarkdownPreview;
  applyChanges(changeSet: TextChangeSet, sourceRevision: number): MarkdownPreview;
  replaceSource(source: string, sourceRevision: number): MarkdownPreview;
}

export function markspanEdits(changeSet: TextChangeSet): readonly MarkdownTextEdit[] {
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
  const identity = Object.freeze({});
  const metrics = new Map<number, BlockMetric>();
  let currentSource = source;
  let currentRevision = sourceRevision;
  let session: MarkdownDocumentSession | undefined;
  let current: MarkdownPreview;

  const open = (nextSource: string, revision: number): MarkdownPreview => {
    currentSource = nextSource;
    currentRevision = revision;
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
    identity,
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

function ready(
  identity: object,
  snapshot: ReturnType<MarkdownDocumentSession['snapshot']>,
  sourceRevision: number,
  cache: Map<number, BlockMetric>,
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
  blocks: readonly MarkdownBlockNode[],
  cache: Map<number, BlockMetric>
): { readonly metrics: DocumentMetrics; readonly update: DocumentMetricUpdate } {
  const active = new Set<number>();
  let wordCount = 0;
  let headingCount = 0;
  let linkCount = 0;
  let taskCount = 0;
  let reusedBlocks = 0;
  let recomputedBlocks = 0;
  for (const block of blocks) {
    active.add(block.id);
    let metric = cache.get(block.id);
    if (metric === undefined) {
      metric = Object.freeze({
        wordCount: countMarkdownDocumentWords(block),
        headingCount: collectMarkdownNodes(block, 'heading').length,
        linkCount: collectMarkdownNodes(block, 'link').length,
        taskCount: collectMarkdownNodes(block, 'listItem').filter((item) => item.task !== null).length
      });
      cache.set(block.id, metric);
      recomputedBlocks += 1;
    } else {
      reusedBlocks += 1;
    }
    wordCount += metric.wordCount;
    headingCount += metric.headingCount;
    linkCount += metric.linkCount;
    taskCount += metric.taskCount;
  }
  let removedBlocks = 0;
  for (const id of cache.keys()) {
    if (active.has(id)) continue;
    cache.delete(id);
    removedBlocks += 1;
  }
  return Object.freeze({
    metrics: Object.freeze({ wordCount, headingCount, linkCount, taskCount }),
    update: Object.freeze({ reusedBlocks, recomputedBlocks, removedBlocks })
  });
}
