import type { MarkdownBlockNode, SourceSpan } from 'markspan';
import { measureTextCells, type TextWidthProfile } from '@ismail-elkorchi/terminal-ui/text';
import type { MarkdownTheme } from '../theme.js';
import { renderCodeBlock } from './code.js';
import { renderInline, type MarkdownRenderSpan } from './inline.js';
import { renderTable } from './table.js';
import {
  wrapMarkdownPreformattedSpans,
  wrapMarkdownSpans,
  type MarkdownLayoutLine
} from './wrap.js';
import type { MarkdownBlockResources } from './resources.js';
import { frontMatterPreviewRows } from './front-matter.js';

export interface MarkdownRenderedBlock {
  readonly nodeId: number;
  readonly kind: MarkdownBlockNode['kind'];
  readonly sourceSpan: SourceSpan;
  readonly lines: readonly MarkdownLayoutLine[];
}

export function renderMarkdownBlock(
  node: MarkdownBlockNode,
  source: string,
  width: number,
  theme: MarkdownTheme,
  widthProfile: TextWidthProfile,
  resources: MarkdownBlockResources = {}
): MarkdownRenderedBlock {
  const maximum = Math.max(1, Math.floor(width));
  let lines: readonly MarkdownLayoutLine[];
  switch (node.kind) {
    case 'paragraph':
      lines = wrapMarkdownSpans(
        renderInline(node.children, theme, theme.body, undefined, resources),
        maximum,
        widthProfile,
      );
      break;
    case 'heading':
      lines = wrapMarkdownSpans(
        renderInline(node.children, theme, theme.headings[node.depth - 1], undefined, resources),
        maximum,
        widthProfile,
      );
      break;
    case 'codeBlock': {
      const diagram = resources.diagramText?.get(node.id);
      const spans = diagram === undefined
        ? renderCodeBlock(node, theme, resources.highlightedCode?.get(node.id))
        : [synthetic(diagram, node.id, node.contentSpan, theme.body)];
      lines = wrapMarkdownPreformattedSpans(spans, maximum, widthProfile);
      break;
    }
    case 'mathBlock': {
      const text = resources.mathText?.get(node.id) ?? `Math: ${node.value}`;
      lines = wrapMarkdownPreformattedSpans(
        [synthetic(text, node.id, node.contentSpan, theme.math)],
        maximum,
        widthProfile,
      );
      break;
    }
    case 'table':
      lines = Object.freeze(renderTable(node, maximum, theme, widthProfile, resources).map((row) => Object.freeze({
        spans: row.spans,
        inlineSpans: row.spans,
        sourceOffset: row.sourceOffset,
        nodeId: node.id
      })));
      break;
    case 'frontMatter': {
      const spans: MarkdownRenderSpan[] = [];
      const diagnostics = resources.diagnostics?.filter((diagnostic) => (
        diagnostic.span.start <= node.span.end && diagnostic.span.end >= node.span.start
      )) ?? [];
      for (const diagnostic of diagnostics) {
        spans.push(synthetic(
          `Front matter ${diagnostic.severity}: ${diagnostic.message}\n`,
          node.id,
          diagnostic.span,
          theme.diagnostics[diagnostic.severity]
        ));
      }
      for (const entry of frontMatterPreviewRows(node.value)) {
        spans.push(synthetic(`${entry.key}: `, node.id, entry.keySpan, theme.frontMatter));
        spans.push(synthetic(entry.value + '\n', node.id, entry.valueSpan, theme.frontMatter));
      }
      if (spans.length === 0) spans.push(synthetic('Invalid front matter', node.id, node.span, theme.diagnostics['error']));
      lines = wrapMarkdownSpans(spans, maximum, widthProfile);
      break;
    }
    case 'callout': {
      const label = node.calloutKind.toUpperCase();
      const prefix = synthetic(`${label}: `, node.id, node.labelSpan, theme.callouts[node.calloutKind]);
      lines = prefixChildBlocks(node.children, source, maximum, theme, widthProfile, prefix, resources);
      break;
    }
    case 'blockQuote':
      lines = prefixChildBlocks(
        node.children,
        source,
        maximum,
        theme,
        widthProfile,
        synthetic('│ ', node.id, node.markerSpans[0] ?? node.span, theme.blockquote),
        resources,
        true
      );
      break;
    case 'list': {
      const collected: MarkdownLayoutLine[] = [];
      for (let index = 0; index < node.items.length; index += 1) {
        const item = node.items[index];
        if (item === undefined) continue;
        const markerText = item.task === null
          ? node.ordered ? `${(node.start ?? 1) + index}${node.delimiter ?? '.'} ` : `${node.bullet ?? '-'} `
          : item.task.checked ? '☑ ' : '☐ ';
        const markerStyle = item.task === null ? theme.listMarker : item.task.checked ? theme.checkedTask : theme.uncheckedTask;
        const prefix = synthetic(markerText, item.id, item.task?.span ?? item.markerSpan, markerStyle);
        collected.push(...prefixChildBlocks(
          item.children,
          source,
          maximum,
          theme,
          widthProfile,
          prefix,
          resources,
        ));
      }
      lines = Object.freeze(collected);
      break;
    }
    case 'footnoteDefinition': {
      const prefix = synthetic(`[^${node.label}]: `, node.id, node.labelSpan, theme.link);
      lines = prefixChildBlocks(node.children, source, maximum, theme, widthProfile, prefix, resources);
      break;
    }
    case 'thematicBreak': {
      const ruleWidth = measureTextCells('─', { widthProfile }).cells;
      const glyph = ruleWidth <= maximum ? '─' : '-';
      const repeats = Math.max(1, Math.floor(maximum / Math.min(maximum, ruleWidth)));
      lines = wrapMarkdownSpans(
        [synthetic(glyph.repeat(repeats), node.id, node.markerSpan, theme.tableBorder)],
        maximum,
        widthProfile,
      );
      break;
    }
    case 'htmlBlock':
      lines = wrapMarkdownSpans(
        [synthetic('[HTML block]', node.id, node.span, theme.htmlPlaceholder)],
        maximum,
        widthProfile,
      );
      break;
    case 'linkDefinition':
      lines = wrapMarkdownSpans([
        synthetic(`[${node.label}]: `, node.id, node.labelSpan, theme.link),
        synthetic(node.destination, node.id, node.destinationSpan, theme.link)
      ], maximum, widthProfile);
      break;
  }
  const first = lines[0];
  const anchoredLines = first === undefined || first.sourceOffset === node.span.start
    ? lines
    : Object.freeze([
      Object.freeze({ ...first, sourceOffset: node.span.start }),
      ...lines.slice(1)
    ]);
  return Object.freeze({ nodeId: node.id, kind: node.kind, sourceSpan: node.span, lines: anchoredLines });
}

