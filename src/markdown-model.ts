import { marked, type Token } from 'marked';
import { sanitizeTerminalCellText, sanitizeTerminalText } from '@ismail-elkorchi/terminal-ui/text';

export type MarkdownInline =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'strong'; readonly children: readonly MarkdownInline[] }
  | { readonly kind: 'emphasis'; readonly children: readonly MarkdownInline[] }
  | { readonly kind: 'delete'; readonly children: readonly MarkdownInline[] }
  | { readonly kind: 'code'; readonly text: string }
  | { readonly kind: 'link'; readonly href: string; readonly title?: string; readonly children: readonly MarkdownInline[] }
  | { readonly kind: 'image'; readonly href: string; readonly alt: string; readonly title?: string }
  | { readonly kind: 'softBreak' }
  | { readonly kind: 'hardBreak' }
  | { readonly kind: 'html'; readonly label: string };

export type MarkdownBlock =
  | { readonly kind: 'heading'; readonly depth: number; readonly content: readonly MarkdownInline[] }
  | { readonly kind: 'paragraph'; readonly content: readonly MarkdownInline[] }
  | { readonly kind: 'blockquote'; readonly blocks: readonly MarkdownBlock[] }
  | { readonly kind: 'list'; readonly ordered: boolean; readonly start: number; readonly loose: boolean; readonly items: readonly MarkdownListItem[] }
  | { readonly kind: 'code'; readonly language?: string; readonly text: string }
  | { readonly kind: 'table'; readonly align: readonly MarkdownTableAlignment[]; readonly header: readonly MarkdownTableCell[]; readonly rows: readonly (readonly MarkdownTableCell[])[] }
  | { readonly kind: 'rule' }
  | { readonly kind: 'image'; readonly href: string; readonly alt: string; readonly title?: string }
  | { readonly kind: 'html'; readonly label: string };

export interface MarkdownListItem {
  readonly task: boolean;
  readonly checked?: boolean;
  readonly loose: boolean;
  readonly blocks: readonly MarkdownBlock[];
}

export type MarkdownTableAlignment = 'left' | 'right' | 'center' | null;

export interface MarkdownTableCell {
  readonly content: readonly MarkdownInline[];
}

export interface MarkdownDocument {
  readonly blocks: readonly MarkdownBlock[];
  readonly wordCount: number;
}

type TokenRecord = Token & Readonly<Record<string, unknown>>;

type MarkedListItem = Readonly<{
  tokens?: readonly Token[];
  text?: string;
  task?: boolean;
  checked?: boolean;
  loose?: boolean;
}>;

type MarkedTableCell = Readonly<{
  tokens?: readonly Token[];
  text?: string;
}>;

let cachedSource: string | undefined;
let cachedDocument: MarkdownDocument | undefined;

function safeText(value: unknown): string {
  return sanitizeTerminalText(typeof value === 'string' ? value : '').text;
}

function safeCellText(value: unknown): string {
  return sanitizeTerminalCellText(typeof value === 'string' ? value : '').text;
}

function safeHref(value: unknown): string {
  return safeCellText(value).trim();
}

function optionalSafeText(value: unknown): string | undefined {
  const text = safeText(value).trim();
  return text.length === 0 ? undefined : text;
}

function nestedTokens(token: TokenRecord): readonly Token[] | undefined {
  const value = token.tokens;
  return Array.isArray(value) ? value as readonly Token[] : undefined;
}

function splitTextWithSoftBreaks(text: string): MarkdownInline[] {
  const normalized = safeText(text).replace(/\r\n?/gu, '\n');
  if (!normalized.includes('\n')) {
    return normalized.length === 0 ? [] : [{ kind: 'text', text: normalized }];
  }

  const parts = normalized.split('\n');
  const result: MarkdownInline[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index] ?? '';
    if (part.length > 0) result.push({ kind: 'text', text: part });
    if (index < parts.length - 1) result.push({ kind: 'softBreak' });
  }
  return result;
}

function htmlLabel(raw: string, block: boolean): string {
  const match = /<\s*(\/?)\s*([A-Za-z][A-Za-z0-9:-]*)/u.exec(raw);
  const tag = match?.[2]?.toLowerCase();
  if (tag !== undefined) {
    const label = `<${match?.[1] === '/' ? '/' : ''}${tag}>`;
    return block ? `HTML block: ${label}` : `HTML tag: ${label}`;
  }
  return block ? 'HTML block' : 'HTML';
}

