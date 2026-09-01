import {
  createTextAreaDecorations,
  type TextAreaDecoration,
  type TextAreaDecorations,
} from '@ismail-elkorchi/terminal-ui/components';
import { defaultTextWidthProfile, measureTextCells, textDocumentText, type TextWidthProfile } from '@ismail-elkorchi/terminal-ui/text';
import { collectMarkdownSyntaxTokens, extractMarkdownText, markdownPathAt, walkMarkdown, type MarkdownNode } from 'markspan';
import type { BufferState } from '../app/types.js';
import type { MarkdownTheme } from './theme.js';
import type { MarkdownBlockResources } from './render/resources.js';

const concealedTokenKinds = new Set([
  'headingMarker',
  'emphasisMarker',
  'strongMarker',
  'strikethroughMarker',
  'codeSpanMarker',
  'mathMarker',
  'linkDestination'
]);
export function createHybridTextDecorations(
  buffer: BufferState,
  theme: MarkdownTheme,
  focusMode = false,
  resources: MarkdownBlockResources = {},
  widthProfile: TextWidthProfile = defaultTextWidthProfile
): TextAreaDecorations {
  const decorations = buffer.preview.kind === 'ready'
    ? hybridDecorationEntries(buffer, theme, focusMode, resources, widthProfile)
    : Object.freeze([]);
  return createTextAreaDecorations({ document: buffer.editor.document, decorations });
}

function hybridDecorationEntries(
  buffer: BufferState,
  theme: MarkdownTheme,
  focusMode: boolean,
  resources: MarkdownBlockResources,
  widthProfile: TextWidthProfile,
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
  if (buffer.editor.selection !== undefined && selectionStart !== selectionEnd) {
    for (const { node } of walkMarkdown(tree)) {
      if (node.span.start < selectionEnd && node.span.end > selectionStart) activeIds.add(node.id);
    }
  }
  const decorations: TextAreaDecoration[] = [];
  const source = textDocumentText(buffer.editor.document);
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
  for (const { node } of walkMarkdown(tree)) addNodeDecoration(node, activeIds, decorations, theme, source, resources, tree, widthProfile);
  if (focusMode) {
    for (const block of tree.children) {
      if (!activeIds.has(block.id)) addStyle(decorations, block.span.start, block.span.end, 'focus.dimmed', { dim: true });
    }
  }
  return Object.freeze(composeHybridDecorations(decorations).sort((left, right) => (
    left.startOffset - right.startOffset || left.endOffsetExclusive - right.endOffsetExclusive
  )));
}

