/**
 * Antigravity (Cloud Code `streamGenerateContent`) rejects a remote image part.
 *
 * The OpenAI → Gemini translator turns an `image_url` part that carries an `http(s)` URL into
 * `fileData: { fileUri, mimeType: "image/*" }` (geminiHelper.ts; claude-to-gemini.ts does the
 * same for a Claude URL image source). Antigravity refuses that wildcard type with HTTP 400:
 *
 *   Unsupported mime type: image/* in contents.file_data. Only image/*, text/*, video/*,
 *   audio/*, and document MIME types are supported.
 *
 * so every request that sends an image by URL fails, while the same image sent as a base64
 * data URI (which becomes `inlineData` with a concrete type) succeeds. This module downloads
 * each remote image once, through the SSRF-hardened `fetchUntrustedRemoteImage` (public hosts
 * only, DNS pinned), and swaps the part for `inlineData` with the image's real MIME type.
 *
 * Antigravity also caps the whole request at roughly 20 MB, and base64 inflates each image by a
 * third. Campaign-style requests routinely attach several multi-megabyte photos (one failure
 * carried 3 × 5 MB JPEGs plus a 19 MB PNG), so an image larger than its share of the budget is
 * downscaled and re-encoded with sharp before it is inlined. Images within budget are sent
 * byte-for-byte.
 */
import { fetchUntrustedRemoteImage } from "@/shared/network/remoteImageFetch";
import { sniffCursorImageFormat } from "../../utils/cursorImages.ts";

/** Per-image download cap. Larger downloads are shrunk to fit the inline budget below. */
export const ANTIGRAVITY_MAX_REMOTE_IMAGE_BYTES = 50 * 1024 * 1024;
/** Raw bytes shared by all inlined remote images (≈16 MB once base64-encoded). */
export const ANTIGRAVITY_INLINE_IMAGE_BUDGET_BYTES = 12 * 1024 * 1024;
const MAX_PER_IMAGE_BYTES = 4 * 1024 * 1024;
const MIN_PER_IMAGE_BYTES = 512 * 1024;
const ANTIGRAVITY_REMOTE_IMAGE_TIMEOUT_MS = 30_000;
/** Downscale steps tried in order until the re-encoded image fits its byte target. */
const SHRINK_STEPS = [
  { longEdge: 3072, quality: 88 },
  { longEdge: 2048, quality: 85 },
  { longEdge: 1536, quality: 80 },
  { longEdge: 1024, quality: 75 },
];

type SharpFactory = (typeof import("sharp"))["default"];
let sharpPromise: Promise<SharpFactory | null> | null = null;
function loadSharp(): Promise<SharpFactory | null> {
  sharpPromise ??= import("sharp")
    .then((module) => (module.default ?? module) as SharpFactory)
    .catch(() => null);
  return sharpPromise;
}

type FetchImage = typeof fetchUntrustedRemoteImage;

export class AntigravityRemoteImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AntigravityRemoteImageError";
  }
}

