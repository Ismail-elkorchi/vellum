import { readdir, stat } from 'node:fs/promises';
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
      indexedFiles: Object.freeze([]),
      expandedIds: Object.freeze([]),
      exclusionPatterns: Object.freeze([...exclusionPatterns]),
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
    indexedFiles: Object.freeze([]),
    expandedIds: Object.freeze([root]),
    activeId: root,
    exclusionPatterns: Object.freeze([...exclusionPatterns]),
    scroll: createScrollState(),
    revision: 0
  });
}

export function markDirectoryLoading(state: FileTreeState, directoryId: string): FileTreeState {
  const node = state.nodes[directoryId];
  if (node?.kind !== 'directory' || node.loading) return state;
  return replaceNode(state, Object.freeze({ ...node, loading: true }));
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
    if (entry.name === '.git' || fileTreePathExcluded(relative, entry.name, state.exclusionPatterns)) continue;
    const entryPath = path.join(directory.path, entry.name);
    let kind: FileTreeNode['kind'] | undefined;
    if (entry.isDirectory()) kind = 'directory';
    else if (entry.isFile()) kind = 'file';
    else if (entry.isSymbolicLink()) {
      const target = await stat(entryPath);
      if (target.isFile()) kind = 'file';
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
    || left.label.localeCompare(right.label, undefined, { numeric: true, sensitivity: 'base' })
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
  return Object.freeze({
    ...state,
    nodes: Object.freeze(nextNodes),
    revision: state.revision + 1
  });
}

export function selectFileTreeNode(state: FileTreeState, nodeId: string): FileTreeState {
  if (state.nodes[nodeId] === undefined || state.activeId === nodeId) return state;
  return Object.freeze({ ...state, activeId: nodeId });
}

export function setDirectoryExpanded(
  state: FileTreeState,
  directoryId: string,
  expanded: boolean
): FileTreeState {
  if (state.nodes[directoryId]?.kind !== 'directory') return state;
  const values = new Set(state.expandedIds);
  if (expanded) values.add(directoryId);
  else values.delete(directoryId);
  return Object.freeze({ ...state, expandedIds: Object.freeze([...values]) });
}

export function indexedFilePaths(state: FileTreeState): readonly string[] {
  return state.indexedFiles;
}

export async function indexProjectFiles(
  state: FileTreeState,
  signal: AbortSignal
): Promise<readonly string[]> {
  const root = state.rootIds[0];
  if (root === undefined) return Object.freeze([]);
  const pending = [root];
  const files: string[] = [];
  while (pending.length > 0) {
    signal.throwIfAborted();
    const directory = pending.pop();
    if (directory === undefined) break;
    const entries = (await readdir(directory, { withFileTypes: true }))
      .toSorted((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      signal.throwIfAborted();
      const entryPath = path.join(directory, entry.name);
      const relative = path.relative(root, entryPath);
      if (entry.name === '.git' || fileTreePathExcluded(relative, entry.name, state.exclusionPatterns)) continue;
      if (entry.isDirectory()) {
        pending.push(entryPath);
      } else if (entry.isFile()) {
        files.push(entryPath);
      } else if (entry.isSymbolicLink() && (await stat(entryPath)).isFile()) {
        files.push(entryPath);
      }
    }
  }
  return Object.freeze(files.toSorted((left, right) => left.localeCompare(right)));
}

export function commitIndexedFiles(
  state: FileTreeState,
  indexedFiles: readonly string[]
): FileTreeState {
  return Object.freeze({ ...state, indexedFiles: Object.freeze([...indexedFiles]), revision: state.revision + 1 });
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
  const base = {
    id: node.id,
    label: node.label,
    metadata: Object.freeze({ path: node.path, kind: node.kind })
  };
  if (node.kind === 'file') return Object.freeze({ ...base, kind: 'leaf' });
  if (!node.loaded) return Object.freeze({ ...base, kind: 'lazy' });
  return Object.freeze({
    ...base,
    kind: 'branch',
    children: Object.freeze(node.children.flatMap((id) => {
      const child = terminalNode(state, id);
      return child === undefined ? [] : [child];
    }))
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

export function fileTreePathExcluded(relativePath: string, name: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => {
    const normalized = pattern.replaceAll('\\', '/');
    if (!normalized.includes('*')) return name === normalized || relativePath.replaceAll('\\', '/') === normalized;
    const expression = normalized
      .replace(/[.+?^${}()|[\]\\]/gu, '\\$&')
      .replaceAll('**', '\u0000')
      .replaceAll('*', '[^/]*')
      .replaceAll('\u0000', '.*');
    return new RegExp(`^(?:${expression})$`, 'u').test(relativePath.replaceAll('\\', '/'));
  });
}
