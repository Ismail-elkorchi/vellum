import { createRowOffsetMap, type RowOffsetMap } from '@ismail-elkorchi/terminal-ui/text';
import type { MarkdownDocumentNode, SourceSpan } from 'markspan';
import type { MarkdownTheme } from '../theme.js';
import { renderMarkdownBlock, type MarkdownBlockResources, type MarkdownRenderedBlock } from './block.js';
import {
  createMarkdownBlockLayoutCache,
  type MarkdownBlockLayoutCache,
  type MarkdownLayoutCacheUpdate
} from './cache.js';
import type { MarkdownActivation } from './inline.js';
import type { MarkdownLayoutLine } from './wrap.js';
import { accessibleMarkdownDocument, type MarkdownAccessibleNode } from './accessibility.js';

export interface MarkdownPreviewActivation {
  readonly row: number;
  readonly sourceSpan: SourceSpan;
  readonly activation?: MarkdownActivation;
}

export interface MarkdownPreviewLayout {
  readonly width: number;
  readonly lines: readonly MarkdownLayoutLine[];
  readonly blocks: readonly MarkdownRenderedBlock[];
  readonly rowOffsetMap: RowOffsetMap;
  readonly activations: readonly MarkdownPreviewActivation[];
  readonly accessibility: MarkdownAccessibleNode;
  readonly instrumentation: MarkdownLayoutCacheUpdate;
}

export function createPreviewLayoutCache(): MarkdownBlockLayoutCache<MarkdownRenderedBlock> {
  return createMarkdownBlockLayoutCache();
}

export function layoutMarkdownPreview(
  tree: MarkdownDocumentNode,
  source: string,
  width: number,
  theme: MarkdownTheme,
  cache: MarkdownBlockLayoutCache<MarkdownRenderedBlock>,
  resources: MarkdownBlockResources = {}
): MarkdownPreviewLayout {
  const normalizedWidth = Math.max(1, Math.floor(width));
  const blocks: MarkdownRenderedBlock[] = [];
  const lines: MarkdownLayoutLine[] = [];
  const activeIds = new Set<number>();
  let reusedBlockLayouts = 0;
  let rebuiltBlockLayouts = 0;
  for (const node of tree.children) {
    activeIds.add(node.id);
    const existing = cache.get(node.id, normalizedWidth, theme);
    const block = existing === undefined
      ? renderMarkdownBlock(node, source, normalizedWidth, theme, resources)
      : translateBlock(existing.value, node.span.start - existing.sourceStart);
    if (existing === undefined) {
      rebuiltBlockLayouts += 1;
      cache.set(node.id, { width: normalizedWidth, theme, sourceStart: node.span.start, value: block });
    } else {
      reusedBlockLayouts += 1;
    }
    blocks.push(block);
    lines.push(...block.lines);
  }
  cache.retain(activeIds);
  const rowOffsetMap = createRowOffsetMap(lines.map((line) => line.sourceOffset));
  const activations: MarkdownPreviewActivation[] = [];
  for (let row = 0; row < lines.length; row += 1) {
    for (const span of lines[row]?.inlineSpans ?? []) {
      if (span.activation === undefined) continue;
      activations.push(Object.freeze({ row, sourceSpan: span.sourceSpan, activation: span.activation }));
    }
  }
  return Object.freeze({
    width: normalizedWidth,
    lines: Object.freeze(lines),
    blocks: Object.freeze(blocks),
    rowOffsetMap,
    activations: Object.freeze(activations),
    accessibility: accessibleMarkdownDocument(tree),
    instrumentation: Object.freeze({
      reusedBlockLayouts,
      rebuiltBlockLayouts,
      fullPreviewLayout: tree.children.length > 0 && reusedBlockLayouts === 0
    })
  });
}

function translateBlock(block: MarkdownRenderedBlock, delta: number): MarkdownRenderedBlock {
  if (delta === 0) return block;
  const move = (span: SourceSpan): SourceSpan => Object.freeze({ start: span.start + delta, end: span.end + delta });
  const lines = block.lines.map((line) => {
    const inlineSpans = line.inlineSpans.map((span) => Object.freeze({ ...span, sourceSpan: move(span.sourceSpan) }));
    return Object.freeze({
      ...line,
      sourceOffset: line.sourceOffset + delta,
      spans: Object.freeze(inlineSpans),
      inlineSpans: Object.freeze(inlineSpans)
    });
  });
  return Object.freeze({ ...block, sourceSpan: move(block.sourceSpan), lines: Object.freeze(lines) });
}
