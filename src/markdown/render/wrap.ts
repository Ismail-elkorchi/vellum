import { measureTextCells, type TextWidthProfile } from '@ismail-elkorchi/terminal-ui/text';
import type { RenderLine } from '@ismail-elkorchi/terminal-ui/renderer';
import type { MarkdownRenderSpan } from './inline.js';

export interface MarkdownLayoutLine extends RenderLine {
  readonly sourceOffset: number;
  readonly nodeId: number;
  readonly inlineSpans: readonly MarkdownRenderSpan[];
}

interface GraphemeSpan {
  readonly span: MarkdownRenderSpan;
  readonly text: string;
  readonly cells: number;
  readonly sourceOffset: number;
}

export function wrapMarkdownSpans(
  spans: readonly MarkdownRenderSpan[],
  width: number,
  widthProfile?: TextWidthProfile
): readonly MarkdownLayoutLine[] {
  const maximum = Math.max(1, Math.floor(width));
  const lines: MarkdownLayoutLine[] = [];
  let row: GraphemeSpan[] = [];
  let cells = 0;
  let pendingSpace: GraphemeSpan | undefined;
  const flush = (force = false, emptyRowSourceOffset?: number): void => {
    if (!force && row.length === 0) return;
    const first = row[0];
    const inlineSpans = mergeGraphemes(row);
    lines.push(Object.freeze({
      spans: inlineSpans,
      sourceOffset: first?.sourceOffset ?? emptyRowSourceOffset ?? spans[0]?.sourceSpan.start ?? 0,
      nodeId: first?.span.nodeId ?? spans[0]?.nodeId ?? 0,
      inlineSpans
    }));
    row = [];
    cells = 0;
    pendingSpace = undefined;
  };
  for (const span of spans) {
    const measured = measureTextCells(span.text, { ...(widthProfile === undefined ? {} : { widthProfile }) });
    for (const grapheme of measured.graphemes) {
      const sourceOffset = span.sourceSpan.end - span.sourceSpan.start === span.text.length
        ? span.sourceSpan.start + grapheme.startOffset
        : span.sourceSpan.start;
      if (grapheme.text === '\n') {
        flush(true, sourceOffset);
        continue;
      }
      const value: GraphemeSpan = { span, text: grapheme.text, cells: grapheme.cells, sourceOffset };
      if (/^\s$/u.test(grapheme.text)) {
        if (row.length > 0) pendingSpace = { ...value, text: ' ', cells: 1 };
        continue;
      }
      const extra = pendingSpace === undefined || row.length === 0 ? 0 : 1;
      if (row.length > 0 && cells + extra + grapheme.cells > maximum) flush();
      if (pendingSpace !== undefined && row.length > 0) {
        row.push(pendingSpace);
        cells += 1;
      }
      pendingSpace = undefined;
      row.push(value);
      cells += grapheme.cells;
      if (cells >= maximum) flush();
    }
  }
  flush(lines.length === 0);
  return Object.freeze(lines);
}

function mergeGraphemes(values: readonly GraphemeSpan[]): readonly MarkdownRenderSpan[] {
  const spans: MarkdownRenderSpan[] = [];
  for (const value of values) {
    const previous = spans.at(-1);
    if (previous !== undefined
      && previous.nodeId === value.span.nodeId
      && previous.style === value.span.style
      && previous.link === value.span.link
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
