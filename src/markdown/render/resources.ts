import type { MarkdownImageResult } from '../image-loader.js';
import type { HighlightedCode } from './code.js';
import type { MarkdownDiagnostic } from 'markspan';

export interface MarkdownBlockResources {
  readonly highlightedCode?: ReadonlyMap<number, HighlightedCode>;
  readonly mathText?: ReadonlyMap<number, string>;
  readonly diagramText?: ReadonlyMap<number, string>;
  readonly images?: ReadonlyMap<number, MarkdownImageResult>;
  readonly diagnostics?: readonly MarkdownDiagnostic[];
}
