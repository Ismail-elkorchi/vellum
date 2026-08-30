import type { RenderSpan } from '@ismail-elkorchi/terminal-ui/renderer';
import type { MarkdownImageNode } from 'markspan';
import type { MarkdownTheme } from '../theme.js';
import { image as terminalImage, type Element, type RasterImage } from '@ismail-elkorchi/terminal-ui';
import type { MarkdownRenderSpan } from './inline.js';
import type { MarkdownImageResult } from '../image-loader.js';

export interface MarkdownRenderMedia {
  readonly image: RasterImage;
  readonly label: string;
  readonly sourceSpan: MarkdownImageNode['span'];
}

interface MarkdownPreviewImageSize {
  readonly width: number;
  readonly height: number;
}

export function imagePreviewSpan(
  node: MarkdownImageNode,
  altText: string,
  theme: MarkdownTheme,
  result?: MarkdownImageResult
): MarkdownRenderSpan {
  const accessibleLabel = altText.trim().length === 0 ? 'Markdown image' : altText.trim();
  if (result?.kind === 'ready') {
    return Object.freeze({
      text: '',
      nodeId: node.id,
      sourceSpan: node.span,
      sourceMapping: 'anchor',
      media: Object.freeze({
        image: result.image,
        label: node.title === null ? accessibleLabel : `${accessibleLabel} — ${node.title}`,
        sourceSpan: node.span,
      }),
    });
  }
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
    sourceMapping: 'anchor',
  });
}

export function previewImageSize(
  image: RasterImage,
  maximumWidth: number,
  maximumHeight: number,
  fallbackWidth: number,
): MarkdownPreviewImageSize {
  const widthLimit = Math.max(1, Math.floor(maximumWidth));
  const heightLimit = Math.max(1, Math.floor(maximumHeight));
  const scale = Math.min(1, widthLimit / image.width, heightLimit / image.height);
  const imageWidth = Math.max(1, Math.floor(image.width * scale));
  return Object.freeze({
    width: Math.min(widthLimit, Math.max(imageWidth, Math.floor(fallbackWidth))),
    height: Math.max(1, Math.min(heightLimit, Math.floor(image.height * scale))),
  });
}

export function localImageComponent(
  image: RasterImage,
  altText: string,
  size: MarkdownPreviewImageSize,
): Element<never> {
  const label = altText.trim().length === 0 ? 'Markdown image' : altText;
  return terminalImage({
    image,
    label,
    fallback: `[Image: ${label}]`,
    measurement: Object.freeze({
      minWidth: 1,
      preferredWidth: size.width,
      maxWidth: size.width,
      minHeight: 1,
      preferredHeight: size.height,
      maxHeight: size.height,
    }),
    fit: 'contain'
  });
}