function prefixChildBlocks(
  children: readonly MarkdownBlockNode[],
  source: string,
  width: number,
  theme: MarkdownTheme,
  widthProfile: TextWidthProfile,
  prefix: MarkdownRenderSpan,
  resources: MarkdownBlockResources,
  repeatPrefix = false
): readonly MarkdownLayoutLine[] {
  const prefixWidth = Math.max(1, measureTextCells(prefix.text, { widthProfile }).cells);
  const lines: MarkdownLayoutLine[] = [];
  let firstOutputLine = true;
  for (const child of children) {
    const rendered = renderMarkdownBlock(
      child,
      source,
      Math.max(1, width - prefixWidth),
      theme,
      widthProfile,
      resources,
    );
    for (let row = 0; row < rendered.lines.length; row += 1) {
      const line = rendered.lines[row];
      if (line === undefined) continue;
      const leader = repeatPrefix || firstOutputLine
        ? prefix
        : synthetic(' '.repeat(prefixWidth), prefix.nodeId, prefix.sourceSpan, prefix.style ?? theme.body);
      const spans = Object.freeze([leader, ...line.inlineSpans]);
      lines.push(Object.freeze({ ...line, spans, inlineSpans: spans }));
      firstOutputLine = false;
    }
  }
  if (lines.length === 0) return wrapMarkdownSpans([prefix], width, widthProfile);
  return Object.freeze(lines);
}

function synthetic(
  text: string,
  nodeId: number,
  sourceSpan: SourceSpan,
  style: MarkdownTheme['body']
): MarkdownRenderSpan {
  return Object.freeze({ text, nodeId, sourceSpan, style });
}
