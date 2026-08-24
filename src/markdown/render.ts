import { defineComponent } from '@ismail-elkorchi/terminal-ui/component';
import type { AccessibleNode } from '@ismail-elkorchi/terminal-ui/accessibility';
import {
  clipRenderSpans,
  compactRenderSpans,
  measureRenderSpans,
  mergeTerminalStyles,
  padRenderLine,
  type RenderLine,
  type RenderSpan,
  type TerminalLink,
  type TerminalStyle
} from '@ismail-elkorchi/terminal-ui/renderer';
import {
  defaultTextWidthProfile,
  measureTextCells,
  sanitizeTerminalCellText,
  sanitizeTerminalText,
  textWidthProfileKey,
  type TextWidthProfile
} from '@ismail-elkorchi/terminal-ui/text';
import { themeColor, unicodeSymbols, type TerminalSymbols } from '@ismail-elkorchi/terminal-ui/theme';
import type {
  MarkdownBlockNode,
  MarkdownInlineNode,
  MarkdownListItemNode,
  MarkdownTableAlignment,
  MarkdownTableCellNode,
  SourceSpan
} from 'markspan';
import type {
  MarkdownPreview,
  ReadyMarkdownPreview
} from './preview.js';

const STYLE_BODY: TerminalStyle = { fg: themeColor('text.default') };
const STYLE_MUTED: TerminalStyle = { fg: themeColor('text.muted'), dim: true };
const STYLE_STRONG: TerminalStyle = { fg: themeColor('text.strong'), bold: true };
const STYLE_ACCENT: TerminalStyle = { fg: themeColor('accent.primary') };
const STYLE_LINK: TerminalStyle = { fg: themeColor('link.foreground'), underline: true };
const STYLE_INLINE_CODE: TerminalStyle = {
  fg: themeColor('accent.primary'),
  bg: themeColor('surface.inset.background')
};
const STYLE_CODE: TerminalStyle = {
  fg: themeColor('text.default'),
  bg: themeColor('surface.inset.background')
};
const STYLE_CODE_LABEL: TerminalStyle = {
  fg: themeColor('accent.primary'),
  bg: themeColor('surface.bar.background'),
  bold: true
};
const STYLE_BORDER: TerminalStyle = { fg: themeColor('surface.inset.border'), dim: true };
const STYLE_RULE: TerminalStyle = { fg: themeColor('surface.border'), dim: true };
const STYLE_TABLE_HEADER: TerminalStyle = { fg: themeColor('table.header'), bold: true };
const STYLE_CHECKED: TerminalStyle = { fg: themeColor('status.success'), bold: true };
const STYLE_UNCHECKED: TerminalStyle = { fg: themeColor('text.muted') };
const STYLE_HTML: TerminalStyle = {
  fg: themeColor('text.muted'),
  bg: themeColor('surface.inset.background'),
  dim: true
};

const HEADING_STYLES: readonly TerminalStyle[] = [
  { fg: themeColor('accent.primary'), bold: true },
  { fg: themeColor('text.strong'), bold: true },
  { fg: themeColor('accent.primary'), bold: true },
  { fg: themeColor('text.strong'), bold: true },
  { fg: themeColor('text.strong'), italic: true },
  { fg: themeColor('text.muted'), italic: true, dim: true }
];

export interface MarkdownLayoutOptions {
  readonly width: number;
  readonly widthProfile?: TextWidthProfile;
  readonly symbols?: TerminalSymbols;
  readonly maxContentWidth?: number;
  readonly minHorizontalPadding?: number;
}

export interface MarkdownLayoutResult {
  readonly lines: readonly MarkdownLayoutLine[];
  readonly width: number;
  readonly contentWidth: number;
  readonly leftPadding: number;
}

export interface MarkdownLayoutLine extends RenderLine {
  readonly nodeId?: number;
  readonly sourceSpan?: SourceSpan;
}

export type MarkdownPreviewCommand =
  | 'lineUp'
  | 'lineDown'
  | 'pageUp'
  | 'pageDown'
  | 'top'
  | 'bottom';

export interface MarkdownDocumentAction {
  readonly kind: 'scroll';
  readonly command: MarkdownPreviewCommand;
  readonly pageRows: number;
  readonly contentRows: number;
}

export interface MarkdownDocumentComponentOptions {
  readonly document: MarkdownPreview;
  readonly maxContentWidth?: number;
  readonly minHorizontalPadding?: number;
  readonly pageRows?: number;
  readonly contentRows?: number;
}

interface PreparedMarkdownDocumentComponentOptions {
  readonly document: MarkdownPreview;
  readonly maxContentWidth: number;
  readonly minHorizontalPadding: number;
  readonly pageRows: number;
  readonly contentRows: number;
}

interface LayoutContext {
  readonly widthProfile: TextWidthProfile;
  readonly symbols: TerminalSymbols;
  readonly blockCache: Map<string, CachedBlockLayout>;
}

interface StyledGrapheme {
  readonly text: string;
  readonly cells: number;
  readonly style?: TerminalStyle;
  readonly link?: TerminalLink;
}

type WrapToken =
  | { readonly kind: 'word'; readonly graphemes: readonly StyledGrapheme[] }
  | { readonly kind: 'space'; readonly grapheme?: StyledGrapheme }
  | { readonly kind: 'break' };

interface CachedBlockLayout {
  readonly kind: MarkdownBlockNode['kind'];
  readonly spanStart: number;
  readonly lines: readonly MarkdownLayoutLine[];
}

const layoutCache = new WeakMap<MarkdownPreview['identity'], Map<string, MarkdownLayoutResult>>();
const blockLayoutCache = new WeakMap<MarkdownPreview['identity'], Map<string, CachedBlockLayout>>();
const LAYOUT_CACHE_LIMIT = 8;
const BLOCK_LAYOUT_CACHE_LIMIT = 4_096;

function normalizeBoundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  subject: string
): number {
  const resolved = value ?? fallback;
  if (typeof resolved !== 'number' || !Number.isFinite(resolved)) {
    throw new TypeError(`${subject} must be a finite number.`);
  }
  return Math.max(minimum, Math.min(maximum, Math.floor(resolved)));
}

