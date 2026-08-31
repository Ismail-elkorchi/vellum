import { readdir, stat } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import path from 'node:path';
import {
  createScrollState,
  createTreeSource,
  createTreeView,
  treeReducer,
  type TreeTransition
} from '@ismail-elkorchi/terminal-ui/behavior';
import type { TreeNode, TreeView } from '@ismail-elkorchi/terminal-ui/components';
import type { FileTreeNode, FileTreeState } from '../app/types.js';
import { compareTextCaseInsensitive } from '../order.js';
import { minimatch } from 'minimatch';

export const defaultFileTreeExclusions: readonly string[] = Object.freeze([
  '.git',
  'node_modules'
]);

export function createFileTreeState(
  rootDirectory?: string,
  exclusionPatterns: readonly string[] = defaultFileTreeExclusions
): FileTreeState {
  if (rootDirectory === undefined) {
    return Object.freeze({
      nodes: Object.freeze({}),
      rootIds: Object.freeze([]),
      expandedIds: Object.freeze([]),
      pendingExpansionIds: Object.freeze([]),
      exclusionPatterns: Object.freeze([...exclusionPatterns]),
      filter: '',
      sort: 'foldersFirst',
      scroll: createScrollState(),
      revision: 0
    });
  }
  const root = path.resolve(rootDirectory);
  const node: FileTreeNode = Object.freeze({
    id: root,
    path: root,
    label: path.basename(root) || root,
    kind: 'directory',
    loaded: false,
    loading: false,
    children: Object.freeze([])
  });
  return Object.freeze({
    nodes: Object.freeze({ [root]: node }),
    rootIds: Object.freeze([root]),
    expandedIds: Object.freeze([root]),
    pendingExpansionIds: Object.freeze([]),
    activeId: root,
    exclusionPatterns: Object.freeze([...exclusionPatterns]),
    filter: '',
    sort: 'foldersFirst',
    scroll: createScrollState(),
    revision: 0
  });
}

export function markDirectoryLoading(state: FileTreeState, directoryId: string): FileTreeState {
  const node = state.nodes[directoryId];
  if (node?.kind !== 'directory' || node.loading) return state;
  return replaceNode(state, Object.freeze({ ...node, loading: true }));
}

export function clearDirectoryLoading(state: FileTreeState, directoryId: string): FileTreeState {
  const node = state.nodes[directoryId];
  if (node?.kind !== 'directory' || !node.loading) return state;
  return replaceNode(state, Object.freeze({ ...node, loading: false }));
}

export async function readDirectoryNodes(
  state: FileTreeState,
  directoryId: string,
  signal: AbortSignal
): Promise<readonly FileTreeNode[]> {
  const directory = state.nodes[directoryId];
  if (directory?.kind !== 'directory') throw new Error(`Unknown file tree directory: ${directoryId}`);
  signal.throwIfAborted();
  const entries = await readdir(directory.path, { withFileTypes: true });
  const nodes: FileTreeNode[] = [];
  for (const entry of entries) {
    signal.throwIfAborted();
    const relative = path.relative(state.rootIds[0] ?? directory.path, path.join(directory.path, entry.name));
    if (entry.name === '.git' || fileTreePathExcluded(relative, state.exclusionPatterns)) continue;
    const entryPath = path.join(directory.path, entry.name);
    let kind: FileTreeNode['kind'] | undefined;
    if (entry.isDirectory()) kind = 'directory';
    else if (entry.isFile()) kind = 'file';
    else if (entry.isSymbolicLink()) {
      const target = await statIfPresent(entryPath);
      if (target?.isFile() === true) kind = 'file';
    }
    if (kind === undefined) continue;
    nodes.push(Object.freeze({
      id: entryPath,
      path: entryPath,
      label: entry.name,
      kind,
      parentId: directoryId,
      loaded: kind === 'file',
      loading: false,
      children: Object.freeze([])
    }));
  }
  nodes.sort((left, right) => (
    (left.kind === right.kind ? 0 : left.kind === 'directory' ? -1 : 1)
    || compareTextCaseInsensitive(left.label, right.label)
  ));
  return Object.freeze(nodes);
}

export function commitDirectoryNodes(
  state: FileTreeState,
  directoryId: string,
  children: readonly FileTreeNode[]
): FileTreeState {
  const directory = state.nodes[directoryId];
  if (directory?.kind !== 'directory') return state;
  const nextNodes: Record<string, FileTreeNode> = { ...state.nodes };
  const childIds = new Set(children.map((child) => child.id));
  for (const oldChild of directory.children) if (!childIds.has(oldChild)) removeSubtree(nextNodes, oldChild);
  for (const child of children) {
    const previous = state.nodes[child.id];
    nextNodes[child.id] = previous?.kind === 'directory' && child.kind === 'directory'
      ? Object.freeze({ ...child, loaded: previous.loaded, loading: false, children: previous.children })
      : child;
  }
  nextNodes[directoryId] = Object.freeze({
    ...directory,
    loaded: true,
    loading: false,
    children: Object.freeze(children.map((child) => child.id))
  });
  const expandedIds = [...new Set([
    ...state.expandedIds.filter((id) => nextNodes[id]?.kind === 'directory'),
    ...children
      .filter((child) => child.kind === 'directory' && state.pendingExpansionIds.includes(child.id))
      .map((child) => child.id)
  ])];
  const activeId = state.activeId !== undefined && nextNodes[state.activeId] !== undefined
    ? state.activeId
    : directoryId;
  return Object.freeze({
    ...state,
    nodes: Object.freeze(nextNodes),
    expandedIds: Object.freeze(expandedIds),
    activeId,
    revision: state.revision + 1
  });
}

