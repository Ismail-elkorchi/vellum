import { createHash } from 'node:crypto';
import { open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { crc32, inflateSync } from 'node:zlib';
import { rasterImage, type RasterImage } from '@ismail-elkorchi/terminal-ui';

export interface MarkdownImageSettings {
  readonly remoteImages: boolean;
  readonly requestTimeoutMilliseconds: number;
  readonly maximumEncodedBytes: number;
  readonly maximumWidth: number;
  readonly maximumHeight: number;
}

export type MarkdownImageResult =
  | { readonly kind: 'ready'; readonly image: RasterImage; readonly source: string }
  | { readonly kind: 'failed'; readonly message: string; readonly source: string };

interface RemoteCacheEntry {
  readonly etag?: string;
  readonly lastModified?: string;
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

export interface MarkdownImageLoader {
  load(destination: string, sourceDocumentPath: string | undefined, signal?: AbortSignal): Promise<MarkdownImageResult>;
  decode(bytes: Uint8Array, source: string, contentType: string): MarkdownImageResult;
  clear(): void;
}

const defaults: MarkdownImageSettings = Object.freeze({
  remoteImages: false,
  requestTimeoutMilliseconds: 5_000,
  maximumEncodedBytes: 10_000_000,
  maximumWidth: 4_096,
  maximumHeight: 4_096
});

export function createMarkdownImageLoader(
  settings: Partial<MarkdownImageSettings> = {}
): MarkdownImageLoader {
  const configuration = resolveSettings(settings);
  const decoded = new Map<string, RasterImage>();
  const remote = new Map<string, RemoteCacheEntry>();
  return Object.freeze({
    async load(destination: string, sourceDocumentPath: string | undefined, signal?: AbortSignal) {
      signal?.throwIfAborted();
      try {
        const url = URL.parse(destination);
        if (url?.protocol === 'http:' || url?.protocol === 'https:') {
          if (!configuration.remoteImages) {
            return Object.freeze({ kind: 'failed', message: 'Remote image loading is disabled.', source: destination });
          }
          const result = await fetchRemote(url, configuration, remote, signal);
          return ready(result.bytes, destination, result.contentType, configuration, decoded);
        }
        if (sourceDocumentPath === undefined && !path.isAbsolute(destination)) {
          return Object.freeze({ kind: 'failed', message: 'A relative image requires a saved source document.', source: destination });
        }
        const requested = path.isAbsolute(destination)
          ? destination
          : path.resolve(path.dirname(sourceDocumentPath as string), destination);
        const resolved = await realpath(requested);
        const bytes = await readBoundedFile(resolved, configuration.maximumEncodedBytes, signal);
        return ready(bytes, resolved, mimeFromPath(resolved), configuration, decoded);
      } catch (error) {
        if (signal?.aborted === true) throw signal.reason;
        return Object.freeze({
          kind: 'failed',
          message: error instanceof Error ? error.message : String(error),
          source: destination
        });
      }
    },
    decode(bytes: Uint8Array, source: string, contentType: string) {
      try {
        return ready(bytes, source, contentType, configuration, decoded);
      } catch (error) {
        return Object.freeze({
          kind: 'failed',
          message: error instanceof Error ? error.message : String(error),
          source
        });
      }
    },
    clear() {
      decoded.clear();
      remote.clear();
    }
  });
}

function ready(
  bytes: Uint8Array,
  source: string,
  contentType: string,
  settings: MarkdownImageSettings,
  cache: Map<string, RasterImage>
): MarkdownImageResult {
  if (bytes.length > settings.maximumEncodedBytes) {
    throw new Error('Encoded image exceeds the configured size limit.');
  }
  const key = createHash('sha256').update(bytes).digest('hex');
  let image = cache.get(key);
  if (image === undefined) {
    const decoded = decodeImage(bytes, contentType, settings);
    image = rasterImage(decoded);
    cache.set(key, image);
  }
  return Object.freeze({ kind: 'ready', image, source });
}

async function fetchRemote(
  url: URL,
  settings: MarkdownImageSettings,
  cache: Map<string, RemoteCacheEntry>,
  signal?: AbortSignal
): Promise<RemoteCacheEntry> {
  const previous = cache.get(url.href);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('Image request timed out.')), settings.requestTimeoutMilliseconds);
  const abort = (): void => controller.abort(signal?.reason);
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const headers = new Headers();
    if (previous?.etag !== undefined) headers.set('If-None-Match', previous.etag);
    if (previous?.lastModified !== undefined) headers.set('If-Modified-Since', previous.lastModified);
    const response = await fetch(url, { signal: controller.signal, headers, redirect: 'follow' });
    if (response.status === 304 && previous !== undefined) return previous;
    if (!response.ok) throw new Error(`Image request failed with status ${String(response.status)}.`);
    const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
    if (!['image/png', 'image/x-portable-pixmap'].includes(contentType)) {
      throw new Error(`Unsupported remote image content type: ${contentType || 'missing'}.`);
    }
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > settings.maximumEncodedBytes) {
      throw new Error('Remote image exceeds the configured size limit.');
    }
    if (response.body === null) throw new Error('Remote image response has no body.');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.length;
      if (length > settings.maximumEncodedBytes) {
        await reader.cancel();
        throw new Error('Remote image exceeds the configured size limit.');
      }
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const entry: RemoteCacheEntry = Object.freeze({
      bytes,
      contentType,
      ...(response.headers.get('etag') === null ? {} : { etag: response.headers.get('etag') as string }),
      ...(response.headers.get('last-modified') === null ? {} : { lastModified: response.headers.get('last-modified') as string })
    });
    cache.set(url.href, entry);
    return entry;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

