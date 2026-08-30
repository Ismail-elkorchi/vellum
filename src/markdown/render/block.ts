import type { MarkdownBlockNode, MarkdownListItemNode, SourceSpan } from 'markspan';
import { measureTextCells, type TextWidthProfile } from '@ismail-elkorchi/terminal-ui/text';
import type { MarkdownTheme } from '../theme.js';
import { renderCodeBlock } from './code.js';
import { renderInline, type MarkdownRenderSpan } from './inline.js';
import { renderTable } from './table.js';
import {
  blankMarkdownRow,
  shiftMarkdownRow,
  wrapMarkdownPreformattedSpans,
  wrapMarkdownSpans,
  type MarkdownLayoutRow,
} from './wrap.js';
import type { MarkdownBlockResources } from './resources.js';
import { frontMatterPreviewRows } from './front-matter.js';

export interface MarkdownRenderedBlock {
  readonly nodeId: number;
  readonly kind: MarkdownBlockNode['kind'];
  readonly sourceSpan: SourceSpan;
  readonly rows: readonly MarkdownLayoutRow[];
}

export function renderMarkdownBlock(
  node: MarkdownBlockNode,
  width: number,
  theme: MarkdownTheme,
  widthProfile: TextWidthProfile,
  resources: MarkdownBlockResources = {}
): MarkdownRenderedBlock {
  const maximum = Math.max(1, Math.floor(width));
  let rows: readonly MarkdownLayoutRow[];
  switch (node.kind) {
    case 'paragraph':
      rows = wrapMarkdownSpans(
        renderInline(node.children, theme, theme.body, undefined, resources),
        maximum,
        widthProfile,
      );
      break;
    case 'heading':
      const headingStyle = theme.headings[node.depth - 1] ?? theme.body;
      rows = wrapMarkdownSpans(
        renderInline(node.children, theme, headingStyle, undefined, resources),
        maximum,
        widthProfile,
      );
      break;
    case 'codeBlock': {
      const diagram = resources.diagramText?.get(node.id);
      const image = resources.images?.get(node.id);
      const spans = diagram !== undefined && image?.kind === 'ready'
        ? [Object.freeze({
            text: '',
            nodeId: node.id,
            sourceSpan: node.contentSpan,
            sourceMapping: 'anchor',
            media: Object.freeze({
              image: image.image,
              label: 'Mermaid diagram',
              sourceSpan: node.contentSpan,
            }),
          })]
        : diagram === undefined
          ? renderCodeBlock(node, theme, resources.highlightedCode?.get(node.id))
          : [synthetic(diagram, node.id, node.contentSpan, theme.diagramFailure)];
      rows = decorateCodeRows(
        wrapMarkdownPreformattedSpans(
          spans,
          Math.max(1, maximum - codeGutter(maximum).width),
          widthProfile,
        ),
        node,
        maximum,
        theme,
      );
      break;
    }
    case 'mathBlock': {
      const text = resources.mathText?.get(node.id) ?? `Math: ${node.value}`;
      rows = wrapMarkdownPreformattedSpans(
        [synthetic(text, node.id, node.contentSpan, theme.math)],
        maximum,
        widthProfile,
      );
      break;
    }
    case 'table':
      rows = renderTable(node, maximum, theme, widthProfile, resources);
      break;
    case 'frontMatter': {
      const collected: MarkdownLayoutRow[] = [];
      const diagnostics = (resources.diagnostics?.filter((diagnostic) => (
        diagnostic.span.start <= node.span.end && diagnostic.span.end >= node.span.start
      )) ?? []).toSorted((left, right) => left.span.start - right.span.start);
      for (const diagnostic of diagnostics) {
        collected.push(...wrapMarkdownSpans([
          synthetic(
            `Front matter ${diagnostic.severity}: ${diagnostic.message}`,
            node.id,
            diagnostic.span,
            theme.diagnostics[diagnostic.severity],
          )
        ], maximum, widthProfile));
      }
      for (const entry of frontMatterPreviewRows(node.value)) {
        collected.push(...wrapMarkdownPreformattedSpans([
          synthetic(entry.text, node.id, entry.sourceSpan, theme.frontMatter)
        ], maximum, widthProfile));
      }
      if (collected.length === 0) {
        collected.push(...wrapMarkdownSpans([
          synthetic('Invalid front matter', node.id, node.span, theme.diagnostics['error'])
        ], maximum, widthProfile));
      }
      rows = Object.freeze(collected);
      break;
    }
    case 'callout': {
      const label = node.calloutKind.toUpperCase();
      const labelRows = wrapMarkdownSpans([
        synthetic(label, node.id, node.labelSpan, theme.callouts[node.calloutKind])
      ], maximum, widthProfile);
      const gutter = structuralGutter(maximum, node.id, node.markerSpans[0] ?? node.span, theme.callouts[node.calloutKind]);
      rows = Object.freeze([
        ...labelRows,
        ...prefixChildBlocks(
          node.children,
          maximum,
          theme,
          widthProfile,
          gutter,
          gutter,
          resources,
          true,
        ),
      ]);
      break;
    }
    case 'blockQuote': {
      const gutter = structuralGutter(maximum, node.id, node.markerSpans[0] ?? node.span, theme.blockquote);
      rows = prefixChildBlocks(
        node.children,
        maximum,
        theme,
        widthProfile,
        gutter,
        gutter,
        resources,
        true,
      );
      break;
    }
    case 'list':
      rows = renderList(node, maximum, theme, widthProfile, resources);
      break;
    case 'footnoteDefinition': {
      const requested = `[^${node.label}]: `;
      const prefixText = textWidth(requested, widthProfile) < maximum - 1
        ? requested
        : maximum >= 3 ? '† ' : maximum >= 2 ? '†' : '';
      const prefix = synthetic(prefixText, node.id, node.labelSpan, theme.link);
      rows = prefixChildBlocks(
        node.children,
        maximum,
        theme,
        widthProfile,
        prefix,
        synthetic(' '.repeat(textWidth(prefixText, widthProfile)), node.id, node.labelSpan, theme.body),
        resources,
        true,
      );
      break;
    }
    case 'thematicBreak': {
      const ruleWidth = measureTextCells('─', { widthProfile }).cells;
      const glyph = ruleWidth <= maximum ? '─' : '-';
      const repeats = Math.max(1, Math.floor(maximum / Math.min(maximum, ruleWidth)));
      rows = wrapMarkdownSpans(
        [synthetic(glyph.repeat(repeats), node.id, node.markerSpan, theme.tableBorder)],
        maximum,
        widthProfile,
      );
      break;
    }
    case 'htmlBlock':
      rows = wrapMarkdownSpans(
        [synthetic('[HTML block]', node.id, node.span, theme.htmlPlaceholder)],
        maximum,
        widthProfile,
      );
      break;
    case 'linkDefinition':
      rows = Object.freeze([]);
      break;
  }
  const first = rows[0];
  const anchoredRows = first === undefined || first.sourceOffset === node.span.start
    ? rows
    : Object.freeze([
      Object.freeze({ ...first, sourceOffset: node.span.start }),
      ...rows.slice(1)
    ]);
  return Object.freeze({ nodeId: node.id, kind: node.kind, sourceSpan: node.span, rows: anchoredRows });
}

