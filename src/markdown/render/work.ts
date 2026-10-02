import { setImmediate } from 'node:timers/promises';

/** Shared resumable Markdown work used by interactive preparation and headless rendering. */
export type MarkdownRenderWork<Value> = Generator<void, Value, void>;

export interface MarkdownRenderPreparationOptions {
  readonly signal?: AbortSignal;
  readonly yieldControl?: () => Promise<void>;
}

export function finishMarkdownRender<Value>(work: MarkdownRenderWork<Value>): Value {
  let result = work.next();
  while (!result.done) result = work.next();
  return result.value;
}

/** Resume bounded work batches on real event-loop turns so input and cancellation can run. */
export async function prepareMarkdownRender<Value>(
  work: MarkdownRenderWork<Value>,
  options: MarkdownRenderPreparationOptions = {},
): Promise<Value> {
  const yieldControl = options.yieldControl ?? (() => setImmediate());
  try {
    options.signal?.throwIfAborted();
    // Allocation observers return before preparation starts, including cache hits.
    await yieldControl();
    for (;;) {
      options.signal?.throwIfAborted();
      const deadline = performance.now() + 8;
      for (let count = 0; count < 2048; count += 1) {
        const result = work.next();
        if (result.done) return result.value;
        if (count % 64 === 0 && performance.now() >= deadline) break;
      }
      await yieldControl();
    }
  } finally {
    work.return(undefined as never);
  }
}
