import type { AccessibleNode, AccessibleRole } from '@ismail-elkorchi/terminal-ui/accessibility';
import {
  defineComponent,
  ignoreMessage,
} from '@ismail-elkorchi/terminal-ui/component';
import type { RoutedPointerEvent } from '@ismail-elkorchi/terminal-ui/input';
import {
  measureTextCells,
  textWidthProfileKey,
  type TextWidthProfile,
} from '@ismail-elkorchi/terminal-ui/text';
import { mergeTerminalStyles, type FocusTarget, type HitTarget } from '@ismail-elkorchi/terminal-ui/renderer';
import { prepareMarkdownRender, type MarkdownRenderWork, type MarkdownRenderPreparationOptions } from './work.js';
import type { MarkdownAccessibleNode, MarkdownAccessibleRole } from './accessibility.js';
import { localImageComponent } from './image.js';
import type { MarkdownRenderSpan } from './inline.js';
import type {
  MarkdownPreviewActionFragment,
  MarkdownPreviewActivation,
  MarkdownPreviewLayout,
} from './layout.js';

export type MarkdownPreviewPresentation =
  | { readonly kind: 'pending'; readonly rows: number }
  | { readonly kind: 'failed'; readonly rows: number; readonly message: string }
  | ReadyMarkdownPreviewPresentation;

export interface ReadyMarkdownPreviewPresentation {
  readonly kind: 'ready';
  readonly layout: MarkdownPreviewLayout;
  readonly width: number;
  readonly contentColumn: number;
  readonly media: readonly ReturnType<typeof localImageComponent>[];
  readonly mediaBounds: readonly FocusTarget['bounds'][];
  readonly hiddenMediaBounds: readonly null[];
  readonly focusTargets: readonly FocusTarget[];
  readonly targets: ReadonlyMap<string, MarkdownPreviewActionFragment>;
  readonly hitTargets: readonly HitTarget<MarkdownPreviewAction>[];
  accessibility(focusedTargetId?: string): AccessibleNode;
}

export interface MarkdownPreviewOptions {
  readonly label: string;
  readonly version: string;
  readonly presentation: MarkdownPreviewPresentation;
}

interface ResolvedMarkdownPreview {
  readonly label: string;
  readonly layout: MarkdownPreviewLayout;
  readonly viewportWidth: number;
  readonly contentColumn: number;
  readonly presentation: ReadyMarkdownPreviewPresentation;
}

/** An accepted allocation, never a speculative measurement constraint. */
export interface MarkdownPreviewAllocation {
  readonly layoutRevision: string;
  readonly width: number;
  readonly rows: number;
  readonly widthProfile: TextWidthProfile;
}

export interface MarkdownPreviewLayoutSnapshot extends MarkdownPreviewAllocation {
  readonly layout: MarkdownPreviewLayout;
}

export type MarkdownPreviewAction =
  | { readonly kind: 'activate'; readonly target: MarkdownPreviewActivation }
  | { readonly kind: 'allocate'; readonly allocation: MarkdownPreviewAllocation }
  | { readonly kind: 'layout'; readonly snapshot: MarkdownPreviewLayoutSnapshot };

function resolvedPreview(model: MarkdownPreviewOptions, width: number, widthProfile: TextWidthProfile): ResolvedMarkdownPreview | undefined {
  const prepared = model.presentation;
  return prepared.kind !== 'ready' || prepared.width !== width
    || textWidthProfileKey(prepared.layout.widthProfile) !== textWidthProfileKey(widthProfile)
    ? undefined
    : { label: model.label, viewportWidth: width, layout: prepared.layout, contentColumn: prepared.contentColumn, presentation: prepared };
}

function previewRows(presentation: MarkdownPreviewPresentation): number {
  return presentation.kind === 'ready' ? presentation.layout.rows.length : presentation.rows;
}

function previewStatus(presentation: MarkdownPreviewPresentation): string {
  return presentation.kind === 'failed' ? `Preview failed: ${presentation.message}` : 'Preparing preview…';
}

const documentFocusTargetId = 'document';

