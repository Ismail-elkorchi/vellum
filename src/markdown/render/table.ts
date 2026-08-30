import { measureTextCells, type TextWidthProfile } from '@ismail-elkorchi/terminal-ui/text';
import type {
  MarkdownTableAlignment,
  MarkdownTableNode,
  MarkdownTableRowNode,
  SourceSpan,
} from 'markspan';
import type { MarkdownTheme } from '../theme.js';
import { inlinePlainText, renderInline, type MarkdownRenderSpan } from './inline.js';
import type { MarkdownBlockResources } from './resources.js';
import {
  blankMarkdownRow,
  wrapMarkdownSpans,
  type MarkdownLayoutMedia,
  type MarkdownLayoutRow,
} from './wrap.js';

export function renderTable(
  node: MarkdownTableNode,
  width: number,
  theme: MarkdownTheme,
  widthProfile: TextWidthProfile,
  resources: MarkdownBlockResources = {}
): readonly MarkdownLayoutRow[] {
  const maximum = Math.max(1, Math.floor(width));
  if (maximum < node.align.length * 7 + 1) {
    return renderNarrowTable(node, maximum, theme, widthProfile, resources);
  }
  const sourceRows = [node.header, ...node.rows];
  const natural = node.align.map((_, column) => Math.max(3, ...sourceRows.map((row, rowIndex) => {
    const cell = row.cells[column];
    if (cell === undefined) return 0;
    const spans = renderInline(
      cell.children,
      theme,
      rowIndex === 0 ? theme.tableHeader : theme.body,
      undefined,
      resources,
    );
    return Math.max(
      ...spans.flatMap((span) => span.text.split('\n').map((text) => (
        measureTextCells(text, { widthProfile }).cells
      ))),
      ...spans.flatMap((span) => span.media === undefined ? [] : [Math.max(
        span.media.image.width,
        measureTextCells(`[Image: ${span.media.label}]`, { widthProfile }).cells,
      )]),
      0,
    );
  })));
  const borderCells = 3 * natural.length + 1;
  const available = Math.max(natural.length, maximum - borderCells);
  const widths = fitColumns(natural, available);
  const rows: MarkdownLayoutRow[] = [
    borderRow(widths, 'top', node.span.start, node.id, node.span, theme),
  ];
  rows.push(...renderGridRow(node, node.header, 0, widths, theme, widthProfile, resources));
  rows.push(borderRow(widths, 'header', node.delimiterSpan.start, node.id, node.delimiterSpan, theme));
  for (let index = 0; index < node.rows.length; index += 1) {
    const row = node.rows[index];
    if (row === undefined) continue;
    rows.push(...renderGridRow(node, row, index + 1, widths, theme, widthProfile, resources));
    if (index < node.rows.length - 1) {
      rows.push(borderRow(widths, 'body', row.span.end, node.id, row.span, theme));
    }
  }
  rows.push(borderRow(widths, 'bottom', node.span.end, node.id, node.span, theme));
  return Object.freeze(rows);
}

function renderGridRow(
  node: MarkdownTableNode,
  row: MarkdownTableRowNode,
  rowIndex: number,
  widths: readonly number[],
  theme: MarkdownTheme,
  widthProfile: TextWidthProfile,
  resources: MarkdownBlockResources,
): readonly MarkdownLayoutRow[] {
  const cellRows = widths.map((columnWidth, column) => {
    const cell = row.cells[column];
    return cell === undefined
      ? Object.freeze([blankMarkdownRow(row.span.start, row.id)])
      : wrapMarkdownSpans(
          renderInline(cell.children, theme, rowIndex === 0 ? theme.tableHeader : theme.body, undefined, resources),
          columnWidth,
          widthProfile,
        );
  });
  const rowHeight = Math.max(1, ...cellRows.map((lines) => lines.length));
  return Object.freeze(Array.from({ length: rowHeight }, (_, visualRow): MarkdownLayoutRow => {
    const spans: MarkdownRenderSpan[] = [synthetic('│ ', node.id, row.span, theme.tableBorder)];
    const media: MarkdownLayoutMedia[] = [];
    const sourceOffsets: number[] = [];
    let columnOffset = 2;
    for (let column = 0; column < widths.length; column += 1) {
      const cell = row.cells[column];
      const columnWidth = widths[column] ?? 1;
      const line = cellRows[column]?.[visualRow];
      const occupied = line === undefined ? 0 : rowWidth(line, widthProfile);
      const [leftPadding, rightPadding] = alignmentPadding(
        Math.max(0, columnWidth - occupied),
        node.align[column] ?? null,
      );
      const style = rowIndex === 0 ? theme.tableHeader : theme.body;
      if (leftPadding > 0) {
        spans.push(synthetic(' '.repeat(leftPadding), cell?.id ?? row.id, cell?.contentSpan ?? row.span, style));
      }
      if (line !== undefined) {
        spans.push(...line.inlineSpans);
        sourceOffsets.push(line.sourceOffset);
        for (const entry of line.media ?? []) {
          media.push(Object.freeze({ ...entry, column: columnOffset + leftPadding + entry.column }));
        }
      }
      if (rightPadding > 0) {
        spans.push(synthetic(' '.repeat(rightPadding), cell?.id ?? row.id, cell?.contentSpan ?? row.span, style));
      }
      spans.push(synthetic(
        column === widths.length - 1 ? ' │' : ' │ ',
        cell?.id ?? row.id,
        cell?.span ?? row.span,
        theme.tableBorder,
      ));
      columnOffset += columnWidth + 3;
    }
    const inlineSpans = Object.freeze(spans);
    return Object.freeze({
      spans: inlineSpans,
      inlineSpans,
      sourceOffset: visualRow === 0 ? row.span.start : Math.min(...sourceOffsets, row.span.end),
      nodeId: node.id,
      ...(media.length === 0 ? {} : { media: Object.freeze(media) }),
    });
  }));
}

