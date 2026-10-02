import type {
  MarkdownBlockNode,
  MarkdownDocumentNode,
  MarkdownInlineNode,
  MarkdownDiagnostic,
  MarkdownListItemNode,
  MarkdownTableCellNode,
  MarkdownTableRowNode,
  SourceSpan
} from 'markspan';
import { inlinePlainTextWork } from './inline.js';
import type { MarkdownRenderWork } from './work.js';
import { frontMatterPreviewRows } from './front-matter.js';

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
  readonly headingLevel?: number;
  readonly checked?: boolean;
}

function accessibleMarkdownNode(
  id: string,
  role: MarkdownAccessibleRole,
  label: string,
  sourceSpan: SourceSpan,
  children: readonly MarkdownAccessibleNode[] = [],
  state: Pick<MarkdownAccessibleNode, 'headingLevel' | 'checked'> = {},
): MarkdownAccessibleNode {
  return Object.freeze({ id, role, label, sourceSpan, children: Object.freeze(children), ...state });
}

export function* accessibleMarkdownDocument(
  tree: MarkdownDocumentNode,
  diagnostics: readonly MarkdownDiagnostic[] = []
): MarkdownRenderWork<MarkdownAccessibleNode> {
  return accessibleMarkdownNode(
    `markdown-${String(tree.id)}`,
    'document',
    'Markdown preview',
    tree.span,
    yield* accessibleBlocks(tree.children, diagnostics)
  );
}

function* accessibleBlocks(
  nodes: readonly MarkdownBlockNode[],
  diagnostics: readonly MarkdownDiagnostic[],
): MarkdownRenderWork<readonly MarkdownAccessibleNode[]> {
  const children: MarkdownAccessibleNode[] = [];
  for (const node of nodes) {
    yield;
    const accessible = yield* accessibleBlock(node, diagnostics);
    if (accessible !== undefined) children.push(accessible);
  }
  return Object.freeze(children);
}

function* accessibleBlock(
  node: MarkdownBlockNode,
  diagnostics: readonly MarkdownDiagnostic[] = [],
): MarkdownRenderWork<MarkdownAccessibleNode | undefined> {
  const id = `markdown-${String(node.id)}`;
  switch (node.kind) {
    case 'paragraph':
      return accessibleMarkdownNode(id, 'paragraph', yield* inlinePlainTextWork(node.children), node.span, yield* accessibleInline(node.children));
    case 'heading':
      return accessibleMarkdownNode(
        id,
        'heading',
        yield* inlinePlainTextWork(node.children),
        node.span,
        yield* accessibleInline(node.children),
        { headingLevel: node.depth },
      );
    case 'blockQuote':
      return accessibleMarkdownNode(id, 'blockquote', 'Blockquote', node.span, yield* accessibleBlocks(node.children, diagnostics));
    case 'callout':
      return accessibleMarkdownNode(id, 'note', `${calloutLabel(node.calloutKind)} callout`, node.span, yield* accessibleBlocks(node.children, diagnostics));
    case 'frontMatter': {
      const children: MarkdownAccessibleNode[] = [];
      let diagnosticIndex = 0;
      for (const diagnostic of diagnostics) {
        yield;
        if (diagnostic.span.start > node.span.end || diagnostic.span.end < node.span.start) continue;
        children.push(accessibleMarkdownNode(
          `${id}-diagnostic-${String(diagnosticIndex++)}`, 'diagnostic',
          `${diagnostic.severity}: ${diagnostic.message}`, diagnostic.span,
        ));
      }
      let entryIndex = 0;
      for (const entry of yield* frontMatterPreviewRows(node.value)) {
        yield;
        children.push(accessibleMarkdownNode(`${id}-entry-${String(entryIndex++)}`, 'cell', entry.text, entry.sourceSpan));
      }
      return accessibleMarkdownNode(id, 'frontMatter', 'Front matter', node.span, children);
    }
    case 'list': {
      const children: MarkdownAccessibleNode[] = [];
      for (const item of node.items) {
        yield;
        children.push(yield* accessibleListItem(item, diagnostics));
      }
      return accessibleMarkdownNode(id, 'list', node.ordered ? 'Ordered list' : 'Unordered list', node.span, children);
    }
    case 'codeBlock':
      return accessibleMarkdownNode(
        id,
        node.language?.trim().toLowerCase() === 'mermaid' ? 'diagram' : 'code',
        node.language === null ? 'Code block' : `${node.language} code block`,
        node.span
      );
    case 'mathBlock':
      return accessibleMarkdownNode(id, 'math', `Math: ${node.value}`, node.span);
    case 'thematicBreak':
      return accessibleMarkdownNode(id, 'separator', 'Thematic break', node.span);
    case 'htmlBlock':
      return accessibleMarkdownNode(id, 'code', 'HTML source', node.span);
    case 'linkDefinition':
      return undefined;
    case 'footnoteDefinition':
      return accessibleMarkdownNode(id, 'footnote', `Footnote ${node.label}`, node.span, yield* accessibleBlocks(node.children, diagnostics));
    case 'table': {
      const children: MarkdownAccessibleNode[] = [yield* accessibleTableRow(node.header)];
      for (const row of node.rows) {
        yield;
        children.push(yield* accessibleTableRow(row));
      }
      return accessibleMarkdownNode(id, 'table', 'Table', node.span, children);
    }
  }
}