const markdownPreviewSlots = {
  media: { cardinality: 'many', owner: 'implementation', messages: 'none' },
} as const;

/** Resolves a rendered preview cell against the exact layout that produced it. */
export function markdownPreviewActivationAt(
  layout: MarkdownPreviewLayout,
  row: number,
  column: number,
): MarkdownPreviewActivation | undefined {
  const normalizedRow = Math.max(0, Math.min(layout.rows.length - 1, Math.floor(row)));
  const line = layout.rows[normalizedRow];
  if (line === undefined) return undefined;
  const normalizedColumn = Math.max(0, Math.floor(column));
  let consumed = 0;
  for (const span of line.inlineSpans) {
    const next = consumed + measureTextCells(span.text, { widthProfile: layout.widthProfile }).cells;
    if (normalizedColumn < next) return previewActivation(layout, normalizedRow, line.sourceOffset, span);
    consumed = next;
  }
  const span = line.inlineSpans.at(-1);
  return span === undefined
    ? undefined
    : previewActivation(layout, normalizedRow, line.sourceOffset, span);
}

export const markdownPreview = defineComponent<MarkdownPreviewOptions, MarkdownPreviewAction>()({
  name: 'vellum/components/markdown-preview',
  identity: 'required',
  structure: 'composite',
  semantics: 'semantic',
  accessibleRole: 'document',
  slots: markdownPreviewSlots,
  implementationSlots: ({ model }) => ({
    media: model.presentation.kind === 'ready' ? model.presentation.media : [],
  }),
  // Keep the previous extent while preparation is pending so an automatic
  // scrollbar cannot oscillate between speculative full and reduced widths.
  measure: ({ model, constraints }) => ({
    minWidth: 0, minHeight: 0, preferredWidth: constraints.width,
    preferredHeight: Math.max(1, previewRows(model.presentation)),
  }),
  layout: ({ model, bounds, viewport, widthProfile }) => {
    const resolved = viewport.width < 1 || viewport.height < 1 ? undefined : resolvedPreview(model, bounds.width, widthProfile);
    return { media: model.presentation.kind !== 'ready' ? []
      : resolved === undefined ? model.presentation.hiddenMediaBounds : model.presentation.mediaBounds };
  },
  onLayout(input) {
    const previous = input.previous;
    if (previous !== undefined && previous.model.version === input.model.version
      && previous.model.presentation === input.model.presentation
      && textWidthProfileKey(previous.widthProfile) === textWidthProfileKey(input.widthProfile)
      && previous.bounds.width === input.bounds.width
      && previous.viewport.height === input.viewport.height
      && previous.viewport.width === input.viewport.width) return ignoreMessage();
    const allocation = {
      layoutRevision: input.commitId, width: input.viewport.width < 1 ? 0 : input.bounds.width,
      rows: input.viewport.height, widthProfile: input.widthProfile,
    };
    const resolved = input.viewport.width < 1 || input.viewport.height < 1
      ? undefined : resolvedPreview(input.model, input.bounds.width, input.widthProfile);
    return resolved === undefined
      ? { kind: 'allocate', allocation }
      : { kind: 'layout', snapshot: { ...allocation, layout: resolved.layout } };
  },
  renderBeforeChildren: ({ model: options, bounds, target, viewport, focusedTargetId, widthProfile }) => {
    if (bounds.width < 1 || viewport.width < 1 || viewport.height < 1) return;
    const model = resolvedPreview(options, bounds.width, widthProfile);
    if (model === undefined) {
      target.writeLine(viewport.row, viewport.column, { spans: [{ text: previewStatus(options.presentation) }] });
      return;
    }
    assertPreviewGeometry(model, widthProfile);
    const end = Math.min(model.layout.rows.length, viewport.row + viewport.height);
    for (let row = viewport.row; row < end; row += 1) {
      const line = model.layout.rows[row];
      if (line === undefined) continue;
      if (line.background !== undefined) {
        target.writeLine(row, model.contentColumn, {
          spans: [{ text: ' '.repeat(model.layout.width), style: line.background }]
        });
      }
      const inlineSpans = focusedTargetId === undefined
        ? line.inlineSpans
        : Object.freeze(line.inlineSpans.map((span) => (
            span.activation === undefined
              || previewTargetId(span.activation.nodeId) !== focusedTargetId
              ? span
              : focusedPreviewSpan(span)
          )));
      if (inlineSpans.length > 0) {
        target.writeLine(row, model.contentColumn, inlineSpans === line.inlineSpans
          ? line
          : { spans: inlineSpans });
      }
    }
  },
  keys: ({ model: options, bounds, viewport, widthProfile, focusedTargetId }) => {
    if (viewport.width < 1 || viewport.height < 1) return {};
    const model = resolvedPreview(options, bounds.width, widthProfile);
    const focused = model === undefined || focusedTargetId === undefined
      ? undefined
      : model.presentation.targets.get(focusedTargetId);
    return focused === undefined
      ? {}
      : { enter: (): MarkdownPreviewAction => ({ kind: 'activate', target: focused }) };
  },
  focusTargets: ({ model: options, bounds, viewport, widthProfile }) => {
    if (viewport.width < 1 || viewport.height < 1) return [];
    const model = resolvedPreview(options, bounds.width, widthProfile);
    // Pending and linkless documents keep a keyboard owner. Ready links retain
    // their native Enter activation, while focus moved elsewhere stays valid.
    return model === undefined || model.presentation.focusTargets.length === 0
      ? [{ id: documentFocusTargetId, bounds: { row: 0, column: 0, width: bounds.width, height: 1 } }]
      : model.presentation.focusTargets;
  },
  hitTargets(input) {
    const model = resolvedPreview(input.model, input.bounds.width, input.widthProfile);
    if (model === undefined || input.viewport.width === 0 || input.viewport.height === 0) return [];
    const contentTarget = {
      id: `${input.id ?? 'markdown-preview'}:content`,
      bounds: input.viewport,
      accepts: ['click'],
      message(event: RoutedPointerEvent) {
        if (event.button !== 'left') return ignoreMessage();
        const column = input.viewport.column + (event.localColumn ?? 0) - model.contentColumn;
        const target = column < 0 || column >= model.layout.width
          ? undefined
          : markdownPreviewActivationAt(
              model.layout,
              input.viewport.row + (event.localRow ?? 0),
              column,
            );
        return target === undefined ? ignoreMessage() : { kind: 'activate' as const, target };
      },
    } as const;
    const targets = model.presentation.hitTargets;
    const start = firstTargetAtRow(targets, input.viewport.row);
    const end = firstTargetAtRow(targets, input.viewport.row + input.viewport.height);
    const actionTargets = targets.slice(start, end);
    return [contentTarget, ...actionTargets];
  },
  accessibility: ({ id, model: options, bounds, widthProfile, focusedTargetId }) => {
    const model = resolvedPreview(options, bounds.width, widthProfile);
    return model === undefined
      ? { id, role: 'document', label: options.label, focused: focusedTargetId === documentFocusTargetId, children: [{ id: `${id}:status`, role: 'status', label: previewStatus(options.presentation) }] }
      : { ...model.presentation.accessibility(focusedTargetId), id, label: model.label, ...(focusedTargetId === documentFocusTargetId ? { focused: true } : {}) };
  },
});