function addNodeDecoration(
  node: MarkdownNode,
  activeIds: ReadonlySet<number>,
  decorations: TextAreaDecoration[],
  theme: MarkdownTheme,
  source: string,
  resources: MarkdownBlockResources,
  tree: MarkdownNode,
  widthProfile: TextWidthProfile
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
    const loaded = resources.images?.get(node.id);
    if (!activeIds.has(node.id) && loaded?.kind === 'ready' && standaloneNode(source, node.span.start, node.span.end)) {
      const label = (node.labelSpan === null ? node.label : source.slice(node.labelSpan.start, node.labelSpan.end))?.trim() || 'Image';
      const dimensions = `${String(loaded.image.width)}×${String(loaded.image.height)}`;
      const caption = ` ${label} · ${dimensions} `;
      const captionWidth = measureTextCells(caption, { widthProfile }).cells;
      decorations.push(Object.freeze({
        kind: 'replace',
        startOffset: node.span.start,
        endOffsetExclusive: node.span.end,
        label: `image.block.${String(node.id)}`,
        replacementText: `┌${'─'.repeat(captionWidth)}┐\n│${caption}│\n└${'─'.repeat(captionWidth)}┘`,
        accessibilityText: `${label}, image, ${dimensions}`,
        style: theme.body
      }));
    } else if (!activeIds.has(node.id) && node.labelSpan !== null) {
      decorations.push(Object.freeze({
        kind: 'replace',
        startOffset: node.span.start,
        endOffsetExclusive: node.labelSpan.start,
        label: `image.prefix.${String(node.id)}`,
        replacementText: '🖼 ',
        accessibilityText: 'image'
      }));
      if (node.span.end > node.labelSpan.end) decorations.push(conceal(node.labelSpan.end, node.span.end, node.id));
      addStyle(decorations, node.labelSpan.start, node.labelSpan.end, `image.label.${String(node.id)}`, theme.link);
    }
  } else if ((node.kind === 'mathInline' || node.kind === 'mathBlock') && !activeIds.has(node.id)) {
    const rendered = resources.mathText?.get(node.id);
    if (rendered !== undefined) {
      decorations.push(Object.freeze({
        kind: 'replace',
        startOffset: node.contentSpan.start,
        endOffsetExclusive: node.contentSpan.end,
        label: `math.rendered.${String(node.id)}`,
        replacementText: rendered,
        accessibilityText: `Math: ${node.value}`,
        style: theme.math
      }));
    }
  } else if (node.kind === 'codeBlock' && node.language?.trim().toLowerCase() === 'mermaid' && !activeIds.has(node.id)) {
    const rendered = resources.diagramText?.get(node.id) ?? 'Mermaid diagram';
    decorations.push(Object.freeze({
      kind: 'replace',
      startOffset: node.span.start,
      endOffsetExclusive: node.span.end,
      label: `diagram.rendered.${String(node.id)}`,
      replacementText: rendered === 'Mermaid diagram' ? '◇ Mermaid diagram' : rendered,
      accessibilityText: rendered,
      style: rendered === 'Mermaid diagram' ? theme.body : theme.diagramFailure
    }));
  } else if (node.kind === 'callout' && !activeIds.has(node.id)) {
    for (const marker of node.markerSpans) decorations.push(conceal(marker.start, marker.end, node.id));
    decorations.push(Object.freeze({
      kind: 'replace',
      startOffset: node.labelSpan.start,
      endOffsetExclusive: node.labelSpan.end,
      label: `callout.label.${String(node.id)}`,
      replacementText: `${calloutIcon(node.calloutKind)} ${node.calloutKind.toUpperCase()}`,
      accessibilityText: `${node.calloutKind} callout`,
      style: theme.callouts[node.calloutKind]
    }));
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
  } else if (node.kind === 'table') {
    const rows = [node.header, ...node.rows];
    const activeCell = rows.flatMap((row) => row.cells).find((cell) => activeIds.has(cell.id));
    for (const row of rows) {
      for (const cell of row.cells) {
        if (cell.id === activeCell?.id) continue;
        const value = cell.children.map((child) => extractMarkdownText(child)).join('').trim();
        decorations.push(Object.freeze({
          kind: 'replace',
          startOffset: cell.span.start,
          endOffsetExclusive: cell.span.end,
          label: `table.cell.${String(cell.id)}`,
          replacementText: ` ${value} `,
          accessibilityText: value.length === 0 ? 'empty table cell' : value,
          style: row.id === node.header.id ? theme.strong : theme.body
        }));
      }
      const finalCell = row.cells.at(-1);
      if (finalCell !== undefined && row.span.end > finalCell.span.end && activeCell?.id !== finalCell.id) {
        decorations.push(conceal(finalCell.span.end, row.span.end, row.id));
      }
    }
    if (activeCell === undefined) {
      decorations.push(Object.freeze({
        kind: 'replace',
        startOffset: node.delimiterSpan.start,
        endOffsetExclusive: node.delimiterSpan.end,
        label: `table.alignment.${String(node.id)}`,
        replacementText: node.align.map((alignment) => alignment === 'center' ? ' ↔ ' : alignment === 'right' ? ' → ' : ' ← ').join(''),
        accessibilityText: 'table column alignment'
      }));
    }
  } else if (node.kind === 'frontMatter' && !activeIds.has(node.id)) {
    decorations.push(conceal(node.openingMarkerSpan.start, node.openingMarkerSpan.end, node.id));
    if (node.closingMarkerSpan !== null) {
      decorations.push(conceal(node.closingMarkerSpan.start, node.closingMarkerSpan.end, node.id));
    }
    if (node.value?.kind === 'mapping') {
      for (const entry of node.value.entries) {
        addStyle(decorations, entry.keySpan.start, entry.keySpan.end, `property.key.${entry.key}`, theme.strong);
        const replacement = frontMatterPropertyText(entry.value);
        if (replacement === undefined) continue;
        decorations.push(Object.freeze({
          kind: 'replace',
          startOffset: entry.valueSpan.start,
          endOffsetExclusive: entry.valueSpan.end,
          label: `property.value.${entry.key}`,
          replacementText: replacement.text,
          accessibilityText: `${entry.key}: ${replacement.accessible}`,
          style: replacement.checked === undefined
            ? theme.frontMatter
            : replacement.checked ? theme.checkedTask : theme.uncheckedTask
        }));
      }
    }
  } else if (node.kind === 'paragraph' && !activeIds.has(node.id)
    && /^\s*\[(?:toc|_toc_)\]\s*$/iu.test(source.slice(node.span.start, node.span.end))) {
    const headings = [...walkMarkdown(tree)].flatMap(({ node: candidate }) => candidate.kind === 'heading'
      ? [`${'  '.repeat(candidate.depth - 1)}• ${source.slice(candidate.contentSpan.start, candidate.contentSpan.end).trim()}`]
      : []);
    decorations.push(Object.freeze({
      kind: 'replace',
      startOffset: node.span.start,
      endOffsetExclusive: node.span.end,
      label: `toc.${String(node.id)}`,
      replacementText: headings.join('\n') || 'Table of contents is empty.',
      accessibilityText: 'Table of contents',
      style: theme.body
    }));
  }
}

