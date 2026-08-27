import { mergeTerminalStyles, type TerminalStyle } from '@ismail-elkorchi/terminal-ui/renderer';
import { markdownCodeValueSourceSpan, type MarkdownCodeBlockNode } from 'markspan';
import type { MarkdownTheme } from '../theme.js';
import type { MarkdownRenderSpan } from './inline.js';

export interface HighlightToken {
  readonly span: { readonly start: number; readonly end: number };
  readonly style: TerminalStyle;
}

export interface HighlightedCode {
  readonly language: string;
  readonly sourceHash: string;
  readonly tokens: readonly HighlightToken[];
}

export function renderCodeBlock(
  node: MarkdownCodeBlockNode,
  theme: MarkdownTheme,
  highlighted?: HighlightedCode
): readonly MarkdownRenderSpan[] {
  const spans: MarkdownRenderSpan[] = [];
  if (node.language !== null) {
    spans.push(Object.freeze({
      text: node.language + '\n',
      style: theme.codeLanguageLabel,
      nodeId: node.id,
      sourceSpan: node.infoSpan ?? node.span
    }));
  }
  let cursor = 0;
  for (const token of highlighted?.tokens ?? []) {
    const start = Math.max(cursor, Math.min(node.value.length, token.span.start));
    const end = Math.max(start, Math.min(node.value.length, token.span.end));
    if (start > cursor) appendCodeSpans(spans, node, cursor, start, theme.codeBlock);
    if (end > start) {
      appendCodeSpans(
        spans,
        node,
        start,
        end,
        mergeTerminalStyles(theme.codeBlock, token.style) ?? theme.codeBlock
      );
    }
    cursor = end;
  }
  if (cursor < node.value.length) {
    appendCodeSpans(spans, node, cursor, node.value.length, theme.codeBlock);
  } else if (node.value.length === 0 && spans.length === (node.language === null ? 0 : 1)) {
    spans.push(codeSpan(node, '', 0, 0, theme.codeBlock));
  }
  return Object.freeze(spans);
}

function appendCodeSpans(
  output: MarkdownRenderSpan[],
  node: MarkdownCodeBlockNode,
  start: number,
  end: number,
  style: TerminalStyle
): void {
  let cursor = start;
  for (const segment of node.valueSourceMap.segments) {
    const segmentStart = Math.max(start, segment.valueStart);
    const segmentEnd = Math.min(end, segment.valueEnd);
    if (segmentEnd <= segmentStart) continue;
    if (segmentStart > cursor) {
      output.push(codeSpan(node, node.value.slice(cursor, segmentStart), cursor, segmentStart, style));
    }
    output.push(codeSpan(node, node.value.slice(segmentStart, segmentEnd), segmentStart, segmentEnd, style));
    cursor = segmentEnd;
  }
  if (cursor < end) output.push(codeSpan(node, node.value.slice(cursor, end), cursor, end, style));
}

function codeSpan(
  node: MarkdownCodeBlockNode,
  text: string,
  start: number,
  end: number,
  style: TerminalStyle
): MarkdownRenderSpan {
  return Object.freeze({
    text,
    style,
    nodeId: node.id,
    sourceSpan: markdownCodeValueSourceSpan(node, start, end)
  });
}
