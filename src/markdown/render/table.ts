import { measureTextCells } from '@ismail-elkorchi/terminal-ui/text';
import type { MarkdownTableNode, SourceSpan } from 'markspan';
import type { MarkdownTheme } from '../theme.js';
import { inlinePlainText, renderInline, type MarkdownRenderSpan } from './inline.js';
import type { MarkdownBlockResources } from './resources.js';

export interface RenderedTableRow {
  readonly spans: readonly MarkdownRenderSpan[];
  readonly sourceOffset: number;
}

export function renderTable(
  node: MarkdownTableNode,
  width: number,
  theme: MarkdownTheme,
  resources: MarkdownBlockResources = {}
): readonly RenderedTableRow[] {
  const rows = [node.header, ...node.rows];
  const natural = node.align.map((_, column) => Math.max(3, ...rows.map((row) => (
    measureTextCells(inlinePlainText(row.cells[column]?.children ?? [])).cells
  ))));
  const borderCells = 3 * natural.length + 1;
  const available = Math.max(natural.length, width - borderCells);
  const widths = fitColumns(natural, available);
  return Object.freeze(rows.map((row, rowIndex) => {
    const spans: MarkdownRenderSpan[] = [synthetic('| ', node.id, row.span, theme.tableBorder)];
    for (let column = 0; column < widths.length; column += 1) {
      const cell = row.cells[column];
      if (cell !== undefined) {
        const rendered = renderInline(cell.children, theme, rowIndex === 0 ? theme.tableHeader : theme.body, undefined, resources);
        spans.push(...rendered);
        const cells = measureTextCells(rendered.map((span) => span.text).join('')).cells;
        if (cells < (widths[column] ?? 1)) {
          spans.push(synthetic(' '.repeat((widths[column] ?? 1) - cells), cell.id, cell.contentSpan, theme.body));
        }
        spans.push(synthetic(column === widths.length - 1 ? ' |' : ' | ', cell.id, cell.span, theme.tableBorder));
      }
    }
    return Object.freeze({ spans: Object.freeze(spans), sourceOffset: row.span.start });
  }));
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