function composeHybridDecorations(entries: readonly TextAreaDecoration[]): TextAreaDecoration[] {
  const replacements = entries
    .filter((entry): entry is Extract<TextAreaDecoration, { readonly kind: 'replace' }> => entry.kind === 'replace')
    .toSorted((left, right) => (
      left.startOffset - right.startOffset || right.endOffsetExclusive - left.endOffsetExclusive
    ));
  const owners: typeof replacements[number][] = [];
  for (const replacement of replacements) {
    const previous = owners.at(-1);
    if (previous === undefined || replacement.startOffset >= previous.endOffsetExclusive) {
      owners.push(replacement);
      continue;
    }
    if (replacement.endOffsetExclusive <= previous.endOffsetExclusive) continue;
    throw new RangeError(
      `Hybrid replacement decorations partially overlap: ${previous.label ?? 'replacement'} and ${replacement.label ?? 'replacement'}.`
    );
  }
  const owned = new Set<TextAreaDecoration>(owners);
  const result: TextAreaDecoration[] = [];
  for (const entry of entries) {
    if (entry.kind === 'replace') {
      if (owned.has(entry)) result.push(entry);
      continue;
    }
    if (entry.kind === 'conceal') {
      result.push(...concealmentOutsideReplacements(entry, owners));
      continue;
    }
    const startOwner = replacementContainingInteriorOffset(owners, entry.startOffset);
    const endOwner = replacementContainingInteriorOffset(owners, entry.endOffsetExclusive);
    const startOffset = startOwner?.endOffsetExclusive ?? entry.startOffset;
    const endOffsetExclusive = endOwner?.startOffset ?? entry.endOffsetExclusive;
    if (startOffset < endOffsetExclusive) {
      result.push(startOffset === entry.startOffset && endOffsetExclusive === entry.endOffsetExclusive
        ? entry
        : Object.freeze({ ...entry, startOffset, endOffsetExclusive }));
    }
  }
  return result;
}