function renderList(
  node: Extract<MarkdownBlockNode, { readonly kind: 'list' }>,
  width: number,
  theme: MarkdownTheme,
  widthProfile: TextWidthProfile,
  resources: MarkdownBlockResources,
): readonly MarkdownLayoutRow[] {
  const markers = node.items.map((item, index) => listMarker(node, item, index, theme));
  const markerWidth = Math.max(0, ...markers.map((marker) => textWidth(marker.text, widthProfile)));
  const compact = markerWidth + 1 >= width - 1;
  const effectiveMarkerWidth = compact ? Math.min(1, Math.max(0, width - 1)) : markerWidth;
  const rows: MarkdownLayoutRow[] = [];
  for (let index = 0; index < node.items.length; index += 1) {
    const item = node.items[index];
    const marker = markers[index];
    if (item === undefined || marker === undefined) continue;
    const prefixText = compact
      ? width <= 1 ? '' : width === 2 ? '›' : '› '
      : `${' '.repeat(Math.max(0, effectiveMarkerWidth - textWidth(marker.text, widthProfile)))}${marker.text} `;
    const prefix = synthetic(prefixText, item.id, item.task?.span ?? item.markerSpan, marker.style);
    const continuation = synthetic(
      ' '.repeat(textWidth(prefixText, widthProfile)),
      item.id,
      item.span,
      theme.body,
    );
    rows.push(...prefixChildBlocks(
      item.children,
      width,
      theme,
      widthProfile,
      prefix,
      continuation,
      resources,
      !node.tight || item.spread,
    ));
    if (!node.tight && index < node.items.length - 1) {
      rows.push(blankMarkdownRow(item.span.end, node.id));
    }
  }
  return Object.freeze(rows);
}

