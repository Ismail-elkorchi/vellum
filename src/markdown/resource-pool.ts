import {
  builtInCodeHighlightLanguages,
  createCodeHighlighter,
  type CodeHighlighter,
  type CodeHighlightLanguage,
  type CodeHighlightSettings
} from './highlight.js';
import { createMathRenderer, type MathRenderer, type MathRenderProvider, type MathRenderSettings } from './math.js';
import {
  createDiagramRendererRegistry,
  type DiagramRendererDefinition,
  type DiagramRendererRegistry,
  type DiagramRenderSettings
} from './diagram.js';
import {
  createMarkdownImageLoader,
  type MarkdownImageLoader,
  type MarkdownImageSettings
} from './image-loader.js';

export interface PreviewResourcePoolOptions {
  readonly highlightLanguages?: readonly CodeHighlightLanguage[];
  readonly highlightSettings?: Partial<CodeHighlightSettings>;
  readonly mathSettings?: Partial<MathRenderSettings>;
  readonly mathProviders?: readonly MathRenderProvider[];
  readonly diagramRenderers?: readonly DiagramRendererDefinition[];
  readonly diagramSettings?: Partial<DiagramRenderSettings>;
  readonly imageSettings?: Partial<MarkdownImageSettings>;
}

export interface PreviewResourcePoolStats {
  readonly highlighting: ReturnType<CodeHighlighter['stats']>;
  readonly math: ReturnType<MathRenderer['stats']>;
  readonly diagrams: ReturnType<DiagramRendererRegistry['stats']>;
  readonly images: ReturnType<MarkdownImageLoader['stats']>;
}

export interface PreviewResourcePool {
  readonly highlighter: CodeHighlighter;
  readonly mathRenderer: MathRenderer;
  readonly diagramRenderers: DiagramRendererRegistry;
  readonly imageLoader: MarkdownImageLoader;
  stats(): PreviewResourcePoolStats;
  clear(): void;
}

export function createPreviewResourcePool(options: PreviewResourcePoolOptions = {}): PreviewResourcePool {
  const highlighter = createCodeHighlighter(
    options.highlightLanguages ?? builtInCodeHighlightLanguages(),
    options.highlightSettings
  );
  const mathRenderer = createMathRenderer(options.mathSettings, options.mathProviders);
  const diagramRenderers = createDiagramRendererRegistry(options.diagramRenderers ?? [], options.diagramSettings);
  const imageLoader = createMarkdownImageLoader(options.imageSettings);
  return Object.freeze({
    highlighter,
    mathRenderer,
    diagramRenderers,
    imageLoader,
    stats() {
      return Object.freeze({
        highlighting: highlighter.stats(),
        math: mathRenderer.stats(),
        diagrams: diagramRenderers.stats(),
        images: imageLoader.stats()
      });
    },
    clear() {
      highlighter.clear();
      mathRenderer.clear();
      diagramRenderers.clear();
      imageLoader.clear();
    }
  });
}