function parseInlineTokens(tokens: readonly Token[] | undefined, fallback = ''): readonly MarkdownInline[] {
  if (tokens === undefined || tokens.length === 0) {
    return splitTextWithSoftBreaks(fallback);
  }

  const result: MarkdownInline[] = [];
  for (const token of tokens) {
    const record = token as TokenRecord;
    switch (token.type) {
      case 'text':
      case 'escape': {
        const children = nestedTokens(record);
        if (children !== undefined && children.length > 0) {
          result.push(...parseInlineTokens(children, safeText(record.text)));
        } else {
          result.push(...splitTextWithSoftBreaks(safeText(record.text ?? record.raw)));
        }
        break;
      }
      case 'strong':
        result.push({
          kind: 'strong',
          children: parseInlineTokens(nestedTokens(record), safeText(record.text))
        });
        break;
      case 'em':
        result.push({
          kind: 'emphasis',
          children: parseInlineTokens(nestedTokens(record), safeText(record.text))
        });
        break;
      case 'del':
        result.push({
          kind: 'delete',
          children: parseInlineTokens(nestedTokens(record), safeText(record.text))
        });
        break;
      case 'codespan':
        result.push({ kind: 'code', text: safeText(record.text) });
        break;
      case 'br':
        result.push({ kind: 'hardBreak' });
        break;
      case 'link': {
        const href = safeHref(record.href);
        const children = parseInlineTokens(nestedTokens(record), safeText(record.text));
        if (href.length === 0) {
          result.push(...children);
        } else {
          result.push({
            kind: 'link',
            href,
            ...(optionalSafeText(record.title) === undefined ? {} : { title: optionalSafeText(record.title) }),
            children
          });
        }
        break;
      }
      case 'image': {
        const href = safeHref(record.href);
        result.push({
          kind: 'image',
          href,
          alt: safeText(record.text).trim(),
          ...(optionalSafeText(record.title) === undefined ? {} : { title: optionalSafeText(record.title) })
        });
        break;
      }
      case 'html':
        result.push({ kind: 'html', label: htmlLabel(safeText(record.text ?? record.raw), false) });
        break;
      case 'checkbox':
        break;
      default: {
        const children = nestedTokens(record);
        if (children !== undefined && children.length > 0) {
          result.push(...parseInlineTokens(children, safeText(record.text ?? record.raw)));
        } else {
          result.push(...splitTextWithSoftBreaks(safeText(record.text ?? record.raw)));
        }
      }
    }
  }
  return result;
}

function paragraphOrImage(content: readonly MarkdownInline[]): MarkdownBlock {
  const meaningful = content.filter((inline) => inline.kind !== 'text' || inline.text.trim().length > 0);
  if (meaningful.length === 1 && meaningful[0]?.kind === 'image') {
    const image = meaningful[0];
    return {
      kind: 'image',
      href: image.href,
      alt: image.alt,
      ...(image.title === undefined ? {} : { title: image.title })
    };
  }
  return { kind: 'paragraph', content };
}

function parseListItem(item: MarkedListItem): MarkdownListItem {
  const itemTokens = (item.tokens ?? []).filter((token) => token.type !== 'checkbox');
  const blocks = parseBlockTokens(itemTokens);
  const resolvedBlocks = blocks.length > 0
    ? blocks
    : [paragraphOrImage(parseInlineTokens(undefined, item.text ?? ''))];

  return {
    task: item.task === true,
    ...(item.task === true ? { checked: item.checked === true } : {}),
    loose: item.loose === true,
    blocks: resolvedBlocks
  };
}

function tableCell(value: unknown): MarkdownTableCell {
  const cell = (value ?? {}) as MarkedTableCell;
  return {
    content: parseInlineTokens(cell.tokens, cell.text ?? '')
  };
}

function normalizeAlignment(value: unknown): MarkdownTableAlignment {
  return value === 'left' || value === 'right' || value === 'center' ? value : null;
}