function* accessibleListItem(node: MarkdownListItemNode, diagnostics: readonly MarkdownDiagnostic[]): MarkdownRenderWork<MarkdownAccessibleNode> {
  const task = node.task === null ? [] : [accessibleMarkdownNode(
    `markdown-${String(node.id)}-task`,
    'checkbox',
    node.task.checked ? 'Checked task' : 'Unchecked task',
    node.task.span,
    [],
    { checked: node.task.checked },
  )];
  return accessibleMarkdownNode(
    `markdown-${String(node.id)}`,
    'listItem',
    'List item',
    node.span,
    [...task, ...(yield* accessibleBlocks(node.children, diagnostics))]
  );
}

function* accessibleTableRow(node: MarkdownTableRowNode): MarkdownRenderWork<MarkdownAccessibleNode> {
  const children: MarkdownAccessibleNode[] = [];
  for (const cell of node.cells) {
    yield;
    children.push(yield* accessibleTableCell(cell));
  }
  return accessibleMarkdownNode(
    `markdown-${String(node.id)}`,
    'row',
    'Table row',
    node.span,
    children
  );
}

function* accessibleTableCell(node: MarkdownTableCellNode): MarkdownRenderWork<MarkdownAccessibleNode> {
  return accessibleMarkdownNode(
    `markdown-${String(node.id)}`,
    'cell',
    yield* inlinePlainTextWork(node.children),
    node.span,
    yield* accessibleInline(node.children)
  );
}

function* accessibleInline(nodes: readonly MarkdownInlineNode[]): MarkdownRenderWork<readonly MarkdownAccessibleNode[]> {
  const children: MarkdownAccessibleNode[] = [];
  for (const node of nodes) {
    yield;
    for (const child of yield* accessibleInlineNode(node)) {
      children.push(child);
      yield;
    }
  }
  return Object.freeze(children);
}

function* accessibleInlineNode(node: MarkdownInlineNode): MarkdownRenderWork<readonly MarkdownAccessibleNode[]> {
  const id = `markdown-${String(node.id)}`;
  switch (node.kind) {
    case 'link':
      return [accessibleMarkdownNode(id, 'link', `${yield* inlinePlainTextWork(node.children)}: ${node.destination}`, node.span, yield* accessibleInline(node.children))];
    case 'image':
      return [accessibleMarkdownNode(id, 'image', `${yield* inlinePlainTextWork(node.children)}${node.title === null ? '' : `: ${node.title}`}`, node.span)];
    case 'mathInline':
      return [accessibleMarkdownNode(id, 'math', `Math: ${node.value}`, node.span)];
    case 'footnoteReference':
      return [accessibleMarkdownNode(id, 'footnote', `Footnote reference ${node.label}`, node.span)];
    case 'emphasis':
    case 'strong':
    case 'strikethrough':
      return yield* accessibleInline(node.children);
    case 'text':
    case 'escape':
    case 'characterReference':
    case 'codeSpan':
    case 'softBreak':
    case 'hardBreak':
    case 'htmlInline':
      return [];
  }
}

function calloutLabel(kind: 'note' | 'tip' | 'important' | 'warning' | 'caution'): string {
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}
