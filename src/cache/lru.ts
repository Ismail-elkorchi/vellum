export class BoundedLruMap<Key, Value> {
  readonly #entries = new Map<Key, Value>();
  readonly #maximumEntries: number;

  public constructor(maximumEntries: number) {
    if (!Number.isSafeInteger(maximumEntries) || maximumEntries <= 0) {
      throw new RangeError('The maximum LRU entry count must be a positive integer.');
    }
    this.#maximumEntries = maximumEntries;
  }

  get size(): number {
    return this.#entries.size;
  }

  get(key: Key): Value | undefined {
    const value = this.#entries.get(key);
    if (value === undefined) return undefined;
    this.#entries.delete(key);
    this.#entries.set(key, value);
    return value;
  }

  set(key: Key, value: Value): void {
    this.#entries.delete(key);
    this.#entries.set(key, value);
    while (this.#entries.size > this.#maximumEntries) {
      const oldest = this.#entries.keys().next().value as Key | undefined;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }

  clear(): void {
    this.#entries.clear();
  }
}
