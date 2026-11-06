import "server-only";
import sharp from "sharp";

export const GUIDE_COVER_MAX_INPUT_BYTES = 10 * 1024 * 1024;
export const GUIDE_COVER_MAX_INPUT_PIXELS = 16_000_000;
export const GUIDE_COVER_MAX_INPUT_EDGE = 12_000;
export const GUIDE_COVER_MAX_OUTPUT_EDGE = 2400;

export type GuideCoverImageErrorCode = "payload_too_large" | "unsupported_format" | "invalid_image" | "image_too_large";

export class GuideCoverImageError extends Error {
  readonly code: GuideCoverImageErrorCode;

  constructor(code: GuideCoverImageErrorCode) {
    super(code);
    this.name = "GuideCoverImageError";
    this.code = code;
  }
}

function isJpeg(input: Uint8Array): boolean {
  return input.length >= 3 && input[0] === 0xff && input[1] === 0xd8 && input[2] === 0xff;
}

function isPng(input: Uint8Array): boolean {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return input.length >= signature.length && signature.every((byte, index) => input[index] === byte);
}

export async function readGuideCoverInput(request: Request): Promise<Buffer> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > GUIDE_COVER_MAX_INPUT_BYTES) {
    throw new GuideCoverImageError("payload_too_large");
  }
  if (!request.body) throw new GuideCoverImageError("invalid_image");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      byteLength += chunk.value.byteLength;
      if (byteLength > GUIDE_COVER_MAX_INPUT_BYTES) throw new GuideCoverImageError("payload_too_large");
      chunks.push(chunk.value);
    }
  } finally {
    try { await reader.cancel(); } catch { /* The validation result remains authoritative. */ }
    finally { reader.releaseLock(); }
  }
  if (byteLength === 0) throw new GuideCoverImageError("invalid_image");
  return Buffer.concat(chunks, byteLength);
}

export async function processGuideCoverImage(input: Buffer): Promise<{
  readonly bytes: Buffer;
  readonly width: number;
  readonly height: number;
}> {
  if (input.byteLength > GUIDE_COVER_MAX_INPUT_BYTES) throw new GuideCoverImageError("payload_too_large");
  if (!isJpeg(input) && !isPng(input)) throw new GuideCoverImageError("unsupported_format");

  try {
    const source = sharp(input, {
      failOn: "error",
      limitInputPixels: GUIDE_COVER_MAX_INPUT_PIXELS,
      pages: 1,
      sequentialRead: true,
    });
    const metadata = await source.metadata();
    if (metadata.format !== "jpeg" && metadata.format !== "png") throw new GuideCoverImageError("unsupported_format");
    if (!metadata.width || !metadata.height) throw new GuideCoverImageError("invalid_image");
    if (
      metadata.width > GUIDE_COVER_MAX_INPUT_EDGE
      || metadata.height > GUIDE_COVER_MAX_INPUT_EDGE
      || metadata.width * metadata.height > GUIDE_COVER_MAX_INPUT_PIXELS
      || (metadata.pages ?? 1) !== 1
    ) {
      throw new GuideCoverImageError("image_too_large");
    }
    const output = await source
      .rotate()
      .resize({
        width: GUIDE_COVER_MAX_OUTPUT_EDGE,
        height: GUIDE_COVER_MAX_OUTPUT_EDGE,
        fit: "inside",
        withoutEnlargement: true,
      })
      .toColourspace("srgb")
      .jpeg({ quality: 86, progressive: true, chromaSubsampling: "4:2:0" })
      .toBuffer({ resolveWithObject: true });
    return { bytes: output.data, width: output.info.width, height: output.info.height };
  } catch (error) {
    if (error instanceof GuideCoverImageError) throw error;
    const message = error instanceof Error ? error.message : "";
    if (/pixel limit|Input image exceeds pixel limit/i.test(message)) {
      throw new GuideCoverImageError("image_too_large");
    }
    throw new GuideCoverImageError("invalid_image");
  }
}