interface InlineImage {
  mimeType: string;
  data: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A `fileData` part that points at an `http(s)` image, which Antigravity cannot take. */
function remoteImageUri(part: unknown): string | null {
  const fileData = asRecord(asRecord(part)?.fileData);
  if (!fileData) return null;
  const uri = fileData.fileUri;
  if (typeof uri !== "string" || !/^https?:\/\//i.test(uri)) return null;
  const mime = typeof fileData.mimeType === "string" ? fileData.mimeType.trim() : "";
  if (mime && !mime.toLowerCase().startsWith("image/")) return null;
  return uri;
}

/** A concrete `image/<subtype>` from a Content-Type header, or null for a wildcard/non-image. */
function concreteImageType(contentType: string): string | null {
  const type = contentType.split(";")[0].trim().toLowerCase();
  if (!type.startsWith("image/")) return null;
  const subtype = type.slice("image/".length);
  if (!subtype || subtype.includes("*")) return null;
  return type;
}

/**
 * Re-encode an image that is larger than `targetBytes`: resize to fit a long edge and encode as
 * JPEG (WebP when it has transparency). Returns null when sharp is unavailable or no step fits.
 */
async function shrinkImage(buffer: Buffer, targetBytes: number): Promise<InlineImage | null> {
  const sharp = await loadSharp();
  if (!sharp) return null;
  try {
    const meta = await sharp(buffer, { failOn: "error" }).metadata();
    const hasAlpha = meta.hasAlpha === true;
    for (const step of SHRINK_STEPS) {
      const pipeline = sharp(buffer, { failOn: "error" }).rotate().resize({
        width: step.longEdge,
        height: step.longEdge,
        fit: "inside",
        withoutEnlargement: true,
      });
      const out = hasAlpha
        ? await pipeline.webp({ quality: step.quality }).toBuffer()
        : await pipeline.jpeg({ quality: step.quality, mozjpeg: true }).toBuffer();
      if (out.byteLength <= targetBytes) {
        return { mimeType: hasAlpha ? "image/webp" : "image/jpeg", data: out.toString("base64") };
      }
    }
  } catch {
    // A decode failure falls through to the caller's "too large" error.
  }
  return null;
}

function tooLargeError(): AntigravityRemoteImageError {
  return new AntigravityRemoteImageError(
    "The image URL is too large for Antigravity. Send smaller images (under " +
      `${Math.round(ANTIGRAVITY_INLINE_IMAGE_BUDGET_BYTES / (1024 * 1024))} MB in total).`
  );
}

async function downloadInlineImage(
  uri: string,
  fetchImage: FetchImage,
  signal: AbortSignal | undefined,
  targetBytes: number
): Promise<InlineImage> {
  let result: Awaited<ReturnType<FetchImage>>;
  try {
    result = await fetchImage(uri, {
      maxBytes: ANTIGRAVITY_MAX_REMOTE_IMAGE_BYTES,
      timeoutMs: ANTIGRAVITY_REMOTE_IMAGE_TIMEOUT_MS,
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof Error && /byte limit/i.test(error.message)) throw tooLargeError();
    throw new AntigravityRemoteImageError(
      "Could not download the image URL for Antigravity. Use a publicly reachable image URL " +
        "or send the image as a base64 data URI."
    );
  }
  const sniffed = sniffCursorImageFormat(result.buffer);
  const mimeType = sniffed ? `image/${sniffed}` : concreteImageType(result.contentType);
  if (!mimeType) {
    throw new AntigravityRemoteImageError(
      "The image URL did not return a recognizable image (PNG, JPEG, GIF or WebP)."
    );
  }
  if (result.buffer.byteLength <= targetBytes) {
    return { mimeType, data: result.buffer.toString("base64") };
  }
  const shrunk = await shrinkImage(result.buffer, targetBytes);
  if (!shrunk) throw tooLargeError();
  return shrunk;
}

// The executor rebuilds the request once per fallback base URL from the same client body;
// keying the downloads on that body means each image is fetched once per request, not per URL.
const downloadsByBody = new WeakMap<object, Map<string, Promise<InlineImage>>>();

/**
 * Replace every remote-image `fileData` part in `contents` with base64 `inlineData`.
 * Returns new content/part objects; the input is not mutated. Throws
 * `AntigravityRemoteImageError` when an image cannot be fetched or is not an image.
 */
export async function inlineAntigravityRemoteImages<T extends { parts: unknown[] }>(
  contents: T[],
  options: { signal?: AbortSignal; cacheKey?: object; fetchImage?: FetchImage } = {}
): Promise<T[]> {
  const uris = new Set<string>();
  for (const content of contents) {
    for (const part of content.parts) {
      const uri = remoteImageUri(part);
      if (uri) uris.add(uri);
    }
  }
  if (uris.size === 0) return contents;

  const fetchImage = options.fetchImage ?? fetchUntrustedRemoteImage;
  let downloads = options.cacheKey ? downloadsByBody.get(options.cacheKey) : undefined;
  if (!downloads) {
    downloads = new Map();
    if (options.cacheKey) downloadsByBody.set(options.cacheKey, downloads);
  }
  // Each remote image gets an equal share of the inline budget.
  const targetBytes = Math.max(
    MIN_PER_IMAGE_BYTES,
    Math.min(MAX_PER_IMAGE_BYTES, Math.floor(ANTIGRAVITY_INLINE_IMAGE_BUDGET_BYTES / uris.size))
  );
  for (const uri of uris) {
    if (!downloads.has(uri)) {
      const pending = downloadInlineImage(uri, fetchImage, options.signal, targetBytes);
      // Do not keep a failed download around for the next fallback URL to reuse.
      pending.catch(() => downloads.delete(uri));
      downloads.set(uri, pending);
    }
  }
  const resolved = new Map<string, InlineImage>();
  await Promise.all([...uris].map(async (uri) => resolved.set(uri, await downloads.get(uri)!)));

  return contents.map((content) => {
    if (!content.parts.some((part) => remoteImageUri(part))) return content;
    return {
      ...content,
      parts: content.parts.map((part) => {
        const uri = remoteImageUri(part);
        if (!uri) return part;
        const { fileData: _fileData, ...rest } = part as Record<string, unknown>;
        return { ...rest, inlineData: resolved.get(uri) };
      }),
    };
  });
}
