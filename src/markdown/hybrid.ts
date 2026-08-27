import {
  createTextAreaDecorations,
  type TextAreaDecoration,
  type TextAreaDecorations,
} from '@ismail-elkorchi/terminal-ui/components';
import { collectMarkdownSyntaxTokens, markdownPathAt, walkMarkdown, type MarkdownNode } from 'markspan';
import type { BufferState } from '../app/types.js';
import type { MarkdownTheme } from './theme.js';

const concealedTokenKinds = new Set([
  'headingMarker',
  'emphasisMarker',
  'strongMarker',
  'strikethroughMarker',
  'codeSpanMarker',
  'mathMarker',
  'linkDestination',
  'imageDestination'
]);
export function createHybridTextDecorations(
  buffer: BufferState,
  theme: MarkdownTheme
): TextAreaDecorations {
  const decorations = buffer.preview.kind === 'ready'
    ? hybridDecorationEntries(buffer, theme)
    : Object.freeze([]);
  return createTextAreaDecorations({ document: buffer.editor.document, decorations });
}

function hybridDecorationEntries(
  buffer: BufferState,
  theme: MarkdownTheme,
): readonly TextAreaDecoration[] {
  if (buffer.preview.kind !== 'ready') return Object.freeze([]);
  const tree = buffer.preview.snapshot.document.tree;
  const caret = buffer.editor.caret.position.offset;
  const selectionStart = buffer.editor.selection === undefined
    ? caret
    : Math.min(buffer.editor.selection.anchor.offset, buffer.editor.selection.focus.offset);
  const selectionEnd = buffer.editor.selection === undefined
    ? caret
    : Math.max(buffer.editor.selection.anchor.offset, buffer.editor.selection.focus.offset);
  const activeIds = new Set<number>();
  for (const offset of new Set([selectionStart, selectionEnd, caret])) {
    for (const node of markdownPathAt(tree, offset, { includeEnd: true })) activeIds.add(node.id);
  }
  const decorations: TextAreaDecoration[] = [];
  for (const token of collectMarkdownSyntaxTokens(tree)) {
    const style = styleForToken(token.kind, theme);
    if (style !== undefined) {
      addStyle(
        decorations,
        token.span.start,
        token.span.end,
        `syntax.${token.kind}`,
        style,
      );
    }
    if (concealedTokenKinds.has(token.kind) && !activeIds.has(token.nodeId)) {
      decorations.push(Object.freeze({
        kind: 'conceal',
        startOffset: token.span.start,
        endOffsetExclusive: token.span.end,
        label: `concealed.${token.kind}`
      }));
    }
  }
  for (const { node } of walkMarkdown(tree)) addNodeDecoration(node, activeIds, decorations, theme);
  return Object.freeze(decorations.sort((left, right) => (
    left.startOffset - right.startOffset || left.endOffsetExclusive - right.endOffsetExclusive
  )));
}

function addNodeDecoration(
  node: MarkdownNode,
  activeIds: ReadonlySet<number>,
  decorations: TextAreaDecoration[],
  theme: MarkdownTheme
): void {
  if (node.kind === 'heading') {
    addStyle(decorations,
      node.contentSpan.start,
      node.contentSpan.end,
      `heading.${String(node.depth)}`,
      theme.headings[node.depth - 1] ?? theme.body
    );
  } else if (node.kind === 'strong') {
    addStyle(decorations, node.openingMarkerSpan.end, node.closingMarkerSpan.start, 'strong', theme.strong);
  } else if (node.kind === 'emphasis') {
    addStyle(decorations, node.openingMarkerSpan.end, node.closingMarkerSpan.start, 'emphasis', theme.emphasis);
  } else if (node.kind === 'codeSpan') {
    addStyle(decorations, node.contentSpan.start, node.contentSpan.end, 'inlineCode', theme.inlineCode);
  } else if (node.kind === 'link') {
    if (node.labelSpan !== null) {
      addStyle(decorations, node.labelSpan.start, node.labelSpan.end, 'link', theme.link);
    }
    if (!activeIds.has(node.id) && node.labelSpan !== null) {
      concealOutsideLabel(node.span.start, node.span.end, node.labelSpan.start, node.labelSpan.end, node.id, decorations);
    }
  } else if (node.kind === 'image') {
    if (!activeIds.has(node.id) && node.labelSpan !== null) {
      concealOutsideLabel(node.span.start, node.span.end, node.labelSpan.start, node.labelSpan.end, node.id, decorations);
    }
  } else if (node.kind === 'listItem' && node.task !== null && !activeIds.has(node.id)) {
    decorations.push(Object.freeze({
      kind: 'replace',
      startOffset: node.task.span.start,
      endOffsetExclusive: node.task.span.end,
      label: 'taskMarker',
      replacementText: node.task.checked ? '☑' : '☐',
      accessibilityText: node.task.checked ? 'checked task' : 'unchecked task',
      style: node.task.checked ? theme.checkedTask : theme.uncheckedTask
    }));
  }
}

function concealOutsideLabel(
  start: number,
  end: number,
  labelStart: number,
  labelEnd: number,
  nodeId: number,
  decorations: TextAreaDecoration[]
): void {
  if (labelStart > start) decorations.push(conceal(start, labelStart, nodeId));
  if (end > labelEnd) decorations.push(conceal(labelEnd, end, nodeId));
}

function conceal(startOffset: number, endOffsetExclusive: number, nodeId: number): TextAreaDecoration {
  return Object.freeze({
    kind: 'conceal',
    startOffset,
    endOffsetExclusive,
    label: `concealed.node.${String(nodeId)}`
  });
}

function addStyle(
  decorations: TextAreaDecoration[],
  startOffset: number,
  endOffsetExclusive: number,
  label: string,
  terminalStyle: NonNullable<TextAreaDecoration['style']>
): void {
  if (startOffset === endOffsetExclusive) return;
  decorations.push(Object.freeze({
    kind: 'style',
    startOffset,
    endOffsetExclusive,
    label,
    style: terminalStyle,
  }));
}

function styleForToken(
  kind: ReturnType<typeof collectMarkdownSyntaxTokens>[number]['kind'],
  theme: MarkdownTheme
): TextAreaDecoration['style'] {
  if (kind === 'headingMarker' || kind === 'listMarker') return theme.listMarker;
  if (kind === 'linkDestination' || kind === 'linkLabel' || kind === 'definitionDestination') return theme.link;
  if (kind === 'codeContent' || kind === 'codeSpanContent') return theme.codeBlock;
  if (kind === 'mathContent') return theme.math;
  if (kind === 'html') return theme.htmlPlaceholder;
  if (kind.startsWith('frontMatter')) return theme.frontMatter;
  return undefined;
}