/** Prepare terminal-specific semantics in the same cancellable effect as layout. */
export function prepareMarkdownPreviewPresentation(
  layout: MarkdownPreviewLayout,
  width: number,
  contentColumn: number,
  id: string,
  options: MarkdownRenderPreparationOptions = {},
): Promise<ReadyMarkdownPreviewPresentation> {
  return prepareMarkdownRender(previewPresentationWork(layout, width, contentColumn, id), options);
}

function* previewPresentationWork(
  layout: MarkdownPreviewLayout,
  width: number,
  contentColumn: number,
  id: string,
): MarkdownRenderWork<ReadyMarkdownPreviewPresentation> {
  const grouped = new Map<string, { target: MarkdownPreviewActionFragment; bounds: FocusTarget['bounds']; fragments: number }>();
  const hitTargets: HitTarget<MarkdownPreviewAction>[] = [];
  // The layout emits fragments in row order, so visible pointer targets are a
  // binary-searched slice rather than a whole-document pass during each frame.
  for (const target of layout.activations) {
    yield;
    const bounds = Object.freeze({ row: target.row, column: contentColumn + target.column, width: target.width, height: 1 });
    const group = grouped.get(target.id);
    const fragmentIndex = group?.fragments ?? 0;
    if (group === undefined) grouped.set(target.id, { target, bounds, fragments: 1 });
    else {
      group.bounds = unionBounds(group.bounds, bounds);
      group.fragments += 1;
    }
    hitTargets.push(Object.freeze({
      id: `${id}:${target.id}:${String(fragmentIndex)}`,
      bounds, accepts: ['click', 'pointerDown'] as const, cursor: 'pointer',
      focus: { kind: 'target' as const, targetId: target.id }, zIndex: 1,
      message(event: RoutedPointerEvent) {
        return event.kind !== 'click' || event.button !== 'left'
          ? ignoreMessage() : { kind: 'activate' as const, target };
      },
    }));
  }
  const focusTargets: FocusTarget[] = [];
  const targets = new Map<string, MarkdownPreviewActionFragment>();
  for (const [targetId, group] of grouped) {
    yield;
    focusTargets.push(Object.freeze({ id: targetId, bounds: group.bounds }));
    targets.set(targetId, group.target);
  }
  const paths = new Map<string, readonly number[]>();
  const accessibility = yield* accessiblePreviewNode(layout.accessibility, id, [], paths);
  let focusedId: string | undefined;
  let focusedTree = accessibility;
  const media: ReturnType<typeof localImageComponent>[] = [];
  const mediaBounds: FocusTarget['bounds'][] = [];
  const hiddenMediaBounds: null[] = [];
  for (const entry of layout.media) {
    yield;
    media.push(localImageComponent(entry.media.image, entry.media.label));
    mediaBounds.push(Object.freeze({ row: entry.row, column: contentColumn + entry.column, width: entry.width, height: entry.height }));
    hiddenMediaBounds.push(null);
  }
  return Object.freeze({
    kind: 'ready', layout, width, contentColumn,
    media: Object.freeze(media), mediaBounds: Object.freeze(mediaBounds), hiddenMediaBounds: Object.freeze(hiddenMediaBounds),
    focusTargets: Object.freeze(focusTargets), targets, hitTargets: Object.freeze(hitTargets),
    accessibility(targetId?: string) {
      if (targetId === undefined) return accessibility;
      if (focusedId !== targetId) {
        focusedId = targetId;
        const path = paths.get(targetId);
        focusedTree = path === undefined ? accessibility : focusedAccessibleNode(accessibility, path, 0);
      }
      return focusedTree;
    },
  });
}

