import { measureTextCells, type TextWidthProfile } from '@ismail-elkorchi/terminal-ui/text';
import type { MarkdownTableNode, SourceSpan } from 'markspan';
import type { MarkdownTheme } from '../theme.js';
import { inlinePlainText, renderInline, type MarkdownRenderSpan } from './inline.js';
import type { MarkdownBlockResources } from './resources.js';
import { wrapMarkdownSpans } from './wrap.js';

export interface RenderedTableRow {
  readonly spans: readonly MarkdownRenderSpan[];
  readonly sourceOffset: number;
}

export function renderTable(
  node: MarkdownTableNode,
  width: number,
  theme: MarkdownTheme,
  widthProfile: TextWidthProfile,
  resources: MarkdownBlockResources = {}
): readonly RenderedTableRow[] {
  const rows = [node.header, ...node.rows];
  if (width < node.align.length * 4 + 1) {
    return renderNarrowTable(node, width, theme, widthProfile, resources);
  }
  const natural = node.align.map((_, column) => Math.max(3, ...rows.map((row) => (
    measureTextCells(inlinePlainText(row.cells[column]?.children ?? []), { widthProfile }).cells
  ))));
  const borderCells = 3 * natural.length + 1;
  const available = Math.max(natural.length, width - borderCells);
  const widths = fitColumns(natural, available);
  return Object.freeze(rows.flatMap((row, rowIndex) => {
    const cellLines = widths.map((columnWidth, column) => {
      const cell = row.cells[column];
      return cell === undefined
        ? Object.freeze([])
        : wrapMarkdownSpans(
            renderInline(cell.children, theme, rowIndex === 0 ? theme.tableHeader : theme.body, undefined, resources),
            columnWidth,
            widthProfile
          );
    });
    const rowHeight = Math.max(1, ...cellLines.map((lines) => lines.length));
    return Array.from({ length: rowHeight }, (_, visualRow): RenderedTableRow => {
      const spans: MarkdownRenderSpan[] = [synthetic('| ', node.id, row.span, theme.tableBorder)];
      const sourceOffsets: number[] = [];
      for (let column = 0; column < widths.length; column += 1) {
        const cell = row.cells[column];
        if (cell === undefined) continue;
        const line = cellLines[column]?.[visualRow];
        if (line !== undefined) {
          spans.push(...line.inlineSpans);
          sourceOffsets.push(line.sourceOffset);
        }
        const cells = measureTextCells(line?.inlineSpans.map((span) => span.text).join('') ?? '', { widthProfile }).cells;
        if (cells < (widths[column] ?? 1)) {
          spans.push(synthetic(' '.repeat((widths[column] ?? 1) - cells), cell.id, cell.contentSpan, theme.body));
        }
        spans.push(synthetic(column === widths.length - 1 ? ' |' : ' | ', cell.id, cell.span, theme.tableBorder));
      }
      return Object.freeze({
        spans: Object.freeze(spans),
        sourceOffset: visualRow === 0 ? row.span.start : Math.min(...sourceOffsets, row.span.end)
      });
    });
  }));
}

function renderNarrowTable(
  node: MarkdownTableNode,
  width: number,
  theme: MarkdownTheme,
  widthProfile: TextWidthProfile,
  resources: MarkdownBlockResources
): readonly RenderedTableRow[] {
  const rows = [node.header, ...node.rows];
  return Object.freeze(rows.flatMap((row, rowIndex) => row.cells.flatMap((cell, column) => {
    const spans = [
      synthetic(`[${String(rowIndex + 1)},${String(column + 1)}] `, cell.id, cell.span, theme.tableBorder),
      ...renderInline(cell.children, theme, rowIndex === 0 ? theme.tableHeader : theme.body, undefined, resources)
    ];
    return wrapMarkdownSpans(spans, width, widthProfile).map((line) => Object.freeze({
      spans: line.inlineSpans,
      sourceOffset: line.sourceOffset
    }));
  })));
}

function fitColumns(natural: readonly number[], available: number): readonly number[] {
  const values = natural.map((value) => Math.max(1, value));
  while (values.reduce((sum, value) => sum + value, 0) > available) {
    let index = 0;
    for (let candidate = 1; candidate < values.length; candidate += 1) {
      if ((values[candidate] ?? 0) > (values[index] ?? 0)) index = candidate;
    }
    if ((values[index] ?? 1) <= 1) break;
    values[index] = (values[index] ?? 1) - 1;
  }
  return Object.freeze(values);
}

function synthetic(
  text: string,
  nodeId: number,
  sourceSpan: SourceSpan,
  style: MarkdownTheme['body']
): MarkdownRenderSpan {
  return Object.freeze({ text, nodeId, sourceSpan, style });
}
