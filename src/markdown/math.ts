import { createHash } from 'node:crypto';
import { measureTextCells } from '@ismail-elkorchi/terminal-ui/text';

export interface MathRenderResult {
  readonly sourceHash: string;
  readonly text: string;
  readonly accessibleLabel: string;
}

export interface MathRenderer {
  render(source: string, signal?: AbortSignal): Promise<MathRenderResult>;
  clear(): void;
}

type MathNode =
  | { readonly kind: 'row'; readonly children: readonly MathNode[] }
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'fraction'; readonly numerator: MathNode; readonly denominator: MathNode }
  | { readonly kind: 'radical'; readonly value: MathNode }
  | { readonly kind: 'scripts'; readonly base: MathNode; readonly superscript?: MathNode; readonly subscript?: MathNode };

interface MathCanvas {
  readonly lines: readonly string[];
  readonly width: number;
  readonly baseline: number;
}

export class MathRenderError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'MathRenderError';
  }
}

const maximumMathSourceCodeUnits = 100_000;

export function createMathRenderer(): MathRenderer {
  const cache = new Map<string, MathRenderResult>();
  return Object.freeze({
    async render(source: string, signal?: AbortSignal) {
      signal?.throwIfAborted();
      if (source.length > maximumMathSourceCodeUnits) {
        throw new MathRenderError(`Math source exceeds ${String(maximumMathSourceCodeUnits)} UTF-16 code units.`);
      }
      const sourceHash = createHash('sha256').update(source).digest('hex');
      const cached = cache.get(sourceHash);
      if (cached !== undefined) return cached;
      await new Promise<void>((resolve) => setImmediate(resolve));
      signal?.throwIfAborted();
      const tree = await new LocalMathParser(source, signal).parse();
      const canvas = await layoutMath(tree, signal);
      const text = canvas.lines.map((line) => line.trimEnd()).join('\n').trimEnd();
      const result = Object.freeze({ sourceHash, text, accessibleLabel: `Math: ${source.trim()}` });
      cache.set(sourceHash, result);
      return result;
    },
    clear() {
      cache.clear();
    }
  });
}

class LocalMathParser {
  private offset = 0;
  private depth = 0;
  private readonly source: string;
  private readonly signal: AbortSignal | undefined;

  constructor(
    source: string,
    signal?: AbortSignal
  ) {
    this.source = source;
    this.signal = signal;
  }

  async parse(): Promise<MathNode> {
    const value = await this.row(false);
    if (this.offset !== this.source.length) throw new MathRenderError('Math source contains an unmatched closing brace.');
    return value;
  }

  private async row(group: boolean): Promise<MathNode> {
    this.depth += 1;
    if (this.depth > 256) throw new MathRenderError('Math group nesting exceeds 256 levels.');
    const children: MathNode[] = [];
    while (this.offset < this.source.length) {
      await this.checkpoint();
      if (this.source[this.offset] === '}') {
        if (!group) throw new MathRenderError('Math source contains an unmatched closing brace.');
        this.offset += 1;
        this.depth -= 1;
        return { kind: 'row', children };
      }
      if (/\s/u.test(this.source[this.offset] ?? '')) {
        while (/\s/u.test(this.source[this.offset] ?? '')) {
          this.offset += 1;
          await this.checkpoint();
        }
        if (children.length > 0 && this.offset < this.source.length && this.source[this.offset] !== '}') {
          appendMathNode(children, { kind: 'text', value: ' ' });
        }
        continue;
      }
      let node = await this.atom();
      let superscript: MathNode | undefined;
      let subscript: MathNode | undefined;
      while (this.source[this.offset] === '^' || this.source[this.offset] === '_') {
        const marker = this.source[this.offset];
        this.offset += 1;
        const script = await this.scriptArgument();
        if (marker === '^') {
          if (superscript !== undefined) throw new MathRenderError('A math atom cannot have two superscripts.');
          superscript = script;
        } else {
          if (subscript !== undefined) throw new MathRenderError('A math atom cannot have two subscripts.');
          subscript = script;
        }
      }
      if (superscript !== undefined || subscript !== undefined) {
        node = {
          kind: 'scripts',
          base: node,
          ...(superscript === undefined ? {} : { superscript }),
          ...(subscript === undefined ? {} : { subscript })
        };
      }
      appendMathNode(children, node);
    }
    if (group) throw new MathRenderError('A math group is not closed.');
    this.depth -= 1;
    return { kind: 'row', children };
  }

