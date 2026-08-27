import type { TextAreaTransition } from '@ismail-elkorchi/terminal-ui/behavior';
import {
  measureTextCells,
  textDocumentSelectionRange,
  type TextEditOperation
} from '@ismail-elkorchi/terminal-ui/text';
import {
  markdownPathAt,
  type MarkdownBlockNode,
  type MarkdownListItemNode,
  type MarkdownNode,
  type MarkdownTableNode,
  type SourceSpan
} from 'markspan';
import type { BufferState, CommandId } from '../app/types.js';

export interface MarkdownEditorTransition {
  readonly action?: TextAreaTransition;
  readonly caretOffset?: number;
}

export interface MarkdownCommandOptions {
  readonly linkDestination?: string;
  readonly codeLanguage?: string;
}

export function markdownCommandTransition(
  buffer: BufferState,
  commandId: CommandId,
  options: MarkdownCommandOptions = {},
  source: string = buffer.preview.kind === 'ready' ? buffer.preview.snapshot.source : ''
): MarkdownEditorTransition {
  if (commandId === 'edit.undo') return Object.freeze({ action: Object.freeze({ kind: 'undo' }) });
  if (commandId === 'edit.redo') return Object.freeze({ action: Object.freeze({ kind: 'redo' }) });
  const selection = textDocumentSelectionRange(
    buffer.editor.document,
    buffer.editor.selection,
    buffer.editor.caret
  );
  const selectionSpan: SourceSpan = Object.freeze({
    start: selection.startOffset,
    end: selection.endOffsetExclusive
  });
  const tree = buffer.preview.kind === 'ready' ? buffer.preview.snapshot.document.tree : undefined;
  const path = tree === undefined ? [] : markdownPathAt(tree, buffer.editor.caret.position.offset, { includeEnd: true });
  switch (commandId) {
    case 'markdown.toggleStrong':
      return toggleInline(source, selectionSpan, path, 'strong', '**');
    case 'markdown.toggleEmphasis':
      return toggleInline(source, selectionSpan, path, 'emphasis', '*');
    case 'markdown.toggleInlineCode':
      return toggleInline(source, selectionSpan, path, 'codeSpan', '`');
    case 'markdown.insertLink':
      return insertLink(source, selectionSpan, path, options.linkDestination ?? 'https://');
    case 'markdown.toggleTask':
      return toggleTask(source, path);
    case 'markdown.promoteHeading':
      return changeHeading(source, path, -1);
    case 'markdown.demoteHeading':
      return changeHeading(source, path, 1);
    case 'markdown.insertCodeFence':
      return insertCodeFence(source, selectionSpan, options.codeLanguage ?? '');
    case 'markdown.moveBlockUp':
      return moveBlock(source, tree?.children ?? [], buffer.editor.caret.position.offset, -1);
    case 'markdown.moveBlockDown':
      return moveBlock(source, tree?.children ?? [], buffer.editor.caret.position.offset, 1);
    case 'markdown.duplicateBlock':
      return duplicateBlock(source, tree?.children ?? [], buffer.editor.caret.position.offset);
    case 'markdown.formatTable':
    case 'markdown.addTableRow':
    case 'markdown.addTableColumn':
    case 'markdown.deleteTableRow':
    case 'markdown.deleteTableColumn':
      return editTable(source, path, commandId);
    case 'markdown.nextTableCell':
      return moveTableCell(path, buffer.editor.caret.position.offset, 1);
    case 'markdown.previousTableCell':
      return moveTableCell(path, buffer.editor.caret.position.offset, -1);
    default:
      return Object.freeze({});
  }
}

