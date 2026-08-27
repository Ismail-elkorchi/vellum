export type DiffLine =
  | { readonly kind: 'unchanged'; readonly text: string; readonly bufferLine: number; readonly diskLine: number }
  | { readonly kind: 'removed'; readonly text: string; readonly bufferLine: number }
  | { readonly kind: 'added'; readonly text: string; readonly diskLine: number };

export async function compareSourceLines(
  bufferSource: string,
  diskSource: string,
  signal?: AbortSignal
): Promise<readonly DiffLine[]> {
  const left = lines(bufferSource);
  const right = lines(diskSource);
  const matches = await lineMatches(left, right, signal);
  const result: DiffLine[] = [];
  let leftIndex = 0;
  let rightIndex = 0;
  for (const match of [...matches, [left.length, right.length] as const]) {
    signal?.throwIfAborted();
    while (leftIndex < match[0]) {
      result.push(Object.freeze({ kind: 'removed', text: left[leftIndex] ?? '', bufferLine: leftIndex + 1 }));
      leftIndex += 1;
    }
    while (rightIndex < match[1]) {
      result.push(Object.freeze({ kind: 'added', text: right[rightIndex] ?? '', diskLine: rightIndex + 1 }));
      rightIndex += 1;
    }
    if (leftIndex < left.length && rightIndex < right.length) {
      result.push(Object.freeze({
        kind: 'unchanged',
        text: left[leftIndex] ?? '',
        bufferLine: leftIndex + 1,
        diskLine: rightIndex + 1
      }));
      leftIndex += 1;
      rightIndex += 1;
    }
    if (result.length % 1_000 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return Object.freeze(result);
}

function lines(source: string): readonly string[] {
  return source.split(/\r\n|\n|\r/u);
}

async function lineMatches(
  left: readonly string[],
  right: readonly string[],
  signal?: AbortSignal
): Promise<readonly (readonly [number, number])[]> {
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) {
    prefix += 1;
    if ((prefix & 0xfff) === 0) await checkpoint(signal);
  }
  let leftEnd = left.length;
  let rightEnd = right.length;
  while (leftEnd > prefix && rightEnd > prefix && left[leftEnd - 1] === right[rightEnd - 1]) {
    leftEnd -= 1;
    rightEnd -= 1;
    if (((left.length - leftEnd) & 0xfff) === 0) await checkpoint(signal);
  }
  const candidates = await matchCandidates(left, right, prefix, leftEnd, prefix, rightEnd, signal);
  const tails: number[] = [];
  const previous = new Array<number>(candidates.length).fill(-1);
  const indices: number[] = [];
  for (let index = 0; index < candidates.length; index += 1) {
    if ((index & 0xfff) === 0) await checkpoint(signal);
    const rightIndex = candidates[index]?.[1] ?? 0;
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if ((tails[middle] ?? 0) < rightIndex) low = middle + 1;
      else high = middle;
    }
    tails[low] = rightIndex;
    previous[index] = low === 0 ? -1 : indices[low - 1] ?? -1;
    indices[low] = index;
  }
  const middle: (readonly [number, number])[] = [];
  let index = indices[tails.length - 1] ?? -1;
  while (index >= 0) {
    const candidate = candidates[index];
    if (candidate !== undefined) middle.push(candidate);
    index = previous[index] ?? -1;
  }
  const result: (readonly [number, number])[] = Array.from(
    { length: prefix },
    (_, offset) => [offset, offset] as const
  );
  result.push(...middle.reverse());
  for (let offset = 0; offset < left.length - leftEnd; offset += 1) {
    result.push([leftEnd + offset, rightEnd + offset]);
  }
  return Object.freeze(result);
}

async function matchCandidates(
  left: readonly string[],
  right: readonly string[],
  leftStart: number,
  leftEnd: number,
  rightStart: number,
  rightEnd: number,
  signal?: AbortSignal
): Promise<readonly (readonly [number, number])[]> {
  const rightPositions = new Map<string, number[]>();
  for (let index = rightStart; index < rightEnd; index += 1) {
    const value = right[index] ?? '';
    const positions = rightPositions.get(value) ?? [];
    positions.push(index);
    rightPositions.set(value, positions);
    if ((index & 0xfff) === 0) await checkpoint(signal);
  }
  let pairCount = 0;
  const leftCounts = new Map<string, number>();
  for (let index = leftStart; index < leftEnd; index += 1) {
    const value = left[index] ?? '';
    leftCounts.set(value, (leftCounts.get(value) ?? 0) + 1);
    pairCount += rightPositions.get(value)?.length ?? 0;
    if ((index & 0xfff) === 0) await checkpoint(signal);
  }
  const bounded = pairCount <= 1_000_000;
  const candidates: (readonly [number, number])[] = [];
  for (let leftIndex = leftStart; leftIndex < leftEnd; leftIndex += 1) {
    const value = left[leftIndex] ?? '';
    const positions = rightPositions.get(value);
    if (positions !== undefined && (bounded || (positions.length === 1 && leftCounts.get(value) === 1))) {
      for (let offset = positions.length - 1; offset >= 0; offset -= 1) {
        const rightIndex = positions[offset];
        if (rightIndex !== undefined) candidates.push([leftIndex, rightIndex]);
      }
    }
    if ((leftIndex & 0xfff) === 0) await checkpoint(signal);
  }
  return candidates;
}

async function checkpoint(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve) => setImmediate(resolve));
  signal?.throwIfAborted();
}
