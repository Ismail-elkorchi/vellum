import type { TerminalStyle } from '@ismail-elkorchi/terminal-ui/renderer';
import type { MarkdownCodeBlockNode } from 'markspan';
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
    if (start > cursor) spans.push(codeSpan(node, node.value.slice(cursor, start), cursor, start, theme.codeBlock));
    if (end > start) spans.push(codeSpan(node, node.value.slice(start, end), start, end, token.style));
    cursor = end;
  }
  if (cursor < node.value.length || spans.length === 0) {
    spans.push(codeSpan(node, node.value.slice(cursor), cursor, node.value.length, theme.codeBlock));
  }
  return Object.freeze(spans);
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
    sourceSpan: Object.freeze({
      start: Math.min(node.contentSpan.end, node.contentSpan.start + start),
      end: Math.min(node.contentSpan.end, node.contentSpan.start + end)
    })
  });
}