function renderSpan(text: string, spanStyle?: TerminalStyle, link?: TerminalLink): RenderSpan {
  return {
    text,
    ...(spanStyle === undefined ? {} : { style: spanStyle }),
    ...(link === undefined ? {} : { link })
  };
}

function textLine(spans: readonly RenderSpan[] = []): MarkdownLayoutLine {
  return { spans: compactRenderSpans(spans) };
}

function emptyLine(): MarkdownLayoutLine {
  return { spans: [] };
}

function safeText(value: string): string {
  return sanitizeTerminalText(value).text;
}

function safeHref(value: string): string {
  return sanitizeTerminalCellText(value).text.trim();
}

function htmlLabel(raw: string, block: boolean): string {
  const match = /<\s*(\/?)\s*([A-Za-z][A-Za-z0-9:-]*)/u.exec(raw);
  const tag = match?.[2]?.toLowerCase();
  if (tag === undefined) return block ? 'HTML block' : 'HTML';
  const label = `<${match?.[1] === '/' ? '/' : ''}${tag}>`;
  return block ? `HTML block: ${label}` : `HTML tag: ${label}`;
}

function mapSpanStyle(spans: readonly RenderSpan[], extra: TerminalStyle): readonly RenderSpan[] {
  return spans.map((current) => {
    const style = mergeTerminalStyles(current.style, extra);
    return {
      ...current,
      ...(style === undefined ? {} : { style })
    };
  });
}

function inlineToSpans(
  content: readonly MarkdownInlineNode[],
  inheritedStyle: TerminalStyle = STYLE_BODY,
  inheritedLink?: TerminalLink
): readonly RenderSpan[] {
  const spans: RenderSpan[] = [];

  const visit = (
    inline: MarkdownInlineNode,
    parentStyle: TerminalStyle,
    parentLink?: TerminalLink
  ): void => {
    switch (inline.kind) {
      case 'text':
      case 'escape':
      case 'characterReference':
        spans.push(renderSpan(safeText(inline.value), parentStyle, parentLink));
        break;
      case 'strong':
        for (const child of inline.children) visit(child, mergeTerminalStyles(parentStyle, { bold: true }) ?? parentStyle, parentLink);
        break;
      case 'emphasis':
        for (const child of inline.children) visit(child, mergeTerminalStyles(parentStyle, { italic: true }) ?? parentStyle, parentLink);
        break;
      case 'strikethrough':
        for (const child of inline.children) visit(child, mergeTerminalStyles(parentStyle, { strikethrough: true }) ?? parentStyle, parentLink);
        break;
      case 'codeSpan':
        spans.push(renderSpan(safeText(inline.value), mergeTerminalStyles(parentStyle, STYLE_INLINE_CODE), parentLink));
        break;
      case 'link': {
        const destination = safeHref(inline.destination);
        const link = destination.length === 0 ? parentLink : { href: destination };
        for (const child of inline.children) visit(child, mergeTerminalStyles(parentStyle, STYLE_LINK) ?? parentStyle, link);
        break;
      }
      case 'image': {
        const label = inlineText(inline.children) || 'image';
        const href = safeHref(inline.destination);
        const destination = href.length > 0 ? ` → ${href}` : '';
        spans.push(renderSpan(
          `[Image: ${label}${destination}]`,
          mergeTerminalStyles(parentStyle, STYLE_ACCENT, { italic: true }),
          href.length === 0 ? parentLink : { href }
        ));
        break;
      }
      case 'softBreak':
        spans.push(renderSpan(' ', parentStyle, parentLink));
        break;
      case 'hardBreak':
        spans.push(renderSpan('\n', parentStyle, parentLink));
        break;
      case 'htmlInline':
        spans.push(renderSpan(htmlLabel(safeText(inline.value), false), mergeTerminalStyles(parentStyle, STYLE_HTML), parentLink));
        break;
      case 'footnoteReference':
        spans.push(renderSpan(`[^${safeText(inline.label)}]`, mergeTerminalStyles(parentStyle, STYLE_ACCENT), parentLink));
        break;
    }
  };

  for (const inline of content) visit(inline, inheritedStyle, inheritedLink);
  return compactRenderSpans(spans);
}

function spansToWrapTokens(spans: readonly RenderSpan[], context: LayoutContext): readonly WrapToken[] {
  const tokens: WrapToken[] = [];
  let word: StyledGrapheme[] = [];

  const flushWord = (): void => {
    if (word.length === 0) return;
    tokens.push({ kind: 'word', graphemes: word });
    word = [];
  };

  for (const current of spans) {
    for (const grapheme of measureTextCells(current.text, { widthProfile: context.widthProfile }).graphemes) {
      if (grapheme.text === '\n') {
        flushWord();
        tokens.push({ kind: 'break' });
        continue;
      }

      if (/^\s+$/u.test(grapheme.text)) {
        flushWord();
        if (tokens.at(-1)?.kind !== 'space' && tokens.at(-1)?.kind !== 'break') {
          tokens.push({
            kind: 'space',
            grapheme: {
              text: ' ',
              cells: 1,
              ...(current.style === undefined ? {} : { style: current.style }),
              ...(current.link === undefined ? {} : { link: current.link })
            }
          });
        }
        continue;
      }

      word.push({
        text: grapheme.text,
        cells: grapheme.cells,
        ...(current.style === undefined ? {} : { style: current.style }),
        ...(current.link === undefined ? {} : { link: current.link })
      });
    }
  }
  flushWord();
  return tokens;
}

function graphemesToSpans(graphemes: readonly StyledGrapheme[]): readonly RenderSpan[] {
  return compactRenderSpans(graphemes.map((grapheme) => renderSpan(grapheme.text, grapheme.style, grapheme.link)));
}

function splitWord(
  graphemes: readonly StyledGrapheme[],
  width: number
): readonly (readonly StyledGrapheme[])[] {
  const chunks: StyledGrapheme[][] = [];
  let chunk: StyledGrapheme[] = [];
  let used = 0;

  const flush = (): void => {
    if (chunk.length === 0) return;
    chunks.push(chunk);
    chunk = [];
    used = 0;
  };

  for (const grapheme of graphemes) {
    if (grapheme.cells > width) {
      flush();
      chunks.push([{ ...grapheme, text: '?', cells: 1 }]);
      continue;
    }
    if (used > 0 && used + grapheme.cells > width) flush();
    chunk.push(grapheme);
    used += grapheme.cells;
  }
  flush();
  return chunks;
}

