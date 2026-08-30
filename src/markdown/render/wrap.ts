import { measureTextCells, type TextWidthProfile } from '@ismail-elkorchi/terminal-ui/text';
import type { RenderLine, TerminalStyle } from '@ismail-elkorchi/terminal-ui/renderer';
import type { MarkdownRenderMedia } from './image.js';
import { previewImageSize } from './image.js';
import type { MarkdownRenderSpan } from './inline.js';

export interface MarkdownLayoutMedia {
  readonly column: number;
  readonly width: number;
  readonly height: number;
  readonly media: MarkdownRenderMedia;
}

export interface MarkdownLayoutRow extends RenderLine {
  readonly sourceOffset: number;
  readonly nodeId: number;
  readonly inlineSpans: readonly MarkdownRenderSpan[];
  readonly media?: readonly MarkdownLayoutMedia[];
  readonly background?: TerminalStyle;
}

interface GraphemeSpan {
  readonly span: MarkdownRenderSpan;
  readonly text: string;
  readonly cells: number;
  readonly sourceOffset: number;
}

/** Wraps proportional Markdown text at word boundaries and hard-wraps only oversized words. */
export function wrapMarkdownSpans(
  spans: readonly MarkdownRenderSpan[],
  width: number,
  widthProfile?: TextWidthProfile
): readonly MarkdownLayoutRow[] {
  const maximum = Math.max(1, Math.floor(width));
  const rows: MarkdownLayoutRow[] = [];
  let row: GraphemeSpan[] = [];
  let word: GraphemeSpan[] = [];
  let cells = 0;
  let pendingSpace: GraphemeSpan | undefined;
  let wrappedAtBoundary = false;

  const emitRow = (emptyRowSourceOffset?: number, wrapped = false): void => {
    if (row.length === 0 && emptyRowSourceOffset === undefined) return;
    rows.push(layoutRow(row, spans, emptyRowSourceOffset));
    row = [];
    cells = 0;
    pendingSpace = undefined;
    wrappedAtBoundary = wrapped;
  };

  const appendWord = (): void => {
    if (word.length === 0) return;
    const wordCells = word.reduce((total, value) => total + value.cells, 0);
    const separatorCells = row.length > 0 && pendingSpace !== undefined ? 1 : 0;
    if (row.length > 0 && cells + separatorCells + wordCells > maximum) emitRow(undefined, true);
    if (row.length > 0 && pendingSpace !== undefined) {
      row.push(pendingSpace);
      cells += 1;
    }
    pendingSpace = undefined;
    for (const value of word) {
      if (row.length > 0 && cells + value.cells > maximum) emitRow(undefined, true);
      wrappedAtBoundary = false;
      row.push(value);
      cells += value.cells;
      if (cells >= maximum) emitRow(undefined, true);
    }
    word = [];
  };

  const appendMedia = (span: MarkdownRenderSpan): void => {
    appendWord();
    if (row.length > 0) emitRow();
    pendingSpace = undefined;
    const media = span.media;
    if (media === undefined) return;
    const size = previewImageSize(
      media.image,
      maximum,
      12,
      measureTextCells(`[Image: ${media.label}]`, {
        ...(widthProfile === undefined ? {} : { widthProfile }),
      }).cells,
    );
    for (let index = 0; index < size.height; index += 1) {
      rows.push(Object.freeze({
        spans: Object.freeze([]),
        inlineSpans: Object.freeze([]),
        sourceOffset: span.sourceSpan.start,
        nodeId: span.nodeId,
        ...(index === 0 ? {
          media: Object.freeze([Object.freeze({
            column: 0,
            width: size.width,
            height: size.height,
            media,
          })])
        } : {}),
      }));
    }
    wrappedAtBoundary = true;
  };

  for (const span of spans) {
    if (span.media !== undefined) {
      appendMedia(span);
      continue;
    }
    const measured = measureTextCells(span.text, { ...(widthProfile === undefined ? {} : { widthProfile }) });
    for (const grapheme of measured.graphemes) {
      const sourceOffset = graphemeSourceOffset(span, grapheme.startOffset);
      if (grapheme.text === '\n') {
        appendWord();
        pendingSpace = undefined;
        if (row.length > 0) emitRow(sourceOffset);
        else if (wrappedAtBoundary) wrappedAtBoundary = false;
        else emitRow(sourceOffset);
        continue;
      }
      const value: GraphemeSpan = { span, text: grapheme.text, cells: grapheme.cells, sourceOffset };
      if (/^\s$/u.test(grapheme.text)) {
        appendWord();
        if (row.length > 0) pendingSpace = { ...value, text: ' ', cells: 1 };
        continue;
      }
      word.push(value);
    }
  }
  appendWord();
  if (row.length > 0) emitRow();
  if (rows.length === 0) emitRow(spans[0]?.sourceSpan.start ?? 0);
  return Object.freeze(rows);
}