function unionBounds(left: FocusTarget['bounds'], right: FocusTarget['bounds']): FocusTarget['bounds'] {
  const row = Math.min(left.row, right.row);
  const column = Math.min(left.column, right.column);
  return Object.freeze({
    row, column,
    width: Math.max(left.column + left.width, right.column + right.width) - column,
    height: Math.max(left.row + left.height, right.row + right.height) - row,
  });
}

function firstTargetAtRow(targets: readonly HitTarget<MarkdownPreviewAction>[], row: number): number {
  let low = 0;
  let high = targets.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((targets[middle]?.bounds.row ?? Number.POSITIVE_INFINITY) < row) low = middle + 1;
    else high = middle;
  }
  return low;
}

function previewTargetId(nodeId: number): string {
  return `markdown-${String(nodeId)}`;
}

function assertActiveWidthProfile(
  layout: MarkdownPreviewLayout,
  widthProfile: TextWidthProfile,
): void {
  if (textWidthProfileKey(layout.widthProfile) !== textWidthProfileKey(widthProfile)) {
    throw new TypeError('Markdown preview layout must use the active terminal text-width profile.');
  }
}

function assertPreviewGeometry(
  model: ResolvedMarkdownPreview,
  widthProfile: TextWidthProfile,
): void {
  assertActiveWidthProfile(model.layout, widthProfile);
  if (!Number.isInteger(model.viewportWidth) || model.viewportWidth < 1) {
    throw new RangeError('Markdown preview viewport width must be a positive integer.');
  }
  if (!Number.isInteger(model.contentColumn)
    || model.contentColumn < 0
    || model.contentColumn + model.layout.width > model.viewportWidth) {
    throw new RangeError('Markdown preview content must fit within its viewport width.');
  }
}