function wrapSpansAtWords(
  spans: readonly RenderSpan[],
  width: number,
  context: LayoutContext
): readonly RenderLine[] {
  const safeWidth = Math.max(1, width);
  const tokens = spansToWrapTokens(spans, context);
  const lines: RenderLine[] = [];
  let lineGraphemes: StyledGrapheme[] = [];
  let lineCells = 0;
  let pendingSpace: StyledGrapheme | undefined;

  const flushLine = (force = false): void => {
    if (!force && lineGraphemes.length === 0) return;
    lines.push(textLine(graphemesToSpans(lineGraphemes)));
    lineGraphemes = [];
    lineCells = 0;
    pendingSpace = undefined;
  };

  for (const token of tokens) {
    if (token.kind === 'break') {
      flushLine(true);
      continue;
    }
    if (token.kind === 'space') {
      if (lineGraphemes.length > 0) pendingSpace = token.grapheme;
      continue;
    }

    const wordCells = token.graphemes.reduce((sum, grapheme) => sum + grapheme.cells, 0);
    const spaceCells = lineGraphemes.length > 0 && pendingSpace !== undefined ? 1 : 0;
    if (lineGraphemes.length > 0 && lineCells + spaceCells + wordCells > safeWidth) {
      flushLine();
    }

    if (wordCells <= safeWidth) {
      if (lineGraphemes.length > 0 && pendingSpace !== undefined) {
        lineGraphemes.push(pendingSpace);
        lineCells += 1;
      }
      lineGraphemes.push(...token.graphemes);
      lineCells += wordCells;
      pendingSpace = undefined;
      continue;
    }

    const chunks = splitWord(token.graphemes, safeWidth);
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index] ?? [];
      const chunkCells = chunk.reduce((sum, grapheme) => sum + grapheme.cells, 0);
      if (lineGraphemes.length > 0 && pendingSpace !== undefined && lineCells + 1 + chunkCells <= safeWidth) {
        lineGraphemes.push(pendingSpace);
        lineCells += 1;
      }
      lineGraphemes.push(...chunk);
      lineCells += chunkCells;
      pendingSpace = undefined;
      if (index < chunks.length - 1) flushLine();
    }
  }

  flushLine(lines.length === 0);
  return lines;
}

function inlineLines(
  content: readonly MarkdownInlineNode[],
  width: number,
  context: LayoutContext,
  baseStyle: TerminalStyle = STYLE_BODY
): readonly RenderLine[] {
  return wrapSpansAtWords(inlineToSpans(content, baseStyle), width, context);
}

function repeatGlyph(glyph: string, cells: number): string {
  if (cells <= 0) return '';
  const unit = measureTextCells(glyph).cells === 1 ? glyph : '-';
  return unit.repeat(cells);
}

function layoutHeading(
  block: Extract<MarkdownBlockNode, { readonly kind: 'heading' }>,
  width: number,
  context: LayoutContext
): readonly RenderLine[] {
  const headingStyle = HEADING_STYLES[block.depth - 1] ?? HEADING_STYLES[0] ?? STYLE_STRONG;
  const lines = [...inlineLines(block.children, width, context, headingStyle)];
  if (block.depth <= 2) {
    const measured = Math.max(3, ...lines.map((line) => measureRenderSpans(line.spans, { widthProfile: context.widthProfile })));
    const glyph = block.depth === 1
      ? (context.symbols.mode === 'unicode' ? '━' : '=')
      : (context.symbols.mode === 'unicode' ? '─' : '-');
    lines.push(textLine([renderSpan(repeatGlyph(glyph, Math.min(width, measured)), mergeTerminalStyles(headingStyle, { dim: block.depth === 2 }))]));
  }
  return lines;
}

function wrapLiteralLine(
  value: string,
  width: number,
  context: LayoutContext,
  lineStyle: TerminalStyle
): readonly RenderLine[] {
  const safeWidth = Math.max(1, width);
  const lines: RenderLine[] = [];
  let graphemes: StyledGrapheme[] = [];
  let cells = 0;
  const flush = (): void => {
    lines.push(textLine(graphemesToSpans(graphemes)));
    graphemes = [];
    cells = 0;
  };

  for (const grapheme of measureTextCells(value, { widthProfile: context.widthProfile }).graphemes) {
    if (graphemes.length > 0 && cells + grapheme.cells > safeWidth) flush();
    graphemes.push({ text: grapheme.text, cells: grapheme.cells, style: lineStyle });
    cells += grapheme.cells;
  }
  if (graphemes.length > 0 || lines.length === 0) flush();
  return lines;
}

function insetLine(
  spans: readonly RenderSpan[],
  width: number,
  context: LayoutContext,
  background: TerminalStyle,
  pad = 1
): RenderLine {
  const innerWidth = Math.max(0, width - pad * 2);
  const clipped = clipRenderSpans(mapSpanStyle(spans, background), innerWidth, {
    widthProfile: context.widthProfile,
    ellipsis: '…'
  });
  const padded = padRenderLine(textLine([
    renderSpan(' '.repeat(pad), background),
    ...clipped
  ]), width, {
    widthProfile: context.widthProfile,
    fill: renderSpan(' ', background)
  });
  return padded;
}

function layoutCode(
  block: Extract<MarkdownBlockNode, { readonly kind: 'codeBlock' }>,
  width: number,
  context: LayoutContext
): readonly RenderLine[] {
  const lines: RenderLine[] = [];
  const pad = width >= 3 ? 1 : 0;
  const innerWidth = Math.max(1, width - pad * 2);
  if (block.language !== null) {
    lines.push(insetLine([renderSpan(block.language.toUpperCase(), STYLE_CODE_LABEL)], width, context, STYLE_CODE_LABEL));
  }

  const code = safeText(block.value);
  const codeLines = code.length === 0 ? [''] : code.split('\n');
  for (const codeLine of codeLines) {
    const wrapped = wrapLiteralLine(codeLine, innerWidth, context, STYLE_CODE);
    for (const line of wrapped) {
      lines.push(insetLine(line.spans, width, context, STYLE_CODE, pad));
    }
  }
  return lines;
}

