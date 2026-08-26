import { createHash } from 'node:crypto';

export interface MathRenderResult {
  readonly sourceHash: string;
  readonly text: string;
  readonly accessibleLabel: string;
}

export interface MathRenderer {
  render(source: string, signal?: AbortSignal): Promise<MathRenderResult>;
  clear(): void;
}

const superscript: Readonly<Record<string, string>> = Object.freeze({
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '+': '⁺', '-': '⁻'
});

export function createMathRenderer(): MathRenderer {
  const cache = new Map<string, MathRenderResult>();
  return Object.freeze({
    async render(source: string, signal?: AbortSignal) {
      signal?.throwIfAborted();
      const sourceHash = createHash('sha256').update(source).digest('hex');
      const cached = cache.get(sourceHash);
      if (cached !== undefined) return cached;
      await new Promise<void>((resolve) => setImmediate(resolve));
      signal?.throwIfAborted();
      const text = localMathText(source);
      const result = Object.freeze({ sourceHash, text, accessibleLabel: `Math: ${source.trim()}` });
      cache.set(sourceHash, result);
      return result;
    },
    clear() {
      cache.clear();
    }
  });
}

function localMathText(source: string): string {
  const normalized = source
    .replaceAll(/\\times\b/gu, '×')
    .replaceAll(/\\cdot\b/gu, '·')
    .replaceAll(/\\leq\b/gu, '≤')
    .replaceAll(/\\geq\b/gu, '≥')
    .replaceAll(/\\neq\b/gu, '≠')
    .replaceAll(/\\infty\b/gu, '∞')
    .replaceAll(/\\sqrt\{([^{}]+)\}/gu, '√($1)')
    .replaceAll(/\\frac\{([^{}]+)\}\{([^{}]+)\}/gu, '($1)/($2)');
  return normalized.replaceAll(/\^\{?([0-9+-]+)\}?/gu, (_match, exponent: string) => (
    [...exponent].map((value) => superscript[value] ?? value).join('')
  ));
}