  private async atom(): Promise<MathNode> {
    const character = this.source[this.offset];
    if (character === '{') {
      this.offset += 1;
      return this.row(true);
    }
    if (character !== '\\') {
      this.offset += 1;
      return { kind: 'text', value: character ?? '' };
    }
    this.offset += 1;
    const escaped = this.source[this.offset];
    if (escaped !== undefined && !/[A-Za-z]/u.test(escaped)) {
      this.offset += 1;
      return { kind: 'text', value: escaped };
    }
    const start = this.offset;
    while (/[A-Za-z]/u.test(this.source[this.offset] ?? '')) {
      this.offset += 1;
      await this.checkpoint();
    }
    const command = this.source.slice(start, this.offset);
    if (command.length === 0) throw new MathRenderError('A math command name is missing.');
    if (command === 'frac') {
      return {
        kind: 'fraction',
        numerator: await this.requiredGroup('fraction numerator'),
        denominator: await this.requiredGroup('fraction denominator')
      };
    }
    if (command === 'sqrt') return { kind: 'radical', value: await this.requiredGroup('radical') };
    return { kind: 'text', value: commandSymbols[command] ?? `\\${command}` };
  }

  private async requiredGroup(label: string): Promise<MathNode> {
    while (/\s/u.test(this.source[this.offset] ?? '')) {
      this.offset += 1;
      await this.checkpoint();
    }
    if (this.source[this.offset] !== '{') throw new MathRenderError(`The ${label} must be enclosed in braces.`);
    this.offset += 1;
    return this.row(true);
  }

  private async scriptArgument(): Promise<MathNode> {
    while (/\s/u.test(this.source[this.offset] ?? '')) {
      this.offset += 1;
      await this.checkpoint();
    }
    if (this.offset >= this.source.length) throw new MathRenderError('A math script has no value.');
    if (this.source[this.offset] === '{') {
      this.offset += 1;
      return this.row(true);
    }
    return this.atom();
  }

  private async checkpoint(): Promise<void> {
    if ((this.offset & 0x3ff) !== 0) return;
    this.signal?.throwIfAborted();
    await new Promise<void>((resolve) => setImmediate(resolve));
    this.signal?.throwIfAborted();
  }
}

function appendMathNode(children: MathNode[], node: MathNode): void {
  const previous = children.at(-1);
  if (previous?.kind === 'text' && node.kind === 'text') {
    children[children.length - 1] = { kind: 'text', value: previous.value + node.value };
  } else children.push(node);
}

async function layoutMath(node: MathNode, signal?: AbortSignal): Promise<MathCanvas> {
  signal?.throwIfAborted();
  switch (node.kind) {
    case 'text':
      return canvas([node.value], 0);
    case 'row':
      return horizontal(await layoutMathChildren(node.children, signal));
    case 'radical': {
      const value = await layoutMath(node.value, signal);
      const line = '¯'.repeat(Math.max(1, value.width));
      return canvas([` ${line}`, ...value.lines.map((entry, index) => `${index === value.baseline ? '√' : ' '} ${entry}`)], value.baseline + 1);
    }
    case 'fraction': {
      const numerator = await layoutMath(node.numerator, signal);
      const denominator = await layoutMath(node.denominator, signal);
      const width = Math.max(1, numerator.width, denominator.width);
      return canvas([
        ...centerCanvas(numerator, width),
        '─'.repeat(width),
        ...centerCanvas(denominator, width)
      ], numerator.lines.length);
    }
    case 'scripts':
      return layoutScripts(node, signal);
  }
}