function prefixLines(
  lines: readonly RenderLine[],
  firstPrefix: readonly RenderSpan[],
  continuationPrefix: readonly RenderSpan[] = firstPrefix
): readonly RenderLine[] {
  const source = lines.length === 0 ? [emptyLine()] : lines;
  return source.map((line, index) => textLine([
    ...(index === 0 ? firstPrefix : continuationPrefix),
    ...line.spans
  ]));
}

function layoutBlockquote(
  block: Extract<MarkdownBlockNode, { readonly kind: 'blockQuote' }>,
  width: number,
  context: LayoutContext
): readonly RenderLine[] {
  const guide = context.symbols.mode === 'unicode' ? '│ ' : '| ';
  const guideWidth = measureTextCells(guide, { widthProfile: context.widthProfile }).cells;
  const innerWidth = Math.max(1, width - guideWidth);
  const inner = layoutBlockSequence(block.children, innerWidth, context, 1);
  return prefixLines(inner, [renderSpan(guide, mergeTerminalStyles(STYLE_BORDER, STYLE_ACCENT))]);
}

function listMarker(
  ordered: boolean,
  number: number,
  orderDigits: number,
  item: MarkdownListItemNode,
  context: LayoutContext
): readonly RenderSpan[] {
  const bullet = context.symbols.mode === 'unicode' ? '•' : '-';
  const base = ordered ? `${String(number).padStart(orderDigits, ' ')}. ` : `${bullet} `;
  const spans: RenderSpan[] = [renderSpan(base, mergeTerminalStyles(STYLE_ACCENT, { bold: true }))];
  if (item.task !== null) {
    const checked = item.task.checked;
    const glyph = checked ? context.symbols.checkboxChecked : context.symbols.checkboxUnchecked;
    spans.push(renderSpan(`${glyph} `, checked ? STYLE_CHECKED : STYLE_UNCHECKED));
  }
  return spans;
}

function layoutList(
  block: Extract<MarkdownBlockNode, { readonly kind: 'list' }>,
  width: number,
  context: LayoutContext
): readonly RenderLine[] {
  if (block.items.length === 0) return [];
  const start = block.start ?? 1;
  const finalNumber = start + block.items.length - 1;
  const orderDigits = String(finalNumber).length;
  const markers = block.items.map((item, index) => listMarker(block.ordered, start + index, orderDigits, item, context));
  const lines: RenderLine[] = [];

  for (let index = 0; index < block.items.length; index += 1) {
    const item = block.items[index];
    if (item === undefined) continue;
    const marker = markers[index] ?? [];
    const markerWidth = Math.max(1, measureRenderSpans(marker, { widthProfile: context.widthProfile }));
    const contentWidth = Math.max(1, width - markerWidth);
    const continuation = [renderSpan(' '.repeat(markerWidth))];
    const loose = item.spread || !block.tight;
    const itemLines = layoutBlockSequence(item.children, contentWidth, context, loose ? 1 : 0);
    lines.push(...prefixLines(itemLines, marker, continuation));
    if (index < block.items.length - 1 && loose) lines.push(emptyLine());
  }
  return lines;
}

function cellSpans(cell: MarkdownTableCellNode | undefined): readonly RenderSpan[] {
  return inlineToSpans(cell?.children ?? []).map((span) => ({
    ...span,
    text: span.text.replace(/\s+/gu, ' ')
  }));
}

function tableAlignment(value: MarkdownTableAlignment | undefined): 'start' | 'center' | 'end' {
  if (value === 'center') return 'center';
  if (value === 'right') return 'end';
  return 'start';
}

function allocateColumnWidths(
  natural: readonly number[],
  minimums: readonly number[],
  available: number
): readonly number[] {
  const count = natural.length;
  if (count === 0) return [];
  const widths = natural.map((value, index) => Math.max(minimums[index] ?? 1, Math.min(32, value)));
  let total = widths.reduce((sum, value) => sum + value, 0);

  while (total > available) {
    let candidate = -1;
    for (let index = 0; index < widths.length; index += 1) {
      if ((widths[index] ?? 1) <= (minimums[index] ?? 1)) continue;
      if (candidate < 0 || (widths[index] ?? 0) > (widths[candidate] ?? 0)) candidate = index;
    }
    if (candidate < 0) break;
    widths[candidate] = (widths[candidate] ?? 1) - 1;
    total -= 1;
  }
  return widths;
}

function tableCharacters(context: LayoutContext) {
  return context.symbols.mode === 'unicode'
    ? {
      vertical: '│', horizontal: '─',
      topLeft: '┌', topJoin: '┬', topRight: '┐',
      middleLeft: '├', middleJoin: '┼', middleRight: '┤',
      bottomLeft: '└', bottomJoin: '┴', bottomRight: '┘'
    }
    : {
      vertical: '|', horizontal: '-',
      topLeft: '+', topJoin: '+', topRight: '+',
      middleLeft: '+', middleJoin: '+', middleRight: '+',
      bottomLeft: '+', bottomJoin: '+', bottomRight: '+'
    };
}

function tableRuleLine(
  widths: readonly number[],
  kind: 'top' | 'middle' | 'bottom',
  context: LayoutContext
): RenderLine {
  const characters = tableCharacters(context);
  const left = kind === 'top' ? characters.topLeft : kind === 'middle' ? characters.middleLeft : characters.bottomLeft;
  const join = kind === 'top' ? characters.topJoin : kind === 'middle' ? characters.middleJoin : characters.bottomJoin;
  const right = kind === 'top' ? characters.topRight : kind === 'middle' ? characters.middleRight : characters.bottomRight;
  const text = `${left}${widths.map((width) => characters.horizontal.repeat(width + 2)).join(join)}${right}`;
  return textLine([renderSpan(text, STYLE_BORDER)]);
}