function listMarker(
  node: Extract<MarkdownBlockNode, { readonly kind: 'list' }>,
  item: MarkdownListItemNode,
  index: number,
  theme: MarkdownTheme,
): { readonly text: string; readonly style: MarkdownTheme['body'] } {
  if (item.task !== null) {
    return Object.freeze({
      text: item.task.checked ? '☑' : '☐',
      style: item.task.checked ? theme.checkedTask : theme.uncheckedTask,
    });
  }
  return Object.freeze({
    text: node.ordered
      ? `${String((node.start ?? 1) + index)}${node.delimiter ?? '.'}`
      : node.bullet ?? '-',
    style: theme.listMarker,
  });
}

function prefixChildBlocks(
  children: readonly MarkdownBlockNode[],
  width: number,
  theme: MarkdownTheme,
  widthProfile: TextWidthProfile,
  firstPrefix: MarkdownRenderSpan,
  continuationPrefix: MarkdownRenderSpan,
  resources: MarkdownBlockResources,
  separateChildren: boolean,
): readonly MarkdownLayoutRow[] {
  const prefixWidth = textWidth(firstPrefix.text, widthProfile);
  const continuationWidth = textWidth(continuationPrefix.text, widthProfile);
  if (prefixWidth !== continuationWidth) {
    throw new Error('Markdown container prefixes must occupy the same terminal width.');
  }
  const rows: MarkdownLayoutRow[] = [];
  let firstOutputRow = true;
  for (let childIndex = 0; childIndex < children.length; childIndex += 1) {
    const child = children[childIndex];
    if (child === undefined) continue;
    if (separateChildren && childIndex > 0) {
      rows.push(shiftMarkdownRow(
        blankMarkdownRow(child.span.start, child.id),
        continuationPrefix.text.length === 0 ? Object.freeze([]) : Object.freeze([continuationPrefix]),
        prefixWidth,
      ));
    }
    const rendered = renderMarkdownBlock(
      child,
      Math.max(1, width - prefixWidth),
      theme,
      widthProfile,
      resources,
    );
    for (const row of rendered.rows) {
      const leader = firstOutputRow ? firstPrefix : continuationPrefix;
      rows.push(shiftMarkdownRow(
        row,
        leader.text.length === 0 ? Object.freeze([]) : Object.freeze([leader]),
        prefixWidth,
      ));
      firstOutputRow = false;
    }
  }
  if (rows.length === 0) return wrapMarkdownSpans([firstPrefix], width, widthProfile);
  return Object.freeze(rows);
}

function decorateCodeRows(
  rows: readonly MarkdownLayoutRow[],
  node: Extract<MarkdownBlockNode, { readonly kind: 'codeBlock' }>,
  width: number,
  theme: MarkdownTheme,
): readonly MarkdownLayoutRow[] {
  const gutter = codeGutter(width);
  const prefix = synthetic(gutter.text, node.id, node.fence?.openingSpan ?? node.span, theme.codeBlock);
  return Object.freeze(rows.map((row) => Object.freeze({
    ...shiftMarkdownRow(
      row,
      gutter.width === 0 ? Object.freeze([]) : Object.freeze([prefix]),
      gutter.width,
    ),
    background: theme.codeBlock,
  })));
}

function codeGutter(width: number): { readonly text: string; readonly width: number } {
  if (width <= 1) return Object.freeze({ text: '', width: 0 });
  if (width === 2) return Object.freeze({ text: '│', width: 1 });
  return Object.freeze({ text: '│ ', width: 2 });
}

function structuralGutter(
  width: number,
  nodeId: number,
  sourceSpan: SourceSpan,
  style: MarkdownTheme['body'],
): MarkdownRenderSpan {
  const text = width <= 1 ? '' : width === 2 ? '│' : '│ ';
  return synthetic(text, nodeId, sourceSpan, style);
}

function textWidth(text: string, widthProfile: TextWidthProfile): number {
  return measureTextCells(text, { widthProfile }).cells;
}

function synthetic(
  text: string,
  nodeId: number,
  sourceSpan: SourceSpan,
  style: MarkdownTheme['body']
): MarkdownRenderSpan {
  return Object.freeze({ text, nodeId, sourceSpan, sourceMapping: 'anchor', style });
}