function concealmentOutsideReplacements(
  concealment: Extract<TextAreaDecoration, { readonly kind: 'conceal' }>,
  replacements: readonly Extract<TextAreaDecoration, { readonly kind: 'replace' }>[]
): readonly TextAreaDecoration[] {
  const fragments: TextAreaDecoration[] = [];
  let cursor = concealment.startOffset;
  let fragment = 0;
  const firstReplacement = firstReplacementEndingAfter(replacements, cursor);
  if ((replacements[firstReplacement]?.startOffset ?? Number.POSITIVE_INFINITY) >= concealment.endOffsetExclusive) {
    return Object.freeze([concealment]);
  }
  for (let index = firstReplacement; index < replacements.length; index += 1) {
    const replacement = replacements[index];
    if (replacement === undefined || replacement.startOffset >= concealment.endOffsetExclusive) break;
    if (cursor < replacement.startOffset) {
      fragments.push(Object.freeze({
        ...concealment,
        startOffset: cursor,
        endOffsetExclusive: Math.min(replacement.startOffset, concealment.endOffsetExclusive),
        label: `${concealment.label ?? 'concealed'}.${String(fragment)}`
      }));
      fragment += 1;
    }
    cursor = Math.max(cursor, replacement.endOffsetExclusive);
    if (cursor >= concealment.endOffsetExclusive) break;
  }
  if (cursor < concealment.endOffsetExclusive) {
    fragments.push(Object.freeze({
      ...concealment,
      startOffset: cursor,
      label: `${concealment.label ?? 'concealed'}.${String(fragment)}`
    }));
  }
  return Object.freeze(fragments);
}

function firstReplacementEndingAfter(
  replacements: readonly Extract<TextAreaDecoration, { readonly kind: 'replace' }>[],
  offset: number
): number {
  let low = 0;
  let high = replacements.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((replacements[middle]?.endOffsetExclusive ?? Number.POSITIVE_INFINITY) <= offset) low = middle + 1;
    else high = middle;
  }
  return low;
}

function replacementContainingInteriorOffset(
  replacements: readonly Extract<TextAreaDecoration, { readonly kind: 'replace' }>[],
  offset: number
): Extract<TextAreaDecoration, { readonly kind: 'replace' }> | undefined {
  let low = 0;
  let high = replacements.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((replacements[middle]?.startOffset ?? Number.POSITIVE_INFINITY) < offset) low = middle + 1;
    else high = middle;
  }
  const candidate = replacements[low - 1];
  return candidate !== undefined && candidate.startOffset < offset && offset < candidate.endOffsetExclusive
    ? candidate
    : undefined;
}

function frontMatterPropertyText(
  value: import('markspan').MarkdownFrontMatterValue
): { readonly text: string; readonly accessible: string; readonly checked?: boolean } | undefined {
  if (value.kind === 'scalar') {
    if (typeof value.value === 'boolean') {
      return Object.freeze({ text: value.value ? '☑' : '☐', accessible: String(value.value), checked: value.value });
    }
    if (value.value === null) return Object.freeze({ text: '—', accessible: 'empty' });
    const text = String(value.value);
    if (typeof value.value === 'number') return Object.freeze({ text: `# ${text}`, accessible: text });
    if (/^\d{4}-\d{2}-\d{2}(?:[T ]|$)/u.test(text)) return Object.freeze({ text: `◷ ${text}`, accessible: text });
    if (/^(?:\.\.?\/|\/|[A-Za-z]:[\\/]|\[\[).*(?:\.md|\]\])$/iu.test(text)) {
      return Object.freeze({ text: `↗ ${text}`, accessible: text });
    }
    return Object.freeze({ text, accessible: text });
  }
  if (value.kind === 'sequence') {
    const items = value.items.flatMap((item) => item.kind === 'scalar' && item.value !== null ? [String(item.value)] : []);
    return items.length === value.items.length
      ? Object.freeze({ text: items.map((item) => `• ${item}`).join(', '), accessible: items.join(', ') })
      : Object.freeze({ text: '…', accessible: 'nested values' });
  }
  return Object.freeze({ text: '{…}', accessible: 'nested properties' });
}

function standaloneNode(source: string, start: number, end: number): boolean {
  const lineStart = source.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
  const lineEnd = source.indexOf('\n', end);
  return source.slice(lineStart, lineEnd < 0 ? source.length : lineEnd).trim() === source.slice(start, end).trim();
}

function calloutIcon(kind: 'note' | 'tip' | 'important' | 'warning' | 'caution'): string {
  if (kind === 'tip') return '◆';
  if (kind === 'important') return '●';
  if (kind === 'warning') return '▲';
  if (kind === 'caution') return '■';
  return 'ℹ';
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