export function automaticMarkdownTransition(
  buffer: BufferState,
  operation: TextEditOperation,
  source: string = buffer.preview.kind === 'ready' ? buffer.preview.snapshot.source : ''
): MarkdownEditorTransition | undefined {
  const caret = buffer.editor.caret.position.offset;
  const tree = buffer.preview.kind === 'ready' ? buffer.preview.snapshot.document.tree : undefined;
  const path = tree === undefined ? [] : markdownPathAt(tree, caret, { includeEnd: true });
  if (operation.kind === 'insert' && operation.text === '\n') {
    return continueContainer(source, caret, path, buffer.format.lineEnding === 'crlf' ? '\r\n' : '\n');
  }
  if (operation.kind === 'insert' && ['*', '**', '_', '__', '`', '```', '[', '(', ']', ')'].includes(operation.text)) {
    return insertPair(buffer, source, operation.text, path);
  }
  if (operation.kind === 'deleteBackward') return deleteEmptyPair(source, caret);
  return undefined;
}

export function listIndentTransition(
  buffer: BufferState,
  outdent: boolean,
  source: string = buffer.preview.kind === 'ready' ? buffer.preview.snapshot.source : ''
): MarkdownEditorTransition {
  if (buffer.preview.kind !== 'ready') return Object.freeze({});
  const caret = buffer.editor.caret.position.offset;
  const path = markdownPathAt(buffer.preview.snapshot.document.tree, caret, { includeEnd: true });
  const item = path.findLast((node): node is MarkdownListItemNode => node.kind === 'listItem');
  if (item === undefined) return Object.freeze({});
  const lineStart = source.lastIndexOf('\n', Math.max(0, item.markerSpan.start - 1)) + 1;
  if (outdent) {
    const whitespace = source.slice(lineStart, item.markerSpan.start);
    const removed = whitespace.endsWith('\t') ? 1 : Math.min(4, / +$/u.exec(whitespace)?.[0].length ?? 0);
    if (removed === 0) return Object.freeze({});
    return replacement(lineStart + whitespace.length - removed, lineStart + whitespace.length, '', caret - removed);
  }
  const indentation = source.includes('\t') ? '\t' : '    ';
  return replacement(lineStart, lineStart, indentation, caret + indentation.length);
}

function toggleInline(
  source: string,
  range: SourceSpan,
  path: readonly MarkdownNode[],
  kind: 'strong' | 'emphasis' | 'codeSpan',
  marker: string
): MarkdownEditorTransition {
  const existing = path.findLast((node) => node.kind === kind);
  const existingContent = existing?.kind === 'strong' || existing?.kind === 'emphasis' || existing?.kind === 'codeSpan'
    ? Object.freeze({ start: existing.openingMarkerSpan.end, end: existing.closingMarkerSpan.start })
    : undefined;
  if (
    (existing?.kind === 'strong' || existing?.kind === 'emphasis' || existing?.kind === 'codeSpan')
    && (range.start === range.end
      || (existingContent !== undefined && range.start === existingContent.start && range.end === existingContent.end))
  ) {
    const openingEnd = existing.openingMarkerSpan.end;
    const closingStart = existing.closingMarkerSpan.start;
    const inner = source.slice(openingEnd, closingStart);
    return replacement(existing.span.start, existing.span.end, inner, existing.span.start + inner.length);
  }
  const selected = source.slice(range.start, range.end);
  const inserted = marker + selected + marker;
  return replacement(
    range.start,
    range.end,
    inserted,
    selected.length === 0 ? range.start + marker.length : range.start + inserted.length
  );
}

function insertLink(
  source: string,
  range: SourceSpan,
  path: readonly MarkdownNode[],
  destination: string
): MarkdownEditorTransition {
  const link = path.findLast((node) => node.kind === 'link');
  if (link?.kind === 'link') {
    const text = source.slice(link.labelSpan?.start ?? link.span.start, link.labelSpan?.end ?? link.span.end);
    const inserted = `[${text}](${destination})`;
    return replacement(link.span.start, link.span.end, inserted, link.span.start + inserted.length);
  }
  const selected = source.slice(range.start, range.end) || 'link text';
  const inserted = `[${selected}](${destination})`;
  return replacement(range.start, range.end, inserted, range.start + inserted.length);
}

