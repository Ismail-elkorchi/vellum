import { measuredGraphemes, measureTextCells, sanitizeTerminalControlText, type TextWidthProfile } from '@ismail-elkorchi/terminal-ui/text';
import type { RenderLine, TerminalStyle } from '@ismail-elkorchi/terminal-ui/renderer';
import type { MarkdownRenderMedia } from './image.js';
import { previewImageSize } from './image.js';
import { finishMarkdownRender, type MarkdownRenderWork } from './work.js';
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
  readonly sourceEnd: number;
  readonly sourceMapping: MarkdownRenderSpan['sourceMapping'];
}

/** Wraps proportional Markdown text at word boundaries and hard-wraps only oversized words. */
export function wrapMarkdownSpans(
  spans: readonly MarkdownRenderSpan[],
  width: number,
  widthProfile?: TextWidthProfile
): readonly MarkdownLayoutRow[] {
  return finishMarkdownRender(wrapMarkdownSpansWork(spans, width, widthProfile));
}

export function* wrapMarkdownSpansWork(
  spans: readonly MarkdownRenderSpan[],
  width: number,
  widthProfile?: TextWidthProfile,
): MarkdownRenderWork<readonly MarkdownLayoutRow[]> {
  const maximum = Math.max(1, Math.floor(width));
  const rows: MarkdownLayoutRow[] = [];
  let row: GraphemeSpan[] = [];
  let word: GraphemeSpan[] = [];
  let pendingWordCells = 0;
  let oversizedWord = false;
  let cells = 0;
  let pendingSpace: GraphemeSpan | undefined;
  let wrappedAtBoundary = false;
  const sourceLine = { column: 0 };

  const emitRow = (emptyRowSourceOffset?: number, wrapped = false): void => {
    if (row.length === 0 && emptyRowSourceOffset === undefined) return;
    rows.push(layoutRow(row, spans, emptyRowSourceOffset));
    row = [];
    cells = 0;
    pendingSpace = undefined;
    wrappedAtBoundary = wrapped;
  };

  const appendValue = (value: GraphemeSpan): void => {
    if (row.length > 0 && cells + value.cells > maximum) emitRow(undefined, true);
    wrappedAtBoundary = false;
    row.push(value);
    cells += value.cells;
    if (cells >= maximum) emitRow(undefined, true);
  };

  function* appendWord(): MarkdownRenderWork<void> {
    if (word.length === 0) return;
    const wordCells = pendingWordCells;
    const separatorCells = row.length > 0 && pendingSpace !== undefined ? 1 : 0;
    if (row.length > 0 && cells + separatorCells + wordCells > maximum) emitRow(undefined, true);
    if (row.length > 0 && pendingSpace !== undefined) {
      row.push(pendingSpace);
      cells += 1;
    }
    pendingSpace = undefined;
    for (const value of word) {
      yield;
      appendValue(value);
    }
    word = [];
    pendingWordCells = 0;
  };

  function* appendMedia(span: MarkdownRenderSpan): MarkdownRenderWork<void> {
    yield* appendWord();
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
      yield* appendMedia(span);
      oversizedWord = false;
      continue;
    }
    for (const value of sourceGraphemes(span, sourceLine, widthProfile)) {
      yield;
      if (value === undefined) continue;
      const { text, sourceOffset } = value;
      if (text === '\n') {
        yield* appendWord();
        oversizedWord = false;
        pendingSpace = undefined;
        if (row.length > 0) emitRow(sourceOffset);
        else if (wrappedAtBoundary) wrappedAtBoundary = false;
        else emitRow(sourceOffset);
        continue;
      }
      if (span.whitespace !== 'preserve' && /^\s$/u.test(text)) {
        yield* appendWord();
        oversizedWord = false;
        if (row.length > 0) pendingSpace = { ...value, text: ' ', cells: 1 };
        continue;
      }
      if (oversizedWord) {
        appendValue(value);
      } else {
        word.push(value);
        pendingWordCells += value.cells;
        if (pendingWordCells > maximum) {
          yield* appendWord();
          oversizedWord = true;
        }
      }
    }
  }
  yield* appendWord();
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
  return finishMarkdownRender(wrapMarkdownPreformattedSpansWork(spans, width, widthProfile));
}

export function* wrapMarkdownPreformattedSpansWork(
  spans: readonly MarkdownRenderSpan[],
  width: number,
  widthProfile?: TextWidthProfile,
): MarkdownRenderWork<readonly MarkdownLayoutRow[]> {
  const maximum = Math.max(1, Math.floor(width));
  const rows: MarkdownLayoutRow[] = [];
  let row: GraphemeSpan[] = [];
  let cells = 0;
  let wrappedAtBoundary = false;
  const sourceLine = { column: 0 };

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
    for (const value of sourceGraphemes(span, sourceLine, widthProfile)) {
      yield;
      if (value === undefined) continue;
      const { text, sourceOffset } = value;
      if (text === '\n') {
        if (row.length > 0) emitRow(sourceOffset);
        else if (wrappedAtBoundary) wrappedAtBoundary = false;
        else emitRow(sourceOffset);
        continue;
      }
      if (row.length > 0 && cells + value.cells > maximum) emitRow(undefined, true);
      wrappedAtBoundary = false;
      row.push(value);
      cells += value.cells;
      if (cells >= maximum) emitRow(undefined, true);
    }
  }
  if (row.length > 0) emitRow();
  if (rows.length === 0) emitRow(spans[0]?.sourceSpan.start ?? 0);
  return Object.freeze(rows);
}

