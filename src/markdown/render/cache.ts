export interface MarkdownLayoutCacheUpdate {
  readonly reusedBlockLayouts: number;
  readonly rebuiltBlockLayouts: number;
  readonly fullPreviewLayout: boolean;
}

interface Entry<Value> {
  readonly width: number;
  readonly theme: object;
  readonly widthProfile: object;
  readonly sourceStart: number;
  readonly value: Value;
}

export interface MarkdownBlockLayoutCache<Value> {
  get(nodeId: number, width: number, theme: object, widthProfile: object): Entry<Value> | undefined;
  set(nodeId: number, entry: Entry<Value>): void;
  delete(nodeId: number): boolean;
  retain(nodeIds: ReadonlySet<number>): number;
  clear(): void;
}

export function createMarkdownBlockLayoutCache<Value>(): MarkdownBlockLayoutCache<Value> {
  const entries = new Map<number, Entry<Value>>();
  return Object.freeze({
    get(nodeId: number, width: number, theme: object, widthProfile: object) {
      const entry = entries.get(nodeId);
      return entry?.width === width
        && entry.theme === theme
        && entry.widthProfile === widthProfile
        ? entry
        : undefined;
    },
    set(nodeId: number, entry: Entry<Value>) {
      entries.set(nodeId, Object.freeze(entry));
    },
    delete(nodeId: number) {
      return entries.delete(nodeId);
    },
    retain(nodeIds: ReadonlySet<number>) {
      let removed = 0;
      for (const nodeId of entries.keys()) {
        if (nodeIds.has(nodeId)) continue;
        entries.delete(nodeId);
        removed += 1;
      }
      return removed;
    },
    clear() {
      entries.clear();
    }
  });
}