function toggleTask(source: string, path: readonly MarkdownNode[]): MarkdownEditorTransition {
  const item = path.findLast((node) => node.kind === 'listItem');
  if (item?.kind !== 'listItem') return Object.freeze({});
  if (item.task !== null) {
    return replacement(item.task.span.start + 1, item.task.span.start + 2, item.task.checked ? ' ' : 'x');
  }
  const insertAt = item.markerSpan.end;
  const following = source[insertAt] === ' ' || source[insertAt] === '\t' ? insertAt + 1 : insertAt;
  return replacement(following, following, '[ ] ');
}

function changeHeading(source: string, path: readonly MarkdownNode[], delta: -1 | 1): MarkdownEditorTransition {
  const heading = path.findLast((node) => node.kind === 'heading');
  if (heading?.kind !== 'heading') return Object.freeze({});
  const depth = Math.max(1, Math.min(6, heading.depth + delta));
  if (depth === heading.depth) return Object.freeze({});
  if (heading.style === 'atx') {
    const opening = heading.markerSpans[0];
    if (opening === undefined) return Object.freeze({});
    return replacement(opening.start, opening.end, '#'.repeat(depth));
  }
  const content = source.slice(heading.contentSpan.start, heading.contentSpan.end);
  const inserted = `${'#'.repeat(depth)} ${content}`;
  return replacement(heading.span.start, heading.span.end, inserted);
}

function insertCodeFence(source: string, range: SourceSpan, language: string): MarkdownEditorTransition {
  const lineEnding = source.includes('\r\n') ? '\r\n' : '\n';
  const selected = source.slice(range.start, range.end);
  const inserted = `\`\`\`${language}${lineEnding}${selected}${lineEnding}\`\`\``;
  return replacement(range.start, range.end, inserted, range.start + inserted.length);
}

function moveBlock(
  source: string,
  blocks: readonly MarkdownBlockNode[],
  caret: number,
  delta: -1 | 1
): MarkdownEditorTransition {
  const index = blocks.findIndex((block) => block.span.start <= caret && caret <= block.span.end);
  const targetIndex = index + delta;
  const current = blocks[index];
  const target = blocks[targetIndex];
  if (current === undefined || target === undefined) return Object.freeze({});
  const first = delta < 0 ? target : current;
  const second = delta < 0 ? current : target;
  const between = source.slice(first.span.end, second.span.start);
  const inserted = source.slice(second.span.start, second.span.end)
    + between
    + source.slice(first.span.start, first.span.end);
  const movedStart = delta < 0 ? first.span.start : first.span.start + inserted.length - (current.span.end - current.span.start);
  return replacement(first.span.start, second.span.end, inserted, movedStart);
}

function duplicateBlock(
  source: string,
  blocks: readonly MarkdownBlockNode[],
  caret: number
): MarkdownEditorTransition {
  const block = blocks.find((candidate) => candidate.span.start <= caret && caret <= candidate.span.end);
  if (block === undefined) return Object.freeze({});
  const lineEnding = source.includes('\r\n') ? '\r\n' : '\n';
  const raw = source.slice(block.span.start, block.span.end);
  return replacement(block.span.end, block.span.end, lineEnding + lineEnding + raw, block.span.end + lineEnding.length * 2);
}