function tableDataLine(
  cells: readonly (readonly RenderSpan[])[],
  widths: readonly number[],
  align: readonly MarkdownTableAlignment[],
  header: boolean,
  context: LayoutContext
): RenderLine {
  const characters = tableCharacters(context);
  const spans: RenderSpan[] = [renderSpan(characters.vertical, STYLE_BORDER)];
  for (let index = 0; index < widths.length; index += 1) {
    const width = widths[index] ?? 1;
    const source = cells[index] ?? [];
    const styled = header ? mapSpanStyle(source, STYLE_TABLE_HEADER) : source;
    const clipped = clipRenderSpans(styled, width, {
      widthProfile: context.widthProfile,
      ellipsis: '…'
    });
    const padded = padRenderLine(textLine(clipped), width, {
      widthProfile: context.widthProfile,
      align: tableAlignment(align[index])
    });
    spans.push(renderSpan(' '), ...padded.spans, renderSpan(' '), renderSpan(characters.vertical, STYLE_BORDER));
  }
  return textLine(spans);
}

function inlineText(content: readonly MarkdownInlineNode[]): string {
  return content.map((inline) => {
    switch (inline.kind) {
      case 'text':
      case 'escape':
      case 'characterReference':
      case 'codeSpan':
        return safeText(inline.value);
      case 'strong':
      case 'emphasis':
      case 'strikethrough':
      case 'link':
        return inlineText(inline.children);
      case 'image':
        return inlineText(inline.children) || 'Image';
      case 'softBreak':
      case 'hardBreak':
        return ' ';
      case 'htmlInline':
        return htmlLabel(safeText(inline.value), false);
      case 'footnoteReference':
        return `[^${safeText(inline.label)}]`;
    }
  }).join('').replace(/\s+/gu, ' ').trim();
}

function accessibleInlineNodes(
  content: readonly MarkdownInlineNode[],
  idPrefix: string
): readonly AccessibleNode[] {
  const nodes: AccessibleNode[] = [];
  for (const inline of content) {
    const id = `${idPrefix}:node:${String(inline.id)}`;
    switch (inline.kind) {
      case 'text':
      case 'escape':
      case 'characterReference': {
        const value = safeText(inline.value);
        if (value.length > 0) nodes.push({ id, role: 'text', value });
        break;
      }
      case 'codeSpan':
        nodes.push({ id, role: 'text', label: 'Inline code', value: safeText(inline.value) });
        break;
      case 'strong':
      case 'emphasis':
      case 'strikethrough':
        nodes.push(...accessibleInlineNodes(inline.children, id));
        break;
      case 'link': {
        const destination = safeHref(inline.destination);
        nodes.push({
          id,
          role: 'link',
          label: inlineText(inline.children) || destination,
          description: `Destination: ${destination}`
        });
        break;
      }
      case 'image': {
        const destination = safeHref(inline.destination);
        nodes.push({
          id,
          role: 'image',
          label: inlineText(inline.children) || 'Image',
          ...(destination.length === 0 ? {} : { description: `Destination: ${destination}` })
        });
        break;
      }
      case 'softBreak':
        nodes.push({ id, role: 'text', value: ' ' });
        break;
      case 'hardBreak':
        nodes.push({ id, role: 'text', value: '\n' });
        break;
      case 'htmlInline':
        nodes.push({
          id,
          role: 'text',
          label: 'HTML not rendered',
          value: htmlLabel(safeText(inline.value), false)
        });
        break;
      case 'footnoteReference':
        nodes.push({ id, role: 'text', label: 'Footnote reference', value: safeText(inline.label) });
        break;
    }
  }
  return nodes;
}

function accessibleBlockNodes(
  blocks: readonly MarkdownBlockNode[],
  idPrefix: string
): readonly AccessibleNode[] {
  const nodes: AccessibleNode[] = [];
  for (const block of blocks) {
    const id = `${idPrefix}:node:${String(block.id)}`;
    switch (block.kind) {
      case 'heading':
        nodes.push({
          id,
          role: 'heading',
          label: inlineText(block.children),
          position: { level: block.depth }
        });
        break;
      case 'paragraph':
        nodes.push({ id, role: 'group', children: accessibleInlineNodes(block.children, id) });
        break;
      case 'blockQuote':
        nodes.push({
          id,
          role: 'group',
          label: 'Block quote',
          children: accessibleBlockNodes(block.children, id)
        });
        break;
      case 'list':
        nodes.push({
          id,
          role: 'list',
          label: block.ordered ? 'Ordered list' : 'Unordered list',
          children: block.items.map((item, itemIndex): AccessibleNode => {
            const itemId = `${id}:node:${String(item.id)}`;
            return {
              id: itemId,
              role: 'listitem',
              position: { positionInSet: itemIndex + 1, setSize: block.items.length },
              children: [
                ...(item.task !== null
                  ? [{
                      id: `${itemId}:task`,
                      role: 'checkbox' as const,
                      label: 'Task',
                      checked: item.task.checked,
                      readOnly: true
                    }]
                  : []),
                ...accessibleBlockNodes(item.children, itemId)
              ]
            };
          })
        });
        break;
      case 'codeBlock':
        nodes.push({
          id,
          role: 'group',
          label: block.language === null ? 'Code block' : `Code block, ${safeText(block.language)}`,
          children: [{ id: `${id}:text`, role: 'text', value: safeText(block.value) }]
        });
        break;
      case 'table': {
        const rows = [block.header, ...block.rows];
        nodes.push({
          id,
          role: 'table',
          label: 'Markdown table',
          children: rows.map((row, rowIndex): AccessibleNode => ({
            id: `${id}:node:${String(row.id)}`,
            role: 'row',
            position: { rowIndex: rowIndex + 1, rowCount: rows.length },
            children: row.cells.map((cell, columnIndex): AccessibleNode => ({
              id: `${id}:node:${String(cell.id)}`,
              role: rowIndex === 0 ? 'columnheader' : 'cell',
              value: inlineText(cell.children),
              position: { columnIndex: columnIndex + 1, columnCount: row.cells.length }
            }))
          }))
        });
        break;
      }
      case 'thematicBreak':
        nodes.push({ id, role: 'separator', orientation: 'horizontal' });
        break;
      case 'htmlBlock':
        nodes.push({
          id,
          role: 'text',
          label: 'HTML not rendered',
          value: htmlLabel(safeText(block.value), true)
        });
        break;
      case 'linkDefinition':
        break;
      case 'footnoteDefinition':
        if (!block.active) break;
        nodes.push({
          id,
          role: 'group',
          label: `Footnote ${safeText(block.label)}`,
          children: accessibleBlockNodes(block.children, id)
        });
        break;
    }
  }
  return nodes;
}