/** Wraps code and other preformatted text without changing its whitespace. */
export function wrapMarkdownPreformattedSpans(
  spans: readonly MarkdownRenderSpan[],
  width: number,
  widthProfile?: TextWidthProfile
): readonly MarkdownLayoutRow[] {
  const maximum = Math.max(1, Math.floor(width));
  const rows: MarkdownLayoutRow[] = [];
  let row: GraphemeSpan[] = [];
  let cells = 0;
  let wrappedAtBoundary = false;

  const emitRow = (emptyRowSourceOffset?: number, wrapped = false): void => {
    if (row.length === 0 && emptyRowSourceOffset === undefined) return;
    rows.push(layoutRow(row, spans, emptyRowSourceOffset));
    row = [];
    cells = 0;
    wrappedAtBoundary = wrapped;
  };

  for (const span of spans) {
    if (span.media !== undefined) {
      if (row.length > 0) emitRow();
      const size = previewImageSize(
        span.media.image,
        maximum,
        12,
        measureTextCells(`[Image: ${span.media.label}]`, {
          ...(widthProfile === undefined ? {} : { widthProfile }),
        }).cells,
      );
      for (let index = 0; index < size.height; index += 1) {
        rows.push(Object.freeze({
          spans: Object.freeze([]),
          inlineSpans: Object.freeze([]),
          sourceOffset: span.sourceSpan.start,
          nodeId: span.nodeId,
          ...(index === 0 ? {
            media: Object.freeze([Object.freeze({
              column: 0,
              width: size.width,
              height: size.height,
              media: span.media,
            })])
          } : {}),
        }));
      }
      wrappedAtBoundary = true;
      continue;
    }
    const measured = measureTextCells(span.text, { ...(widthProfile === undefined ? {} : { widthProfile }) });
    for (const grapheme of measured.graphemes) {
      const sourceOffset = graphemeSourceOffset(span, grapheme.startOffset);
      if (grapheme.text === '\n') {
        if (row.length > 0) emitRow(sourceOffset);
        else if (wrappedAtBoundary) wrappedAtBoundary = false;
        else emitRow(sourceOffset);
        continue;
      }
      if (row.length > 0 && cells + grapheme.cells > maximum) emitRow(undefined, true);
      wrappedAtBoundary = false;
      row.push({ span, text: grapheme.text, cells: grapheme.cells, sourceOffset });
      cells += grapheme.cells;
      if (cells >= maximum) emitRow(undefined, true);
    }
  }
  if (row.length > 0) emitRow();
  if (rows.length === 0) emitRow(spans[0]?.sourceSpan.start ?? 0);
  return Object.freeze(rows);
}

function layoutRow(
  values: readonly GraphemeSpan[],
  sourceSpans: readonly MarkdownRenderSpan[],
  emptyRowSourceOffset?: number,
): MarkdownLayoutRow {
  const first = values[0];
  const inlineSpans = mergeGraphemes(values);
  return Object.freeze({
    spans: inlineSpans,
    sourceOffset: first?.sourceOffset ?? emptyRowSourceOffset ?? sourceSpans[0]?.sourceSpan.start ?? 0,
    nodeId: first?.span.nodeId ?? sourceSpans[0]?.nodeId ?? 0,
    inlineSpans,
  });
}

function graphemeSourceOffset(span: MarkdownRenderSpan, graphemeOffset: number): number {
  return span.sourceMapping === 'identity'
    ? span.sourceSpan.start + graphemeOffset
    : span.sourceSpan.start;
}

function mergeGraphemes(values: readonly GraphemeSpan[]): readonly MarkdownRenderSpan[] {
  const spans: MarkdownRenderSpan[] = [];
  for (const value of values) {
    const previous = spans.at(-1);
    if (previous !== undefined
      && previous.nodeId === value.span.nodeId
      && previous.style === value.span.style
      && previous.link === value.span.link
      && previous.sourceMapping === value.span.sourceMapping
      && previous.activation === value.span.activation) {
      spans[spans.length - 1] = Object.freeze({
        ...previous,
        text: previous.text + value.text,
        sourceSpan: Object.freeze({
          start: previous.sourceSpan.start,
          end: Math.max(previous.sourceSpan.end, value.span.sourceSpan.end)
        })
      });
    } else {
      spans.push(Object.freeze({ ...value.span, text: value.text }));
    }
  }
  return Object.freeze(spans);
}

export function blankMarkdownRow(
  sourceOffset: number,
  nodeId: number,
  spans: readonly MarkdownRenderSpan[] = Object.freeze([]),
): MarkdownLayoutRow {
  return Object.freeze({
    spans,
    inlineSpans: spans,
    sourceOffset,
    nodeId,
  });
}

export function shiftMarkdownRow(
  row: MarkdownLayoutRow,
  prefix: readonly MarkdownRenderSpan[],
  prefixWidth: number,
): MarkdownLayoutRow {
  const inlineSpans = Object.freeze([...prefix, ...row.inlineSpans]);
  const media = row.media?.map((entry) => Object.freeze({ ...entry, column: entry.column + prefixWidth }));
  return Object.freeze({
    ...row,
    spans: inlineSpans,
    inlineSpans,
    ...(media === undefined ? {} : { media: Object.freeze(media) }),
  });
}