function parseBlockToken(token: Token): MarkdownBlock[] {
  const record = token as TokenRecord;
  switch (token.type) {
    case 'space':
    case 'def':
      return [];
    case 'heading': {
      const rawDepth = typeof record.depth === 'number' ? record.depth : 1;
      const depth = Math.max(1, Math.min(6, Math.floor(rawDepth)));
      return [{
        kind: 'heading',
        depth,
        content: parseInlineTokens(nestedTokens(record), safeText(record.text))
      }];
    }
    case 'paragraph':
      return [paragraphOrImage(parseInlineTokens(nestedTokens(record), safeText(record.text)))];
    case 'text':
      return [paragraphOrImage(parseInlineTokens(nestedTokens(record), safeText(record.text ?? record.raw)))];
    case 'blockquote': {
      const children = Array.isArray(record.tokens) ? record.tokens as readonly Token[] : [];
      return [{ kind: 'blockquote', blocks: parseBlockTokens(children) }];
    }
    case 'list': {
      const rawItems = Array.isArray(record.items) ? record.items as readonly MarkedListItem[] : [];
      const ordered = record.ordered === true;
      const rawStart = typeof record.start === 'number' ? record.start : Number(record.start);
      const start = ordered && Number.isSafeInteger(rawStart) && rawStart >= 0 ? rawStart : 1;
      return [{
        kind: 'list',
        ordered,
        start,
        loose: record.loose === true || rawItems.some((item) => item.loose === true),
        items: rawItems.map(parseListItem)
      }];
    }
    case 'code': {
      const language = optionalSafeText(record.lang)?.split(/\s+/u)[0];
      return [{
        kind: 'code',
        ...(language === undefined ? {} : { language }),
        text: safeText(record.text).replace(/\r\n?/gu, '\n')
      }];
    }
    case 'table': {
      const header = Array.isArray(record.header) ? record.header.map(tableCell) : [];
      const rows = Array.isArray(record.rows)
        ? (record.rows as readonly unknown[]).map((row) => Array.isArray(row) ? row.map(tableCell) : [])
        : [];
      const align = Array.isArray(record.align) ? record.align.map(normalizeAlignment) : [];
      return [{ kind: 'table', align, header, rows }];
    }
    case 'hr':
      return [{ kind: 'rule' }];
    case 'html':
      return [{ kind: 'html', label: htmlLabel(safeText(record.text ?? record.raw), true) }];
    default: {
      const children = nestedTokens(record);
      if (children !== undefined && children.length > 0) {
        return [paragraphOrImage(parseInlineTokens(children, safeText(record.text ?? record.raw)))];
      }
      const fallback = safeText(record.text ?? record.raw);
      return fallback.trim().length === 0 ? [] : [paragraphOrImage(parseInlineTokens(undefined, fallback))];
    }
  }
}

function parseBlockTokens(tokens: readonly Token[]): readonly MarkdownBlock[] {
  return tokens.flatMap(parseBlockToken);
}

function inlinePlainText(inlines: readonly MarkdownInline[]): string {
  return inlines.map((inline) => {
    switch (inline.kind) {
      case 'text':
      case 'code':
        return inline.text;
      case 'strong':
      case 'emphasis':
      case 'delete':
      case 'link':
        return inlinePlainText(inline.children);
      case 'image':
        return inline.alt.length > 0 ? inline.alt : inline.href;
      case 'softBreak':
        return ' ';
      case 'hardBreak':
        return '\n';
      case 'html':
        return '';
    }
  }).join('');
}

function blockPlainText(block: MarkdownBlock): string {
  switch (block.kind) {
    case 'heading':
    case 'paragraph':
      return inlinePlainText(block.content);
    case 'blockquote':
      return block.blocks.map(blockPlainText).join('\n');
    case 'list':
      return block.items.map((item) => item.blocks.map(blockPlainText).join('\n')).join('\n');
    case 'code':
      return block.text;
    case 'table':
      return [block.header, ...block.rows]
        .map((row) => row.map((cell) => inlinePlainText(cell.content)).join(' '))
        .join('\n');
    case 'rule':
    case 'html':
      return '';
    case 'image':
      return block.alt.length > 0 ? block.alt : block.href;
  }
}

export function countMarkdownWords(text: string): number {
  return text.match(/[\p{L}\p{N}]+(?:[’'\-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
}

export function parseMarkdownDocument(source: string): MarkdownDocument {
  const normalizedSource = safeText(source).replace(/\r\n?/gu, '\n');
  const tokens = marked.lexer(normalizedSource) as unknown as readonly Token[];
  const blocks = parseBlockTokens(tokens);
  const plainText = blocks.map(blockPlainText).filter((part) => part.length > 0).join('\n\n');
  return Object.freeze({
    blocks: Object.freeze([...blocks]),
    wordCount: countMarkdownWords(plainText)
  });
}

export function getMarkdownDocument(source: string): MarkdownDocument {
  if (source === cachedSource && cachedDocument !== undefined) return cachedDocument;
  const parsed = parseMarkdownDocument(source);
  cachedSource = source;
  cachedDocument = parsed;
  return parsed;
}