function wrapWithHangingPrefix(
  prefix: readonly RenderSpan[],
  value: readonly RenderSpan[],
  width: number,
  context: LayoutContext
): readonly RenderLine[] {
  const prefixWidth = Math.min(
    Math.max(1, Math.floor(width * 0.45)),
    measureRenderSpans(prefix, { widthProfile: context.widthProfile })
  );
  const clippedPrefix = clipRenderSpans(prefix, prefixWidth, {
    widthProfile: context.widthProfile,
    ellipsis: '…'
  });
  const actualPrefixWidth = measureRenderSpans(clippedPrefix, { widthProfile: context.widthProfile });
  const availableFirst = Math.max(1, width - actualPrefixWidth);
  const valueLines = wrapSpansAtWords(value.length === 0 ? [renderSpan('—', STYLE_MUTED)] : value, availableFirst, context);
  const first = valueLines[0] ?? emptyLine();
  const result: RenderLine[] = [textLine([...clippedPrefix, ...first.spans])];
  const continuationWidth = Math.max(1, width - actualPrefixWidth);
  for (const line of valueLines.slice(1)) {
    const wrapped = wrapSpansAtWords(line.spans, continuationWidth, context);
    for (const continuation of wrapped) {
      result.push(textLine([renderSpan(' '.repeat(actualPrefixWidth)), ...continuation.spans]));
    }
  }
  return result;
}

function layoutStackedTable(
  block: Extract<MarkdownBlockNode, { readonly kind: 'table' }>,
  width: number,
  context: LayoutContext
): readonly RenderLine[] {
  const columnCount = Math.max(block.header.cells.length, ...block.rows.map((row) => row.cells.length), 0);
  const labels = Array.from({ length: columnCount }, (_, index) => {
    const label = inlineText(block.header.cells[index]?.children ?? []);
    return label.length > 0 ? label : `Column ${String(index + 1)}`;
  });
  const rows = block.rows.length > 0 ? block.rows : [block.header];
  const lines: RenderLine[] = [];

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    if (row === undefined) continue;
    if (block.rows.length > 0) {
      lines.push(textLine([renderSpan(`Row ${String(rowIndex + 1)}`, STYLE_TABLE_HEADER)]));
    }
    for (let column = 0; column < columnCount; column += 1) {
      const prefix = [renderSpan(`${labels[column] ?? `Column ${String(column + 1)}`}: `, STYLE_STRONG)];
      lines.push(...wrapWithHangingPrefix(prefix, cellSpans(row.cells[column]), width, context));
    }
    if (rowIndex < rows.length - 1) lines.push(emptyLine());
  }
  return lines;
}

function layoutTable(
  block: Extract<MarkdownBlockNode, { readonly kind: 'table' }>,
  width: number,
  context: LayoutContext
): readonly RenderLine[] {
  const columnCount = Math.max(block.header.cells.length, ...block.rows.map((row) => row.cells.length), 0);
  if (columnCount === 0) return [];
  const overhead = columnCount * 3 + 1;

  const header = Array.from({ length: columnCount }, (_, index) => cellSpans(block.header.cells[index]));
  const rows = block.rows.map((row) => Array.from({ length: columnCount }, (_, index) => cellSpans(row.cells[index])));
  const natural = Array.from({ length: columnCount }, (_, index) => Math.max(
    1,
    measureRenderSpans(header[index] ?? [], { widthProfile: context.widthProfile }),
    ...rows.map((row) => measureRenderSpans(row[index] ?? [], { widthProfile: context.widthProfile }))
  ));
  const minimums = natural.map((value) => Math.max(1, Math.min(8, value)));
  if (minimums.reduce((sum, value) => sum + value, overhead) > width) {
    return layoutStackedTable(block, width, context);
  }
  const widths = allocateColumnWidths(natural, minimums, width - overhead);
  if (widths.reduce((sum, value) => sum + value, 0) + overhead > width) {
    return layoutStackedTable(block, width, context);
  }

  const lines: RenderLine[] = [tableRuleLine(widths, 'top', context)];
  lines.push(tableDataLine(header, widths, block.align, true, context));
  lines.push(tableRuleLine(widths, 'middle', context));
  for (const row of rows) lines.push(tableDataLine(row, widths, block.align, false, context));
  lines.push(tableRuleLine(widths, 'bottom', context));
  return lines;
}

function layoutImage(
  image: Extract<MarkdownInlineNode, { readonly kind: 'image' }>,
  width: number,
  context: LayoutContext
): readonly RenderLine[] {
  const imageLabel = inlineText(image.children) || 'Untitled image';
  const imageLine = insetLine([
    renderSpan('IMAGE  ', mergeTerminalStyles(STYLE_ACCENT, { bold: true })),
    renderSpan(imageLabel, STYLE_STRONG)
  ], width, context, { bg: themeColor('surface.inset.background') });
  const href = safeHref(image.destination);
  const destination = href.length > 0 ? href : '(no destination)';
  const destinationLine = insetLine([
    renderSpan(context.symbols.mode === 'unicode' ? '↳ ' : '-> ', STYLE_MUTED),
    renderSpan(destination, href.length > 0 ? STYLE_LINK : STYLE_MUTED, href.length > 0 ? { href } : undefined)
  ], width, context, { bg: themeColor('surface.inset.background') });
  return [imageLine, destinationLine];
}

function layoutHtml(
  block: Extract<MarkdownBlockNode, { readonly kind: 'htmlBlock' }>,
  width: number,
  context: LayoutContext
): readonly RenderLine[] {
  return [insetLine([
    renderSpan(`HTML not rendered · ${htmlLabel(safeText(block.value), true)}`, STYLE_HTML)
  ], width, context, STYLE_HTML)];
}

function paragraphImage(
  block: Extract<MarkdownBlockNode, { readonly kind: 'paragraph' }>
): Extract<MarkdownInlineNode, { readonly kind: 'image' }> | undefined {
  const meaningful = block.children.filter((inline) => (
    inline.kind !== 'text' || safeText(inline.value).trim().length > 0
  ));
  const only = meaningful[0];
  return meaningful.length === 1 && only?.kind === 'image' ? only : undefined;
}

