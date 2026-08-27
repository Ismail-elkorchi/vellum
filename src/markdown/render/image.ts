import type { RenderSpan } from '@ismail-elkorchi/terminal-ui/renderer';
import type { MarkdownImageNode } from 'markspan';
import type { MarkdownTheme } from '../theme.js';
import { image as terminalImage, type Element, type RasterImage } from '@ismail-elkorchi/terminal-ui';
import type { MarkdownRenderSpan } from './inline.js';
import type { MarkdownImageResult } from '../image-loader.js';

export function imageFallbackSpan(
  node: MarkdownImageNode,
  altText: string,
  theme: MarkdownTheme,
  result?: MarkdownImageResult
): MarkdownRenderSpan {
  const label = altText.length === 0 ? 'Image' : `Image: ${altText}`;
  const title = node.title === null ? '' : ` — ${node.title}`;
  const failure = result?.kind === 'failed' ? ` — failed: ${result.message}` : '';
  const span: RenderSpan = {
    text: `[${label}${title}${failure}]`,
    style: theme.imageLabel,
    ...(node.destination.length === 0 ? {} : { link: { href: node.destination } })
  };
  return Object.freeze({
    ...span,
    nodeId: node.id,
    sourceSpan: node.span,
    activation: Object.freeze({ kind: 'image', nodeId: node.id, destination: node.destination })
  });
}

export function localImageComponent(
  image: RasterImage,
  altText: string,
  maximumWidth: number,
  maximumHeight: number
): Element<never> {
  const label = altText.trim().length === 0 ? 'Markdown image' : altText;
  return terminalImage({
    image,
    label,
    fallback: `[Image: ${label}]`,
    measurement: Object.freeze({
      minWidth: 1,
      preferredWidth: Math.max(1, Math.min(maximumWidth, image.width)),
      maxWidth: Math.max(1, maximumWidth),
      minHeight: 1,
      preferredHeight: Math.max(1, Math.min(maximumHeight, image.height)),
      maxHeight: Math.max(1, maximumHeight)
    }),
    fit: 'contain'
  });
}
