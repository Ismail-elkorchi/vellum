import type { RowOffsetMap } from '@ismail-elkorchi/terminal-ui/text';
import type { SourceSpan } from 'markspan';
import { measureTextCells } from '@ismail-elkorchi/terminal-ui/text';
import type { MarkdownPreviewLayout } from './layout.js';
import type { MarkdownPreviewActivation } from './layout.js';
import type { MarkdownAccessibleNode } from './accessibility.js';

export interface MarkdownPreviewComponent {
  readonly role: 'document';
  readonly label: string;
  readonly layout: MarkdownPreviewLayout;
  readonly rowOffsetMap: RowOffsetMap;
  readonly accessibility: MarkdownAccessibleNode;
  sourceSpanAt(row: number, column: number): SourceSpan | undefined;
  activationAt(row: number, column: number): MarkdownPreviewActivation | undefined;
}

export function markdownPreviewComponent(
  label: string,
  layout: MarkdownPreviewLayout
): MarkdownPreviewComponent {
  return Object.freeze({
    role: 'document',
    label,
    layout,
    rowOffsetMap: layout.rowOffsetMap,
    accessibility: layout.accessibility,
    sourceSpanAt(row: number, column: number) {
      const line = layout.lines[Math.max(0, Math.min(layout.lines.length - 1, Math.floor(row)))];
      if (line === undefined) return undefined;
      let consumed = 0;
      for (const span of line.inlineSpans) {
        const next = consumed + measureTextCells(span.text).cells;
        if (column < next) return span.activation === undefined
          ? layout.blocks.find((block) => block.sourceSpan.start <= line.sourceOffset && line.sourceOffset <= block.sourceSpan.end)?.sourceSpan ?? span.sourceSpan
          : span.sourceSpan;
        consumed = next;
      }
      return line.inlineSpans.at(-1)?.sourceSpan;
    },
    activationAt(row: number, column: number) {
      const normalizedRow = Math.max(0, Math.min(layout.lines.length - 1, Math.floor(row)));
      const line = layout.lines[normalizedRow];
      if (line === undefined) return undefined;
      let consumed = 0;
      for (const span of line.inlineSpans) {
        const next = consumed + measureTextCells(span.text).cells;
        if (column < next) {
          const sourceSpan = span.activation === undefined
            ? layout.blocks.find((block) => block.sourceSpan.start <= line.sourceOffset && line.sourceOffset <= block.sourceSpan.end)?.sourceSpan ?? span.sourceSpan
            : span.sourceSpan;
          return Object.freeze({
            row: normalizedRow,
            sourceSpan,
            ...(span.activation === undefined ? {} : { activation: span.activation })
          });
        }
        consumed = next;
      }
      const span = line.inlineSpans.at(-1);
      return span === undefined ? undefined : Object.freeze({
        row: normalizedRow,
        sourceSpan: span.sourceSpan,
        ...(span.activation === undefined ? {} : { activation: span.activation })
      });
    }
  });
}