function tagBlockLines(
  lines: readonly MarkdownLayoutLine[],
  block: MarkdownBlockNode
): readonly MarkdownLayoutLine[] {
  return lines.map((line) => ({
    ...line,
    nodeId: line.nodeId ?? block.id,
    sourceSpan: line.sourceSpan ?? block.span
  }));
}

function shiftCachedLines(
  lines: readonly MarkdownLayoutLine[],
  offset: number
): readonly MarkdownLayoutLine[] {
  if (offset === 0) return lines;
  return lines.map((line) => ({
    ...line,
    ...(line.sourceSpan === undefined
      ? {}
      : {
          sourceSpan: {
            start: line.sourceSpan.start + offset,
            end: line.sourceSpan.end + offset
          }
        })
  }));
}

function blockLayoutCacheKey(block: MarkdownBlockNode, width: number, context: LayoutContext): string {
  return [
    block.id,
    width,
    textWidthProfileKey(context.widthProfile),
    context.symbols.mode,
    context.symbols.checkboxChecked,
    context.symbols.checkboxUnchecked
  ].join('|');
}

function layoutBlockUncached(
  block: MarkdownBlockNode,
  width: number,
  context: LayoutContext
): readonly MarkdownLayoutLine[] {
  switch (block.kind) {
    case 'heading':
      return layoutHeading(block, width, context);
    case 'paragraph': {
      const image = paragraphImage(block);
      return image === undefined
        ? inlineLines(block.children, width, context)
        : layoutImage(image, width, context);
    }
    case 'blockQuote':
      return layoutBlockquote(block, width, context);
    case 'list':
      return layoutList(block, width, context);
    case 'codeBlock':
      return layoutCode(block, width, context);
    case 'table':
      return layoutTable(block, width, context);
    case 'thematicBreak': {
      const glyph = context.symbols.mode === 'unicode' ? '─' : '-';
      return [textLine([renderSpan(repeatGlyph(glyph, width), STYLE_RULE)])];
    }
    case 'htmlBlock':
      return layoutHtml(block, width, context);
    case 'linkDefinition':
      return [];
    case 'footnoteDefinition': {
      if (!block.active) return [];
      const label = textLine([renderSpan(`Footnote ${safeText(block.label)}`, STYLE_STRONG)]);
      return [label, ...layoutBlockSequence(block.children, width, context, 1)];
    }
  }
}

function layoutBlock(block: MarkdownBlockNode, width: number, context: LayoutContext): readonly MarkdownLayoutLine[] {
  const key = blockLayoutCacheKey(block, width, context);
  const cached = context.blockCache.get(key);
  if (cached !== undefined && cached.kind === block.kind) {
    context.blockCache.delete(key);
    context.blockCache.set(key, cached);
    return shiftCachedLines(cached.lines, block.span.start - cached.spanStart);
  }
  const lines = tagBlockLines(layoutBlockUncached(block, width, context), block);
  context.blockCache.set(key, Object.freeze({ kind: block.kind, spanStart: block.span.start, lines }));
  while (context.blockCache.size > BLOCK_LAYOUT_CACHE_LIMIT) {
    const oldest = context.blockCache.keys().next().value;
    if (oldest === undefined) break;
    context.blockCache.delete(oldest);
  }
  return lines;
}

function layoutBlockSequence(
  blocks: readonly MarkdownBlockNode[],
  width: number,
  context: LayoutContext,
  gapRows: number
): readonly MarkdownLayoutLine[] {
  const lines: MarkdownLayoutLine[] = [];
  const visible = blocks.map((block) => layoutBlock(block, width, context)).filter((blockLines) => blockLines.length > 0);
  for (let index = 0; index < visible.length; index += 1) {
    lines.push(...(visible[index] ?? []));
    if (index < visible.length - 1) {
      for (let gap = 0; gap < gapRows; gap += 1) lines.push(emptyLine());
    }
  }
  return lines;
}

function emptyPreview(width: number, context: LayoutContext): readonly MarkdownLayoutLine[] {
  const title = wrapSpansAtWords([renderSpan('Nothing to preview', STYLE_STRONG)], width, context);
  const hint = wrapSpansAtWords([renderSpan('Write Markdown in the source pane.', STYLE_MUTED)], width, context);
  return [...title, ...hint];
}

function failedPreview(
  preview: Exclude<MarkdownPreview, ReadyMarkdownPreview>,
  width: number,
  context: LayoutContext
): readonly MarkdownLayoutLine[] {
  const title = wrapSpansAtWords([renderSpan('Preview unavailable', STYLE_STRONG)], width, context);
  const message = wrapSpansAtWords([renderSpan(safeText(preview.message), STYLE_HTML)], width, context);
  return [...title, ...message];
}

function layoutCacheKey(
  preview: MarkdownPreview,
  width: number,
  maxContentWidth: number,
  minHorizontalPadding: number,
  context: LayoutContext
): string {
  const symbols = context.symbols;
  return [
    preview.kind,
    preview.sourceRevision,
    width,
    maxContentWidth,
    minHorizontalPadding,
    textWidthProfileKey(context.widthProfile),
    symbols.mode,
    symbols.checkboxChecked,
    symbols.checkboxUnchecked
  ].join('|');
}