function focusedPreviewSpan(span: MarkdownRenderSpan): MarkdownRenderSpan {
  const style = mergeTerminalStyles(span.style, { inverse: true, bold: true });
  return Object.freeze({
    ...span,
    ...(style === undefined ? {} : { style }),
  });
}

function previewActivation(
  layout: MarkdownPreviewLayout,
  row: number,
  sourceOffset: number,
  span: MarkdownPreviewLayout['rows'][number]['inlineSpans'][number],
): MarkdownPreviewActivation {
  const sourceSpan = span.activation === undefined
    ? blockSourceSpanAt(layout, sourceOffset) ?? span.sourceSpan
    : span.sourceSpan;
  return Object.freeze({
    row,
    sourceSpan,
    ...(span.activation === undefined ? {} : { activation: span.activation }),
  });
}

function blockSourceSpanAt(
  layout: MarkdownPreviewLayout,
  sourceOffset: number
): MarkdownPreviewLayout['blocks'][number]['sourceSpan'] | undefined {
  let low = 0;
  let high = layout.blocks.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((layout.blocks[middle]?.sourceSpan.start ?? Number.POSITIVE_INFINITY) <= sourceOffset) low = middle + 1;
    else high = middle;
  }
  const candidate = layout.blocks[Math.max(0, low - 1)];
  return candidate !== undefined && sourceOffset <= candidate.sourceSpan.end
    ? candidate.sourceSpan
    : undefined;
}

function* accessiblePreviewNode(
  node: MarkdownAccessibleNode,
  rootId: string,
  path: readonly number[],
  paths: Map<string, readonly number[]>,
): MarkdownRenderWork<AccessibleNode> {
  yield;
  const role = accessibleRole(node.role);
  paths.set(node.id, path);
  const children: AccessibleNode[] = [];
  for (let index = 0; index < node.children.length; index += 1) {
    const child = node.children[index];
    if (child !== undefined) children.push(yield* accessiblePreviewNode(child, rootId, [...path, index], paths));
  }
  return Object.freeze({
    id: path.length === 0 ? rootId : `${rootId}:${node.id}`, role,
    ...(role === 'text' ? { value: node.label } : { label: node.label }),
    ...(node.headingLevel === undefined ? {} : { position: { level: node.headingLevel } }),
    ...(node.checked === undefined ? {} : { checked: node.checked }),
    ...(children.length === 0 ? {} : { children: Object.freeze(children) }),
  });
}

function focusedAccessibleNode(node: AccessibleNode, path: readonly number[], depth: number): AccessibleNode {
  const index = path[depth];
  if (index === undefined) return Object.freeze({ ...node, focused: true });
  const child = node.children?.[index];
  if (child === undefined) return node;
  const children = [...node.children ?? []];
  children[index] = focusedAccessibleNode(child, path, depth + 1);
  return Object.freeze({ ...node, children: Object.freeze(children) });
}

function accessibleRole(role: MarkdownAccessibleRole): AccessibleRole {
  switch (role) {
    case 'document': return 'document';
    case 'heading': return 'heading';
    case 'link': return 'link';
    case 'image':
    case 'diagram': return 'image';
    case 'list': return 'list';
    case 'listItem': return 'listitem';
    case 'checkbox': return 'checkbox';
    case 'table': return 'table';
    case 'row': return 'row';
    case 'cell': return 'cell';
    case 'separator': return 'separator';
    case 'diagnostic': return 'status';
    case 'paragraph':
    case 'code':
    case 'math': return 'text';
    case 'blockquote':
    case 'note':
    case 'frontMatter':
    case 'footnote': return 'group';
  }
}