export function terminalFileTreeView(
  state: FileTreeState
): TreeView<Readonly<{ path: string; kind: FileTreeNode['kind'] }>> {
  const roots = state.rootIds.flatMap((id) => {
    const node = terminalNode(state, id);
    return node === undefined ? [] : [node];
  });
  const source = createTreeSource(roots);
  return createTreeView(source, {
    ...(state.activeId === undefined ? {} : { activeId: state.activeId }),
    selection: state.activeId === undefined
      ? Object.freeze({ mode: 'single' })
      : Object.freeze({ mode: 'single', selectedId: state.activeId }),
    expandedIds: state.expandedIds,
    scroll: state.scroll
  });
}

export function setFileTreeFilter(state: FileTreeState, filter: string): FileTreeState {
  return filter === state.filter ? state : Object.freeze({ ...state, filter, revision: state.revision + 1 });
}

export function cycleFileTreeSort(state: FileTreeState): FileTreeState {
  const sort = state.sort === 'foldersFirst'
    ? 'nameAscending'
    : state.sort === 'nameAscending'
      ? 'nameDescending'
      : 'foldersFirst';
  return Object.freeze({ ...state, sort, revision: state.revision + 1 });
}

export function reduceFileTree(
  state: FileTreeState,
  transition: TreeTransition
): FileTreeState {
  const view = terminalFileTreeView(state);
  const next = treeReducer({
    ...(state.activeId === undefined ? {} : { activeId: state.activeId }),
    selection: state.activeId === undefined
      ? Object.freeze({ mode: 'single' })
      : Object.freeze({ mode: 'single', selectedId: state.activeId }),
    expandedIds: state.expandedIds,
    scroll: state.scroll
  }, transition, { view });
  return Object.freeze({
    ...state,
    ...(next.activeId === undefined ? {} : { activeId: next.activeId }),
    expandedIds: Object.freeze(next.expandedIds),
    scroll: next.scroll
  });
}

function terminalNode(
  state: FileTreeState,
  nodeId: string
): TreeNode<Readonly<{ path: string; kind: FileTreeNode['kind'] }>> | undefined {
  const node = state.nodes[nodeId];
  if (node === undefined) return undefined;
  const normalizedFilter = state.filter.trim().toLocaleLowerCase();
  const base = {
    id: node.id,
    label: node.label,
    metadata: Object.freeze({ path: node.path, kind: node.kind })
  };
  if (node.kind === 'file') {
    return normalizedFilter.length > 0 && !node.label.toLocaleLowerCase().includes(normalizedFilter)
      ? undefined
      : Object.freeze({ ...base, kind: 'leaf' });
  }
  if (!node.loaded) return Object.freeze({ ...base, kind: 'lazy' });
  const children = node.children.flatMap((id) => {
    const child = terminalNode(state, id);
    return child === undefined ? [] : [child];
  }).toSorted((left, right) => {
    const direction = state.sort === 'nameDescending' ? -1 : 1;
    const byName = direction * compareTextCaseInsensitive(left.label, right.label);
    return state.sort === 'foldersFirst'
      ? ((left.kind === right.kind ? 0 : left.kind === 'leaf' ? 1 : -1) || byName)
      : byName;
  });
  if (state.rootIds[0] !== node.id && normalizedFilter.length > 0
    && children.length === 0 && !node.label.toLocaleLowerCase().includes(normalizedFilter)) return undefined;
  return Object.freeze({
    ...base,
    kind: 'branch',
    children: Object.freeze(children)
  });
}

function replaceNode(state: FileTreeState, node: FileTreeNode): FileTreeState {
  return Object.freeze({
    ...state,
    nodes: Object.freeze({ ...state.nodes, [node.id]: node })
  });
}

function removeSubtree(nodes: Record<string, FileTreeNode>, nodeId: string): void {
  const node = nodes[nodeId];
  if (node === undefined) return;
  for (const child of node.children) removeSubtree(nodes, child);
  delete nodes[nodeId];
}

export function fileTreePathExcluded(relativePath: string, patterns: readonly string[]): boolean {
  const candidate = relativePath.replaceAll('\\', '/');
  return patterns.some((pattern) => {
    const normalized = pattern.replaceAll('\\', '/');
    const options = {
      dot: true,
      matchBase: !normalized.includes('/'),
      nocase: process.platform === 'win32'
    } as const;
    return minimatch(candidate, normalized, options) || minimatch(`${candidate}/`, normalized, options);
  });
}

async function statIfPresent(filePath: string): Promise<Stats | undefined> {
  try {
    return await stat(filePath);
  } catch (error) {
    if (error instanceof Error
      && 'code' in error
      && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}