export function layoutMarkdownDocument(
  preview: MarkdownPreview,
  options: MarkdownLayoutOptions
): MarkdownLayoutResult {
  const width = Math.max(1, Math.min(4096, Math.floor(options.width)));
  const maxContentWidth = Math.max(20, Math.min(160, Math.floor(options.maxContentWidth ?? 88)));
  const minHorizontalPadding = Math.max(0, Math.min(12, Math.floor(options.minHorizontalPadding ?? 2)));
  const blocks = blockLayoutCache.get(preview.identity) ?? new Map<string, CachedBlockLayout>();
  if (!blockLayoutCache.has(preview.identity)) blockLayoutCache.set(preview.identity, blocks);
  const context: LayoutContext = {
    widthProfile: options.widthProfile ?? defaultTextWidthProfile,
    symbols: options.symbols ?? unicodeSymbols,
    blockCache: blocks
  };
  const key = layoutCacheKey(preview, width, maxContentWidth, minHorizontalPadding, context);
  const cache = layoutCache.get(preview.identity);
  const cached = cache?.get(key);
  if (cached !== undefined) {
    cache?.delete(key);
    cache?.set(key, cached);
    return cached;
  }

  const usable = Math.max(1, width - minHorizontalPadding * 2);
  const contentWidth = Math.max(1, Math.min(maxContentWidth, usable));
  const leftPadding = Math.max(0, Math.floor((width - contentWidth) / 2));
  const rawLines = preview.kind === 'failed'
    ? failedPreview(preview, contentWidth, context)
    : preview.snapshot.document.tree.children.length === 0
      ? emptyPreview(contentWidth, context)
      : layoutBlockSequence(preview.snapshot.document.tree.children, contentWidth, context, 1);
  const lines = rawLines.map((line): MarkdownLayoutLine => ({
    ...line,
    spans: compactRenderSpans([
      ...(leftPadding === 0 ? [] : [renderSpan(' '.repeat(leftPadding))]),
      ...line.spans
    ])
  }));
  const result: MarkdownLayoutResult = Object.freeze({
    lines: Object.freeze(lines.length === 0 ? [emptyLine()] : lines),
    width,
    contentWidth,
    leftPadding
  });
  const target = cache ?? new Map<string, MarkdownLayoutResult>();
  target.set(key, result);
  while (target.size > LAYOUT_CACHE_LIMIT) {
    const oldest = target.keys().next().value;
    if (oldest === undefined) break;
    target.delete(oldest);
  }
  if (cache === undefined) layoutCache.set(preview.identity, target);
  return result;
}

export function markdownLayoutSourceOffsets(
  layout: MarkdownLayoutResult
): readonly number[] {
  let previous = 0;
  return Object.freeze(layout.lines.map((line) => {
    if (line.sourceSpan !== undefined) previous = line.sourceSpan.start;
    return previous;
  }));
}

export function markdownLayoutPlainText(layout: MarkdownLayoutResult): string {
  return layout.lines.map((line) => line.spans.map((span) => span.text).join('')).join('\n');
}

export const markdownDocument = defineComponent<
  MarkdownDocumentComponentOptions,
  PreparedMarkdownDocumentComponentOptions,
  MarkdownDocumentAction,
  never,
  readonly [],
  'required',
  readonly ['focus']
>({
  name: 'vellum/components/markdown-document',
  identity: 'required',
  metadata: ['focus'],
  structure: 'leaf',
  semantics: 'semantic',
  accessibleRole: 'document',
  prepare(value) {
    if (value.document === null || typeof value.document !== 'object') {
      throw new TypeError('markdownDocument requires a parsed Markdown document.');
    }
    return {
      document: value.document,
      maxContentWidth: normalizeBoundedInteger(
        value.maxContentWidth,
        88,
        20,
        160,
        'markdownDocument maxContentWidth'
      ),
      minHorizontalPadding: normalizeBoundedInteger(
        value.minHorizontalPadding,
        2,
        0,
        12,
        'markdownDocument minHorizontalPadding'
      ),
      pageRows: normalizeBoundedInteger(
        value.pageRows,
        10,
        1,
        Number.MAX_SAFE_INTEGER,
        'markdownDocument pageRows'
      ),
      contentRows: normalizeBoundedInteger(
        value.contentRows,
        1,
        1,
        Number.MAX_SAFE_INTEGER,
        'markdownDocument contentRows'
      )
    };
  },
  keys({ model }) {
    const action = (command: MarkdownPreviewCommand): MarkdownDocumentAction => ({
      kind: 'scroll',
      command,
      pageRows: model.pageRows,
      contentRows: model.contentRows
    });
    return {
      arrowUp: () => action('lineUp'),
      arrowDown: () => action('lineDown'),
      pageUp: () => action('pageUp'),
      pageDown: () => action('pageDown'),
      home: () => action('top'),
      end: () => action('bottom')
    };
  },
  focusTargets: ({ bounds }) => [{ id: 'self', bounds }],
  measure({ model, constraints, widthProfile, theme: terminalTheme }) {
    const width = Math.max(1, Math.min(4096, Math.floor(constraints.width)));
    const layout = layoutMarkdownDocument(model.document, {
      width,
      widthProfile,
      symbols: terminalTheme.tokens.symbols,
      maxContentWidth: model.maxContentWidth,
      minHorizontalPadding: model.minHorizontalPadding
    });
    return {
      minWidth: 1,
      minHeight: 1,
      preferredWidth: width,
      preferredHeight: Math.max(1, layout.lines.length)
    };
  },
  render({ model, bounds, viewport, target, widthProfile, theme: terminalTheme, source }) {
    if (bounds.width <= 0 || bounds.height <= 0) return;
    const layout = layoutMarkdownDocument(model.document, {
      width: bounds.width,
      widthProfile,
      symbols: terminalTheme.tokens.symbols,
      maxContentWidth: model.maxContentWidth,
      minHorizontalPadding: model.minHorizontalPadding
    });
    const startRow = Math.max(0, viewport.row);
    const endRow = Math.min(
      bounds.height,
      layout.lines.length,
      viewport.row + viewport.height
    );
    for (let row = startRow; row < endRow; row += 1) {
      const line = layout.lines[row] ?? emptyLine();
      target.writeLine(row, 0, {
        spans: line.spans.map((span, index) => ({
          ...span,
          source: source({
            cellRole: 'text',
            partName: 'markdown',
            itemIndex: row,
            description: line.nodeId === undefined || line.sourceSpan === undefined
              ? `markdown.line.${String(row)}.span.${String(index)}`
              : `markdown.node.${String(line.nodeId)}.source.${String(line.sourceSpan.start)}-${String(line.sourceSpan.end)}.line.${String(row)}.span.${String(index)}`
          })
        }))
      });
    }
  },
  accessibility({ id, model, focused }) {
    const preview = model.document;
    return {
      id,
      role: 'document',
      label: 'Markdown preview',
      ...(focused ? { focused: true } : {}),
      description: preview.kind === 'ready'
        ? `${String(preview.wordCount)} words`
        : `Preview unavailable: ${safeText(preview.message)}`,
      children: preview.kind === 'ready'
        ? accessibleBlockNodes(preview.snapshot.document.tree.children, id)
        : [{ id: `${id}:error`, role: 'text', value: safeText(preview.message) }]
    };
  }
});
