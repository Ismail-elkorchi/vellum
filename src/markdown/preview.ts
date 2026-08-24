import {
  MarkdownBudgetExceededError,
  countMarkdownDocumentWords,
  createMarkdownDocumentSession,
  type MarkdownDocumentSession,
  type MarkdownSessionSnapshot,
  type MarkdownSessionUpdate,
  type MarkdownTextEdit
} from 'markspan';

export interface MarkdownPreviewIdentity {
  readonly documentId: number;
  readonly generation: number;
}

export interface ReadyMarkdownPreview {
  readonly kind: 'ready';
  readonly documentId: number;
  readonly sourceRevision: number;
  readonly identity: MarkdownPreviewIdentity;
  readonly snapshot: MarkdownSessionSnapshot;
  readonly wordCount: number;
  readonly update: MarkdownSessionUpdate | null;
}

export interface FailedMarkdownPreview {
  readonly kind: 'failed';
  readonly documentId: number;
  readonly sourceRevision: number;
  readonly identity: MarkdownPreviewIdentity;
  readonly source: string;
  readonly message: string;
}

export type MarkdownPreview = ReadyMarkdownPreview | FailedMarkdownPreview;

export interface MarkdownPreviewEngine {
  open(documentId: number, sourceRevision: number, source: string): MarkdownPreview;
  update(documentId: number, sourceRevision: number, source: string): MarkdownPreview;
}

interface ActiveSession {
  readonly documentId: number;
  readonly identity: MarkdownPreviewIdentity;
  readonly session: MarkdownDocumentSession;
}

function changedRange(previous: string, next: string): MarkdownTextEdit | null {
  if (previous === next) return null;

  const sharedLimit = Math.min(previous.length, next.length);
  let start = 0;
  while (start < sharedLimit && previous.charCodeAt(start) === next.charCodeAt(start)) start += 1;

  let previousEnd = previous.length;
  let nextEnd = next.length;
  while (
    previousEnd > start
    && nextEnd > start
    && previous.charCodeAt(previousEnd - 1) === next.charCodeAt(nextEnd - 1)
  ) {
    previousEnd -= 1;
    nextEnd -= 1;
  }

  return Object.freeze({
    span: Object.freeze({ start, end: previousEnd }),
    text: next.slice(start, nextEnd)
  });
}

function readyPreview(
  active: ActiveSession,
  sourceRevision: number,
  snapshot: MarkdownSessionSnapshot,
  update: MarkdownSessionUpdate | null
): ReadyMarkdownPreview {
  return Object.freeze({
    kind: 'ready',
    documentId: active.documentId,
    sourceRevision,
    identity: active.identity,
    snapshot,
    wordCount: countMarkdownDocumentWords(snapshot.document.tree),
    update
  });
}

function failedPreview(
  documentId: number,
  sourceRevision: number,
  identity: MarkdownPreviewIdentity,
  source: string,
  error: MarkdownBudgetExceededError
): FailedMarkdownPreview {
  return Object.freeze({
    kind: 'failed',
    documentId,
    sourceRevision,
    identity,
    source,
    message: error.message
  });
}

export function createMarkdownPreviewEngine(): MarkdownPreviewEngine {
  let generation = 0;
  let active: ActiveSession | undefined;
  let current: MarkdownPreview | undefined;

  const open = (
    documentId: number,
    sourceRevision: number,
    source: string
  ): MarkdownPreview => {
    generation += 1;
    const identity = Object.freeze({ documentId, generation });
    try {
      const session = createMarkdownDocumentSession(source, { dialect: 'gfm' });
      active = Object.freeze({ documentId, identity, session });
      current = readyPreview(active, sourceRevision, session.snapshot(), null);
      return current;
    } catch (error) {
      active = undefined;
      if (error instanceof MarkdownBudgetExceededError) {
        current = failedPreview(documentId, sourceRevision, identity, source, error);
        return current;
      }
      throw error;
    }
  };

  return Object.freeze({
    open,
    update(documentId: number, sourceRevision: number, source: string): MarkdownPreview {
      if (current !== undefined) {
        if (
          documentId < current.documentId
          || (documentId === current.documentId && sourceRevision < current.sourceRevision)
        ) return current;
        if (
          documentId === current.documentId
          && sourceRevision === current.sourceRevision
        ) {
          if (markdownPreviewSource(current) !== source) {
            throw new TypeError('A source revision cannot identify different Markdown text.');
          }
          return current;
        }
      }

      if (active === undefined || active.documentId !== documentId) {
        return open(documentId, sourceRevision, source);
      }

      const previous = active.session.snapshot();
      const edit = changedRange(previous.source, source);
      if (edit === null) {
        current = readyPreview(active, sourceRevision, previous, null);
        return current;
      }

      try {
        const update = active.session.applyEdits([edit]);
        current = readyPreview(active, sourceRevision, update.snapshot, update);
        return current;
      } catch (error) {
        if (error instanceof MarkdownBudgetExceededError) {
          current = failedPreview(documentId, sourceRevision, active.identity, source, error);
          return current;
        }
        throw error;
      }
    }
  });
}

export function markdownPreviewSource(preview: MarkdownPreview): string {
  return preview.kind === 'ready' ? preview.snapshot.source : preview.source;
}