/** Natural cell width using the same safe projection as wrapped content. */
export function* measureMarkdownSpanWidthWork(
  span: MarkdownRenderSpan,
  widthProfile: TextWidthProfile,
): MarkdownRenderWork<number> {
  let maximum = 0;
  let cells = 0;
  if (span.text.length <= 256) {
    yield;
    for (const line of span.text.split('\n')) {
      maximum = Math.max(maximum, measureTextCells(line, { widthProfile }).cells);
    }
    return maximum;
  }
  for (const value of sourceGraphemes(span, { column: 0 }, widthProfile)) {
    yield;
    if (value === undefined) continue;
    if (value.text === '\n') { maximum = Math.max(maximum, cells); cells = 0; }
    else cells += value.cells;
  }
  return Math.max(maximum, cells);
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

/** Keep terminal projection coordinates separate from the original source units. */
function* sourceGraphemes(
  span: MarkdownRenderSpan,
  sourceLine: { column: number },
  widthProfile?: TextWidthProfile,
): Generator<GraphemeSpan | undefined> {
  const options = widthProfile === undefined ? {} : { widthProfile };
  if (!/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u.test(span.text)) {
    const graphemes = span.text.length <= 256
      ? measureTextCells(span.text, options).graphemes
      : measuredGraphemes(span.text, options);
    for (const grapheme of graphemes) {
      sourceLine.column = grapheme.text === '\n' ? 0 : sourceLine.column + grapheme.cells;
      yield {
        span, text: grapheme.text, cells: grapheme.cells,
        sourceOffset: graphemeSourceOffset(span, grapheme.startOffset),
        sourceEnd: span.sourceMapping === 'identity' ? span.sourceSpan.start + grapheme.endOffsetExclusive : span.sourceSpan.end,
        sourceMapping: span.sourceMapping,
      };
    }
    return;
  }

  // Strip unsafe sequences without expanding tabs. The original source units
  // remain authoritative while terminal columns advance independently.
  const sanitized = sanitizeTerminalControlText(span.text);
  let projectedText = span.text;
  let sourceOffsets: Uint32Array | undefined;
  if (sanitized.removedControlSequences.length > 0 || span.text.includes('\r')) {
    sourceOffsets = new Uint32Array(span.text.length);
    const pieces: string[] = [];
    let removedIndex = 0;
    let projectedOffset = 0;
    for (let offset = 0; offset < span.text.length;) {
      if (offset % 1024 === 0) yield undefined;
      const removed = sanitized.removedControlSequences[removedIndex];
      if (removed !== undefined && offset === removed.codeUnitOffset) {
        offset += removed.sequence.length;
        removedIndex += 1;
        continue;
      }
      sourceOffsets[projectedOffset++] = offset;
      if (span.text[offset] === '\r') {
        pieces.push('\n');
        offset += span.text[offset + 1] === '\n' ? 2 : 1;
      } else {
        pieces.push(span.text[offset] ?? '');
        offset += 1;
      }
    }
    projectedText = pieces.join('');
  }
  for (const grapheme of measuredGraphemes(projectedText, options)) {
    const sourceOffset = graphemeSourceOffset(span, sourceOffsets === undefined ? grapheme.startOffset : sourceOffsets[grapheme.startOffset] ?? 0);
    const sourceEnd = span.sourceMapping === 'identity'
      ? span.sourceSpan.start + (sourceOffsets === undefined ? grapheme.endOffsetExclusive : (sourceOffsets[grapheme.endOffsetExclusive - 1] ?? 0) + 1)
      : span.sourceSpan.end;
    if (grapheme.text === '\t') {
      const spaces = 4 - sourceLine.column % 4;
      for (let index = 0; index < spaces; index += 1) {
        yield { span, text: ' ', cells: 1, sourceOffset, sourceEnd, sourceMapping: 'anchor' };
      }
      sourceLine.column += spaces;
    } else {
      sourceLine.column = grapheme.text === '\n' ? 0 : sourceLine.column + grapheme.cells;
      yield {
        span, text: grapheme.text, cells: grapheme.cells, sourceOffset, sourceEnd,
        sourceMapping: span.sourceMapping === 'identity' && sourceEnd - sourceOffset === grapheme.text.length ? 'identity' : 'anchor',
      };
    }
  }
}

function mergeGraphemes(values: readonly GraphemeSpan[]): readonly MarkdownRenderSpan[] {
  const spans: MarkdownRenderSpan[] = [];
  let first: MarkdownRenderSpan | undefined;
  let start = 0;
  let end = 0;
  let mapping: MarkdownRenderSpan['sourceMapping'] = 'anchor';
  let text: string[] = [];
  const flush = (): void => {
    if (first === undefined) return;
    spans.push(Object.freeze({
      ...first,
      text: text.join(''),
      sourceSpan: Object.freeze({ start, end }),
      sourceMapping: mapping,
    }));
  };
  for (const value of values) {
    if (first === undefined
      || first.nodeId !== value.span.nodeId
      || first.style !== value.span.style
      || first.link !== value.span.link
      || mapping !== value.sourceMapping
      || (mapping === 'identity' && end !== value.sourceOffset)
      || first.activation !== value.span.activation
      || first.whitespace !== value.span.whitespace) {
      flush();
      first = value.span;
      start = value.sourceOffset;
      end = value.sourceEnd;
      mapping = value.sourceMapping;
      text = [];
    }
    text.push(value.text);
    end = Math.max(end, value.sourceEnd);
  }
  flush();
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
