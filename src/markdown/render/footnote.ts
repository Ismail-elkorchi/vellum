import type { MarkdownFootnoteReferenceNode } from 'markspan';
import type { MarkdownTheme } from '../theme.js';
import type { MarkdownRenderSpan } from './inline.js';

export function footnoteReferenceSpan(
  node: MarkdownFootnoteReferenceNode,
  theme: MarkdownTheme
): MarkdownRenderSpan {
  return Object.freeze({
    text: `[^${node.label}]`,
    style: theme.link,
    nodeId: node.id,
    sourceSpan: node.span,
    sourceMapping: 'anchor',
    activation: Object.freeze({
      kind: 'footnote',
      nodeId: node.id,
      definitionSpan: node.definitionSpan,
    })
  });
}