async function layoutMathChildren(children: readonly MathNode[], signal?: AbortSignal): Promise<readonly MathCanvas[]> {
  const values: MathCanvas[] = [];
  for (let index = 0; index < children.length; index += 1) {
    if ((index & 0xff) === 0) {
      signal?.throwIfAborted();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const child = children[index];
    if (child !== undefined) values.push(await layoutMath(child, signal));
  }
  return values;
}

async function layoutScripts(
  node: Extract<MathNode, { kind: 'scripts' }>,
  signal?: AbortSignal
): Promise<MathCanvas> {
  const base = await layoutMath(node.base, signal);
  const superText = node.superscript === undefined ? undefined : compactScript(node.superscript, superscriptCharacters);
  const subText = node.subscript === undefined ? undefined : compactScript(node.subscript, subscriptCharacters);
  if (superText !== undefined && (node.subscript === undefined || subText !== undefined)) {
    return canvas(base.lines.map((line, index) => (
      index === base.baseline ? line + superText + (subText ?? '') : line
    )), base.baseline);
  }
  const superscript = node.superscript === undefined ? undefined : await layoutMath(node.superscript, signal);
  const subscript = node.subscript === undefined ? undefined : await layoutMath(node.subscript, signal);
  const scriptWidth = Math.max(superscript?.width ?? 0, subscript?.width ?? 0);
  const lines = [
    ...padCanvas(superscript, scriptWidth).map((line) => ' '.repeat(base.width) + line),
    ...base.lines.map((line, index) => line + (index === base.baseline ? ' '.repeat(scriptWidth) : '')),
    ...padCanvas(subscript, scriptWidth).map((line) => ' '.repeat(base.width) + line)
  ];
  return canvas(lines, (superscript?.lines.length ?? 0) + base.baseline);
}

function horizontal(values: readonly MathCanvas[]): MathCanvas {
  if (values.length === 0) return canvas([''], 0);
  const baseline = Math.max(...values.map((value) => value.baseline));
  const below = Math.max(...values.map((value) => value.lines.length - value.baseline - 1));
  const chunks = Array.from({ length: baseline + below + 1 }, () => [] as string[]);
  for (const value of values) {
    const top = baseline - value.baseline;
    for (let row = 0; row < chunks.length; row += 1) {
      const source = value.lines[row - top];
      chunks[row]?.push(padTerminalCells(source ?? '', value.width));
    }
  }
  return canvas(chunks.map((line) => line.join('')), baseline);
}

function canvas(lines: readonly string[], baseline: number): MathCanvas {
  const width = Math.max(0, ...lines.map(terminalCellWidth));
  return Object.freeze({ lines: Object.freeze(lines.map((line) => padTerminalCells(line, width))), width, baseline });
}

function centerCanvas(value: MathCanvas, width: number): readonly string[] {
  const left = Math.floor((width - value.width) / 2);
  return value.lines.map((line) => `${' '.repeat(left)}${line}${' '.repeat(width - value.width - left)}`);
}

function padCanvas(value: MathCanvas | undefined, width: number): readonly string[] {
  return value === undefined ? Object.freeze([]) : value.lines.map((line) => padTerminalCells(line, width));
}

function terminalCellWidth(value: string): number {
  return measureTextCells(value).cells;
}

function padTerminalCells(value: string, width: number): string {
  return value + ' '.repeat(Math.max(0, width - terminalCellWidth(value)));
}

function compactScript(node: MathNode, mapping: Readonly<Record<string, string>>): string | undefined {
  if (node.kind !== 'text' && node.kind !== 'row') return undefined;
  const text = node.kind === 'text'
    ? node.value
    : node.children.map((child) => child.kind === 'text' ? child.value : '').join('');
  if (text.length === 0 || text.length > 1_024 || [...text].some((character) => mapping[character] === undefined)) return undefined;
  return [...text].map((character) => mapping[character] ?? character).join('');
}

const superscriptCharacters: Readonly<Record<string, string>> = Object.freeze({
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹',
  '+': '⁺', '-': '⁻', '=': '⁼', '(': '⁽', ')': '⁾', n: 'ⁿ', i: 'ⁱ'
});

const subscriptCharacters: Readonly<Record<string, string>> = Object.freeze({
  '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉',
  '+': '₊', '-': '₋', '=': '₌', '(': '₍', ')': '₎', a: 'ₐ', e: 'ₑ', i: 'ᵢ', o: 'ₒ', r: 'ᵣ', u: 'ᵤ', v: 'ᵥ', x: 'ₓ'
});

const commandSymbols: Readonly<Record<string, string>> = Object.freeze({
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', theta: 'θ', lambda: 'λ', mu: 'μ', pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ', phi: 'φ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Pi: 'Π', Sigma: 'Σ', Phi: 'Φ', Omega: 'Ω',
  times: '×', cdot: '·', div: '÷', pm: '±', mp: '∓', leq: '≤', geq: '≥', neq: '≠', approx: '≈', equiv: '≡',
  infty: '∞', partial: '∂', nabla: '∇', sum: '∑', prod: '∏', int: '∫', in: '∈', notin: '∉', subset: '⊂', supset: '⊃',
  leftarrow: '←', rightarrow: '→', Leftrightarrow: '⇔', forall: '∀', exists: '∃', neg: '¬', land: '∧', lor: '∨'
});