function mimeFromPath(value: string): string {
  return path.extname(value).toLowerCase() === '.ppm' ? 'image/x-portable-pixmap' : 'image/png';
}

function decodeImage(
  bytes: Uint8Array,
  contentType: string,
  settings: MarkdownImageSettings
): { readonly width: number; readonly height: number; readonly format: 'rgba8'; readonly data: Uint8Array } {
  return contentType === 'image/x-portable-pixmap'
    ? decodePpm(bytes, settings)
    : decodePng(bytes, settings);
}

function decodePpm(
  bytes: Uint8Array,
  settings: MarkdownImageSettings
): { readonly width: number; readonly height: number; readonly format: 'rgba8'; readonly data: Uint8Array } {
  let offset = 0;
  const token = (): string => {
    while (offset < bytes.length) {
      if (bytes[offset] === 35) while (offset < bytes.length && bytes[offset] !== 10) offset += 1;
      if ((bytes[offset] ?? 0) > 32) break;
      offset += 1;
    }
    const start = offset;
    while (offset < bytes.length && (bytes[offset] ?? 0) > 32) offset += 1;
    return new TextDecoder().decode(bytes.subarray(start, offset));
  };
  if (token() !== 'P6') throw new Error('Only binary PPM images are supported.');
  const width = Number(token());
  const height = Number(token());
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || token() !== '255') {
    throw new Error('Invalid PPM header.');
  }
  assertImageDimensions(width, height, settings);
  if ((bytes[offset] ?? 0) > 32 || offset >= bytes.length) throw new Error('Invalid PPM header separator.');
  offset += 1;
  const rgb = bytes.subarray(offset);
  if (rgb.length !== width * height * 3) throw new Error('Invalid PPM pixel length.');
  const rgba = new Uint8Array(width * height * 4);
  for (let input = 0, output = 0; input < rgb.length; input += 3, output += 4) {
    rgba[output] = rgb[input] ?? 0;
    rgba[output + 1] = rgb[input + 1] ?? 0;
    rgba[output + 2] = rgb[input + 2] ?? 0;
    rgba[output + 3] = 255;
  }
  return Object.freeze({ width, height, format: 'rgba8', data: rgba });
}