function editTable(source: string, path: readonly MarkdownNode[], commandId: CommandId): MarkdownEditorTransition {
  const table = path.findLast((node): node is MarkdownTableNode => node.kind === 'table');
  if (table === undefined) return Object.freeze({});
  const rows = [table.header, ...table.rows].map((row) => row.cells.map((cell) => (
    source.slice(cell.contentSpan.start, cell.contentSpan.end).trim()
  )));
  if (commandId === 'markdown.addTableRow') rows.push(Array.from({ length: table.align.length }, () => ''));
  if (commandId === 'markdown.addTableColumn') {
    for (const row of rows) row.push('');
  }
  const activeCell = path.findLast((node) => node.kind === 'tableCell');
  if (commandId === 'markdown.deleteTableRow' && activeCell?.kind === 'tableCell') {
    const row = path.findLast((node) => node.kind === 'tableRow');
    const rowIndex = row === undefined ? -1 : [table.header, ...table.rows].findIndex((entry) => entry.id === row.id);
    if (rowIndex > 0) rows.splice(rowIndex, 1);
  }
  if (commandId === 'markdown.deleteTableColumn' && activeCell?.kind === 'tableCell' && rows[0]?.length !== 1) {
    for (const row of rows) row.splice(activeCell.column, 1);
  }
  const align = commandId === 'markdown.addTableColumn' ? [...table.align, null] : commandId === 'markdown.deleteTableColumn' && activeCell?.kind === 'tableCell'
    ? table.align.filter((_, index) => index !== activeCell.column)
    : [...table.align];
  const widths = align.map((_, column) => Math.max(3, ...rows.map((row) => measureTextCells(row[column] ?? '').cells)));
  const renderRow = (row: readonly string[]): string => `| ${widths.map((width, column) => (
    padTerminalCells(row[column] ?? '', width)
  )).join(' | ')} |`;
  const delimiter = `| ${widths.map((width, column) => {
    const marker = '-'.repeat(width);
    return align[column] === 'center' ? `:${marker.slice(2)}:` : align[column] === 'left' ? `:${marker.slice(1)}` : align[column] === 'right' ? `${marker.slice(1)}:` : marker;
  }).join(' | ')} |`;
  const lineEnding = source.includes('\r\n') ? '\r\n' : '\n';
  const inserted = [renderRow(rows[0] ?? []), delimiter, ...rows.slice(1).map(renderRow)].join(lineEnding);
  return replacement(table.span.start, table.span.end, inserted);
}

function moveTableCell(path: readonly MarkdownNode[], caret: number, delta: -1 | 1): MarkdownEditorTransition {
  const table = path.findLast((node): node is MarkdownTableNode => node.kind === 'table');
  const cell = path.findLast((node) => node.kind === 'tableCell');
  if (table === undefined || cell?.kind !== 'tableCell') return Object.freeze({});
  const cells = [table.header, ...table.rows].flatMap((row) => row.cells);
  const index = cells.findIndex((candidate) => candidate.id === cell.id);
  const next = cells[index + delta];
  return Object.freeze({ caretOffset: next?.contentSpan.start ?? caret });
}

function continueContainer(
  source: string,
  caret: number,
  path: readonly MarkdownNode[],
  lineEnding: string
): MarkdownEditorTransition | undefined {
  const lineStart = source.lastIndexOf('\n', Math.max(0, caret - 1)) + 1;
  const lineEnd = source.indexOf('\n', caret);
  const currentLineEnd = lineEnd < 0 ? source.length : lineEnd;
  const lineTail = source.slice(caret, currentLineEnd);
  if (lineTail.trim().length > 0) return undefined;
  const item = path.findLast((node) => node.kind === 'listItem');
  const list = path.findLast((node) => node.kind === 'list');
  if (item?.kind === 'listItem' && list?.kind === 'list') {
    const marker = source.slice(item.markerSpan.start, item.markerSpan.end);
    const contentStart = item.task?.span.end ?? item.markerSpan.end;
    const empty = source.slice(contentStart, currentLineEnd).trim().length === 0;
    if (empty && lineStart <= item.markerSpan.start) {
      return replacement(lineStart, currentLineEnd, '', lineStart);
    }
    const indentation = source.slice(lineStart, item.markerSpan.start);
    const nextMarker = list.ordered
      ? `${(list.start ?? 1) + list.items.findIndex((candidate) => candidate.id === item.id) + 1}${list.delimiter ?? '.'}`
      : marker;
    const task = item.task === null ? '' : '[ ] ';
    const inserted = `${lineEnding}${indentation}${nextMarker} ${task}`;
    return replacement(caret, caret, inserted, caret + inserted.length);
  }
  const quote = path.findLast((node) => node.kind === 'blockQuote' || node.kind === 'callout');
  if (quote?.kind === 'blockQuote' || quote?.kind === 'callout') {
    const marker = quote.markerSpans.find((candidate) => candidate.start >= lineStart && candidate.start <= currentLineEnd);
    if (marker !== undefined) {
      const empty = source.slice(marker.end, currentLineEnd).trim().length === 0;
      if (empty) return replacement(lineStart, currentLineEnd, '', lineStart);
      const indentation = source.slice(lineStart, marker.start);
      const inserted = `${lineEnding}${indentation}> `;
      return replacement(caret, caret, inserted, caret + inserted.length);
    }
  }
  return undefined;
}