function renderNarrowTable(
  node: MarkdownTableNode,
  width: number,
  theme: MarkdownTheme,
  widthProfile: TextWidthProfile,
  resources: MarkdownBlockResources
): readonly MarkdownLayoutRow[] {
  const rows: MarkdownLayoutRow[] = [];
  const dataRows = node.rows.length === 0 ? [node.header] : node.rows;
  for (let rowIndex = 0; rowIndex < dataRows.length; rowIndex += 1) {
    const row = dataRows[rowIndex];
    if (row === undefined) continue;
    for (let column = 0; column < node.align.length; column += 1) {
      const header = node.header.cells[column];
      const cell = row.cells[column];
      if (cell === undefined) continue;
      const label = inlinePlainText(header?.children ?? []).trim() || `Column ${String(column + 1)}`;
      const spans = [
        synthetic(`${label}: `, cell.id, cell.contentSpan, theme.tableHeader),
        ...renderInline(
          cell.children,
          theme,
          row === node.header ? theme.tableHeader : theme.body,
          undefined,
          resources,
        ),
      ];
      rows.push(...wrapMarkdownSpans(spans, width, widthProfile));
    }
    if (rowIndex < dataRows.length - 1) rows.push(blankMarkdownRow(row.span.end, node.id));
  }
  return Object.freeze(rows);
}

function borderRow(
  widths: readonly number[],
  kind: 'top' | 'header' | 'body' | 'bottom',
  sourceOffset: number,
  nodeId: number,
  sourceSpan: SourceSpan,
  theme: MarkdownTheme,
): MarkdownLayoutRow {
  const [left, middle, right, fill] = kind === 'top'
    ? ['┌', '┬', '┐', '─']
    : kind === 'header'
      ? ['╞', '╪', '╡', '═']
      : kind === 'bottom'
        ? ['└', '┴', '┘', '─']
        : ['├', '┼', '┤', '─'];
  const text = left + widths.map((value) => fill.repeat(value + 2)).join(middle) + right;
  const span = synthetic(text, nodeId, sourceSpan, theme.tableBorder);
  return Object.freeze({
    spans: Object.freeze([span]),
    inlineSpans: Object.freeze([span]),
    sourceOffset,
    nodeId,
  });
}

function alignmentPadding(remaining: number, alignment: MarkdownTableAlignment): readonly [number, number] {
  if (alignment === 'right') return Object.freeze([remaining, 0]);
  if (alignment === 'center') {
    const left = Math.floor(remaining / 2);
    return Object.freeze([left, remaining - left]);
  }
  return Object.freeze([0, remaining]);
}

function rowWidth(row: MarkdownLayoutRow, widthProfile: TextWidthProfile): number {
  const text = measureTextCells(row.inlineSpans.map((span) => span.text).join(''), { widthProfile }).cells;
  return Math.max(text, ...[...(row.media ?? [])].map((entry) => entry.column + entry.width), 0);
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
  return Object.freeze({ text, nodeId, sourceSpan, sourceMapping: 'anchor', style });
}
