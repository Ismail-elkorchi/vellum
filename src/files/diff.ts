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
  const matches = patienceMatches(left, right);
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

function patienceMatches(left: readonly string[], right: readonly string[]): readonly (readonly [number, number])[] {
  const leftPositions = uniquePositions(left);
  const rightPositions = uniquePositions(right);
  const candidates = [...leftPositions].flatMap(([text, leftIndex]) => {
    const rightIndex = rightPositions.get(text);
    return rightIndex === undefined ? [] : [[leftIndex, rightIndex] as const];
  }).sort((first, second) => first[0] - second[0]);
  const tails: number[] = [];
  const previous = new Array<number>(candidates.length).fill(-1);
  const indices: number[] = [];
  for (let index = 0; index < candidates.length; index += 1) {
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
  const result: (readonly [number, number])[] = [];
  let index = indices[tails.length - 1] ?? -1;
  while (index >= 0) {
    const candidate = candidates[index];
    if (candidate !== undefined) result.push(candidate);
    index = previous[index] ?? -1;
  }
  return Object.freeze(result.reverse());
}

function uniquePositions(values: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  const positions = new Map<string, number>();
  values.forEach((value, index) => {
    counts.set(value, (counts.get(value) ?? 0) + 1);
    positions.set(value, index);
  });
  for (const [value, count] of counts) if (count !== 1) positions.delete(value);
  return positions;
}