function insertPair(
  buffer: BufferState,
  source: string,
  opening: string,
  path: readonly MarkdownNode[]
): MarkdownEditorTransition | undefined {
  const range = textDocumentSelectionRange(buffer.editor.document, buffer.editor.selection, buffer.editor.caret);
  if ((opening === ']' || opening === ')') && range.startOffset === range.endOffsetExclusive) {
    return source.startsWith(opening, range.startOffset)
      ? Object.freeze({ caretOffset: range.startOffset + opening.length })
      : undefined;
  }
  if (opening === '```') {
    if (range.startOffset !== range.endOffsetExclusive) {
      return insertCodeFence(source, { start: range.startOffset, end: range.endOffsetExclusive }, '');
    }
    const lineStart = source.lastIndexOf('\n', Math.max(0, range.startOffset - 1)) + 1;
    if (source.slice(lineStart, range.startOffset).trim().length > 0) return undefined;
    const lineEnding = buffer.format.lineEnding === 'crlf' ? '\r\n' : '\n';
    const inserted = `\`\`\`${lineEnding}${lineEnding}\`\`\``;
    return replacement(range.startOffset, range.endOffsetExclusive, inserted, range.startOffset + 3 + lineEnding.length);
  }
  const insideLiteral = path.some((node) => node.kind === 'codeBlock' || node.kind === 'codeSpan' || node.kind === 'mathBlock');
  if (insideLiteral && opening !== '`') return undefined;
  if (isEscaped(source, range.startOffset)) return undefined;
  const closing = opening === '[' ? ']' : opening === '(' ? ')' : opening;
  if (range.startOffset === range.endOffsetExclusive && source.startsWith(closing, range.startOffset)) {
    return Object.freeze({ caretOffset: range.startOffset + closing.length });
  }
  const selected = source.slice(range.startOffset, range.endOffsetExclusive);
  const inserted = opening + selected + closing;
  return replacement(
    range.startOffset,
    range.endOffsetExclusive,
    inserted,
    range.startOffset + opening.length + selected.length
  );
}

function deleteEmptyPair(source: string, caret: number): MarkdownEditorTransition | undefined {
  for (const marker of ['**', '__', '*', '_', '`', '[', '(']) {
    const closing = marker === '[' ? ']' : marker === '(' ? ')' : marker;
    const start = caret - marker.length;
    if (start >= 0 && source.slice(start, caret) === marker && source.slice(caret, caret + closing.length) === closing) {
      return replacement(start, caret + closing.length, '', start);
    }
  }
  return undefined;
}

function isEscaped(source: string, offset: number): boolean {
  let slashes = 0;
  for (let index = offset - 1; index >= 0 && source[index] === '\\'; index -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function padTerminalCells(value: string, width: number): string {
  const cells = measureTextCells(value).cells;
  return cells >= width ? value : value + ' '.repeat(width - cells);
}

function replacement(
  startOffset: number,
  endOffsetExclusive: number,
  text: string,
  caretOffset?: number
): MarkdownEditorTransition {
  return Object.freeze({
    action: Object.freeze({
      kind: 'edit',
      operation: Object.freeze({
        kind: 'replaceRange',
        range: Object.freeze({ startOffset, endOffsetExclusive }),
        text
      })
    }),
    ...(caretOffset === undefined ? {} : { caretOffset })
  });
}
