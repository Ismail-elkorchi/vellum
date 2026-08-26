import type {
  MarkdownBlockNode,
  MarkdownDocumentNode,
  MarkdownInlineNode,
  MarkdownListItemNode,
  MarkdownTableCellNode,
  MarkdownTableRowNode,
  SourceSpan
} from 'markspan';
import { inlinePlainText } from './inline.js';

export type MarkdownAccessibleRole =
  | 'document'
  | 'heading'
  | 'paragraph'
  | 'blockquote'
  | 'link'
  | 'image'
  | 'list'
  | 'listItem'
  | 'checkbox'
  | 'table'
  | 'row'
  | 'cell'
  | 'note'
  | 'code'
  | 'math'
  | 'diagram'
  | 'frontMatter'
  | 'footnote'
  | 'separator'
  | 'diagnostic';

export interface MarkdownAccessibleNode {
  readonly id: string;
  readonly role: MarkdownAccessibleRole;
  readonly label: string;
  readonly sourceSpan: SourceSpan;
  readonly children: readonly MarkdownAccessibleNode[];
}

function accessibleMarkdownNode(
  id: string,
  role: MarkdownAccessibleRole,
  label: string,
  sourceSpan: SourceSpan,
  children: readonly MarkdownAccessibleNode[] = []
): MarkdownAccessibleNode {
  return Object.freeze({ id, role, label, sourceSpan, children: Object.freeze(children) });
}

export function accessibleMarkdownDocument(tree: MarkdownDocumentNode): MarkdownAccessibleNode {
  return accessibleMarkdownNode(
    `markdown-${String(tree.id)}`,
    'document',
    'Markdown preview',
    tree.span,
    tree.children.map(accessibleBlock)
  );
}

function accessibleBlock(node: MarkdownBlockNode): MarkdownAccessibleNode {
  const id = `markdown-${String(node.id)}`;
  switch (node.kind) {
    case 'paragraph':
      return accessibleMarkdownNode(id, 'paragraph', inlinePlainText(node.children), node.span, accessibleInline(node.children));
    case 'heading':
      return accessibleMarkdownNode(id, 'heading', `Heading level ${String(node.depth)}: ${inlinePlainText(node.children)}`, node.span, accessibleInline(node.children));
    case 'blockQuote':
      return accessibleMarkdownNode(id, 'blockquote', 'Blockquote', node.span, node.children.map(accessibleBlock));
    case 'callout':
      return accessibleMarkdownNode(id, 'note', `${calloutLabel(node.calloutKind)} callout`, node.span, node.children.map(accessibleBlock));
    case 'frontMatter':
      return accessibleMarkdownNode(id, 'frontMatter', 'Front matter', node.span, node.entries.map((entry, index) => (
        accessibleMarkdownNode(`${id}-entry-${String(index)}`, 'cell', `${entry.key}: ${entry.value}`, {
          start: entry.keySpan.start,
          end: entry.valueSpan.end
        })
      )));
    case 'list':
      return accessibleMarkdownNode(id, 'list', node.ordered ? 'Ordered list' : 'Unordered list', node.span, node.items.map(accessibleListItem));
    case 'codeBlock':
      return accessibleMarkdownNode(id, node.language === 'mermaid' ? 'diagram' : 'code', node.language === null ? 'Code block' : `${node.language} code block`, node.span);
    case 'mathBlock':
      return accessibleMarkdownNode(id, 'math', `Math: ${node.value}`, node.span);
    case 'thematicBreak':
      return accessibleMarkdownNode(id, 'separator', 'Thematic break', node.span);
    case 'htmlBlock':
      return accessibleMarkdownNode(id, 'code', 'HTML source', node.span);
    case 'linkDefinition':
      return accessibleMarkdownNode(id, 'link', `Link definition ${node.label}: ${node.destination}`, node.span);
    case 'footnoteDefinition':
      return accessibleMarkdownNode(id, 'footnote', `Footnote ${node.label}`, node.span, node.children.map(accessibleBlock));
    case 'table':
      return accessibleMarkdownNode(id, 'table', 'Table', node.span, [node.header, ...node.rows].map(accessibleTableRow));
  }
}

function accessibleListItem(node: MarkdownListItemNode): MarkdownAccessibleNode {
  const task = node.task === null ? [] : [accessibleMarkdownNode(
    `markdown-${String(node.id)}-task`,
    'checkbox',
    node.task.checked ? 'Checked task' : 'Unchecked task',
    node.task.span
  )];
  return accessibleMarkdownNode(
    `markdown-${String(node.id)}`,
    'listItem',
    'List item',
    node.span,
    [...task, ...node.children.map(accessibleBlock)]
  );
}

function accessibleTableRow(node: MarkdownTableRowNode): MarkdownAccessibleNode {
  return accessibleMarkdownNode(
    `markdown-${String(node.id)}`,
    'row',
    'Table row',
    node.span,
    node.cells.map(accessibleTableCell)
  );
}

function accessibleTableCell(node: MarkdownTableCellNode): MarkdownAccessibleNode {
  return accessibleMarkdownNode(
    `markdown-${String(node.id)}`,
    'cell',
    inlinePlainText(node.children),
    node.span,
    accessibleInline(node.children)
  );
}

function accessibleInline(nodes: readonly MarkdownInlineNode[]): readonly MarkdownAccessibleNode[] {
  return Object.freeze(nodes.flatMap((node): readonly MarkdownAccessibleNode[] => {
    const id = `markdown-${String(node.id)}`;
    switch (node.kind) {
      case 'link':
        return [accessibleMarkdownNode(id, 'link', `${inlinePlainText(node.children)}: ${node.destination}`, node.span, accessibleInline(node.children))];
      case 'image':
        return [accessibleMarkdownNode(id, 'image', `${inlinePlainText(node.children)}${node.title === null ? '' : `: ${node.title}`}`, node.span)];
      case 'mathInline':
        return [accessibleMarkdownNode(id, 'math', `Math: ${node.value}`, node.span)];
      case 'footnoteReference':
        return [accessibleMarkdownNode(id, 'footnote', `Footnote reference ${node.label}`, node.span)];
      case 'emphasis':
      case 'strong':
      case 'strikethrough':
        return accessibleInline(node.children);
      case 'text':
      case 'escape':
      case 'characterReference':
      case 'codeSpan':
      case 'softBreak':
      case 'hardBreak':
      case 'htmlInline':
        return [];
    }
  }));
}

function calloutLabel(kind: 'note' | 'tip' | 'important' | 'warning' | 'caution'): string {
  return kind.charAt(0).toLocaleUpperCase() + kind.slice(1);
}
