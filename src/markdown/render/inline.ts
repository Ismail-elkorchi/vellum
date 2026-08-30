import {
  mergeTerminalStyles,
  type RenderSpan,
  type TerminalLink,
  type TerminalStyle
} from '@ismail-elkorchi/terminal-ui/renderer';
import { sanitizeTerminalText } from '@ismail-elkorchi/terminal-ui/text';
import type { MarkdownInlineNode, SourceSpan } from 'markspan';
import type { MarkdownTheme } from '../theme.js';
import { footnoteReferenceSpan } from './footnote.js';
import { imagePreviewSpan, type MarkdownRenderMedia } from './image.js';
import type { MarkdownBlockResources } from './resources.js';

export type MarkdownActivation =
  | { readonly kind: 'link'; readonly nodeId: number; readonly destination: string }
  | { readonly kind: 'footnote'; readonly nodeId: number; readonly definitionSpan: SourceSpan };

export interface MarkdownRenderSpan extends RenderSpan {
  readonly nodeId: number;
  readonly sourceSpan: SourceSpan;
  readonly sourceMapping: 'identity' | 'anchor';
  readonly activation?: MarkdownActivation;
  readonly media?: MarkdownRenderMedia;
}

export function inlinePlainText(nodes: readonly MarkdownInlineNode[]): string {
  let text = '';
  for (const node of nodes) {
    switch (node.kind) {
      case 'text':
      case 'escape':
      case 'characterReference':
      case 'codeSpan':
      case 'mathInline':
        text += node.value;
        break;
      case 'emphasis':
      case 'strong':
      case 'strikethrough':
      case 'link':
      case 'image':
        text += inlinePlainText(node.children);
        break;
      case 'softBreak':
      case 'hardBreak':
        text += '\n';
        break;
      case 'footnoteReference':
        text += node.label;
        break;
      case 'htmlInline':
        break;
    }
  }
  return text;
}

export function renderInline(
  nodes: readonly MarkdownInlineNode[],
  theme: MarkdownTheme,
  inheritedStyle: TerminalStyle = theme.body,
  inheritedLink?: TerminalLink,
  resources: MarkdownBlockResources = {}
): readonly MarkdownRenderSpan[] {
  const spans: MarkdownRenderSpan[] = [];
  const visit = (node: MarkdownInlineNode, style: TerminalStyle, link?: TerminalLink): void => {
    switch (node.kind) {
      case 'text':
        spans.push(valueSpan(node.value, node.id, node.span, style, link, true));
        break;
      case 'escape':
      case 'characterReference':
        spans.push(valueSpan(node.value, node.id, node.span, style, link, false));
        break;
      case 'strong':
        for (const child of node.children) visit(child, mergeTerminalStyles(style, theme.strong) ?? style, link);
        break;
      case 'emphasis':
        for (const child of node.children) visit(child, mergeTerminalStyles(style, theme.emphasis) ?? style, link);
        break;
      case 'strikethrough':
        for (const child of node.children) visit(child, mergeTerminalStyles(style, theme.deleted) ?? style, link);
        break;
      case 'codeSpan':
        spans.push(valueSpan(node.value, node.id, node.contentSpan, mergeTerminalStyles(style, theme.inlineCode), link, true));
        break;
      case 'mathInline': {
        const rendered = resources.mathText?.get(node.id);
        spans.push(valueSpan(
          rendered ?? node.value,
          node.id,
          node.contentSpan,
          mergeTerminalStyles(style, theme.math),
          link,
          rendered === undefined,
        ));
        break;
      }
      case 'link': {
        const terminalLink = node.destination.length === 0
          ? link
          : Object.freeze({ href: node.destination, id: `markdown-link-${String(node.id)}` });
        const start = spans.length;
        for (const child of node.children) visit(child, mergeTerminalStyles(style, theme.link) ?? style, terminalLink);
        for (let index = start; index < spans.length; index += 1) {
          const current = spans[index];
          if (current !== undefined) spans[index] = Object.freeze({
            ...current,
            activation: Object.freeze({
              kind: 'link',
              nodeId: node.id,
              destination: node.destination,
            })
          });
        }
        break;
      }
      case 'image':
        spans.push(imagePreviewSpan(node, inlinePlainText(node.children), theme, resources.images?.get(node.id)));
        break;
      case 'softBreak':
        spans.push(valueSpan(' ', node.id, node.span, style, link, false));
        break;
      case 'hardBreak':
        spans.push(valueSpan('\n', node.id, node.span, style, link, false));
        break;
      case 'htmlInline':
        spans.push(valueSpan('[HTML]', node.id, node.span, mergeTerminalStyles(style, theme.htmlPlaceholder), link, false));
        break;
      case 'footnoteReference':
        spans.push(footnoteReferenceSpan(node, theme));
        break;
    }
  };
  for (const node of nodes) visit(node, inheritedStyle, inheritedLink);
  return Object.freeze(spans);
}

function valueSpan(
  value: string,
  nodeId: number,
  sourceSpan: SourceSpan,
  style?: TerminalStyle,
  link?: TerminalLink,
  sourceDerived = false,
): MarkdownRenderSpan {
  const sanitized = sanitizeTerminalText(value).text;
  return Object.freeze({
    text: sanitized,
    ...(style === undefined ? {} : { style }),
    ...(link === undefined ? {} : { link }),
    nodeId,
    sourceSpan,
    sourceMapping: sourceDerived && sanitized.length === sourceSpan.end - sourceSpan.start
      ? 'identity'
      : 'anchor',
  });
}