function decodePng(
  bytes: Uint8Array,
  settings: MarkdownImageSettings
): { readonly width: number; readonly height: number; readonly format: 'rgba8'; readonly data: Uint8Array } {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!signature.every((value, index) => bytes[index] === value)) throw new Error('Unsupported image format.');
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = -1;
  let headerSeen = false;
  let endSeen = false;
  const compressed: Uint8Array[] = [];
  while (offset + 12 <= bytes.length) {
    const length = readUint32(bytes, offset);
    if (length > bytes.length - offset - 12) throw new Error('Invalid PNG chunk length.');
    const kind = new TextDecoder().decode(bytes.subarray(offset + 4, offset + 8));
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    const expectedChecksum = readUint32(bytes, offset + 8 + length);
    const actualChecksum = crc32(bytes.subarray(offset + 4, offset + 8 + length));
    if (actualChecksum !== expectedChecksum) throw new Error(`Invalid PNG ${kind} checksum.`);
    if (kind === 'IHDR') {
      if (headerSeen || length !== 13 || offset !== 8) throw new Error('Invalid PNG header chunk.');
      headerSeen = true;
      width = readUint32(data, 0);
      height = readUint32(data, 4);
      if (data[8] !== 8 || data[12] !== 0) throw new Error('Only 8-bit non-interlaced PNG images are supported.');
      colorType = data[9] ?? -1;
    } else if (kind === 'IDAT') {
      if (!headerSeen) throw new Error('PNG image data precedes its header.');
      compressed.push(data);
    }
    else if (kind === 'IEND') {
      if (length !== 0) throw new Error('Invalid PNG end chunk.');
      endSeen = true;
      break;
    }
    offset += length + 12;
  }
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 6 ? 4 : 0;
  if (!headerSeen || !endSeen || compressed.length === 0 || width < 1 || height < 1 || channels === 0) {
    throw new Error('Invalid or unsupported PNG image.');
  }
  assertImageDimensions(width, height, settings);
  const stride = width * channels;
  const expectedInflatedLength = (stride + 1) * height;
  const input = inflateSync(Buffer.concat(compressed.map((value) => Buffer.from(value))), {
    maxOutputLength: expectedInflatedLength
  });
  if (input.length !== expectedInflatedLength) throw new Error('Invalid PNG scanline length.');
  const raw = new Uint8Array(stride * height);
  for (let row = 0; row < height; row += 1) {
    const filter = input[row * (stride + 1)] ?? 0;
    for (let column = 0; column < stride; column += 1) {
      const encoded = input[row * (stride + 1) + column + 1] ?? 0;
      const left = column < channels ? 0 : raw[row * stride + column - channels] ?? 0;
      const above = row === 0 ? 0 : raw[(row - 1) * stride + column] ?? 0;
      const upperLeft = row === 0 || column < channels ? 0 : raw[(row - 1) * stride + column - channels] ?? 0;
      raw[row * stride + column] = unfilter(filter, encoded, left, above, upperLeft);
    }
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const inputOffset = pixel * channels;
    const outputOffset = pixel * 4;
    if (colorType === 0 || colorType === 4) {
      rgba[outputOffset] = raw[inputOffset] ?? 0;
      rgba[outputOffset + 1] = raw[inputOffset] ?? 0;
      rgba[outputOffset + 2] = raw[inputOffset] ?? 0;
      rgba[outputOffset + 3] = colorType === 4 ? raw[inputOffset + 1] ?? 255 : 255;
    } else {
      rgba[outputOffset] = raw[inputOffset] ?? 0;
      rgba[outputOffset + 1] = raw[inputOffset + 1] ?? 0;
      rgba[outputOffset + 2] = raw[inputOffset + 2] ?? 0;
      rgba[outputOffset + 3] = colorType === 6 ? raw[inputOffset + 3] ?? 255 : 255;
    }
  }
  return Object.freeze({ width, height, format: 'rgba8', data: rgba });
}

function assertImageDimensions(width: number, height: number, settings: MarkdownImageSettings): void {
  if (width > settings.maximumWidth || height > settings.maximumHeight) {
    throw new Error('Decoded image dimensions exceed the configured limits.');
  }
}

function resolveSettings(settings: Partial<MarkdownImageSettings>): MarkdownImageSettings {
  const value = Object.freeze({ ...defaults, ...settings });
  if (typeof value.remoteImages !== 'boolean') throw new TypeError('remoteImages must be boolean.');
  for (const key of ['requestTimeoutMilliseconds', 'maximumEncodedBytes', 'maximumWidth', 'maximumHeight'] as const) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 1) {
      throw new RangeError(`${key} must be a positive integer.`);
    }
  }
  return value;
}

async function readBoundedFile(
  filePath: string,
  maximumBytes: number,
  signal?: AbortSignal
): Promise<Uint8Array> {
  signal?.throwIfAborted();
  const handle = await open(filePath, 'r');
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error(`Image path is not a file: ${filePath}`);
    if (metadata.size > maximumBytes) throw new Error('Encoded image exceeds the configured size limit.');
    const bytes = Buffer.alloc(metadata.size);
    let offset = 0;
    while (offset < bytes.length) {
      signal?.throwIfAborted();
      const read = await handle.read(bytes, offset, Math.min(65_536, bytes.length - offset), offset);
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    const extra = Buffer.alloc(1);
    if ((await handle.read(extra, 0, 1, offset)).bytesRead > 0) {
      throw new Error('Encoded image changed while it was being read or exceeds the configured size limit.');
    }
    signal?.throwIfAborted();
    return new Uint8Array(bytes.subarray(0, offset));
  } finally {
    await handle.close();
  }
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) * 0x1000000)
    + ((bytes[offset + 1] ?? 0) << 16)
    + ((bytes[offset + 2] ?? 0) << 8)
    + (bytes[offset + 3] ?? 0);
}

function unfilter(filter: number, encoded: number, left: number, above: number, upperLeft: number): number {
  if (filter === 0) return encoded;
  if (filter === 1) return (encoded + left) & 255;
  if (filter === 2) return (encoded + above) & 255;
  if (filter === 3) return (encoded + Math.floor((left + above) / 2)) & 255;
  if (filter === 4) return (encoded + paeth(left, above, upperLeft)) & 255;
  throw new Error(`Unsupported PNG filter: ${String(filter)}.`);
}

function paeth(left: number, above: number, upperLeft: number): number {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  return leftDistance <= aboveDistance && leftDistance <= upperLeftDistance ? left : aboveDistance <= upperLeftDistance ? above : upperLeft;
}
