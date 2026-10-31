/**
 * Image input for a turn. The Muse contract (TurnInputPart) takes `{type: "image", mediaType,
 * base64Data, width?, height?}`, with width and height given together or not at all. The host's own
 * size limits are not published, so the limits below are Antares' conservative ones, not Muse's.
 * Only PNG has been observed working end to end; the other types follow the contract.
 */
export interface ImageInput {
  mediaType: string;
  base64Data: string;
  width?: number;
  height?: number;
}

export const ALLOWED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export const MAX_IMAGES = 6;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_TOTAL_IMAGE_BYTES = 15 * 1024 * 1024;

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** Decoded size in bytes of a base64 string (assumes it is well formed). */
export function decodedSize(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

/** True when the first bytes match the declared media type. */
export function matchesSignature(mediaType: string, base64: string): boolean {
  const head = Buffer.from(base64.slice(0, 24), "base64");
  switch (mediaType) {
    case "image/png":
      return head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    case "image/jpeg":
      return head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
    case "image/gif":
      return head.length >= 4 && head.subarray(0, 4).toString("ascii") === "GIF8";
    case "image/webp":
      return head.length >= 12 && head.subarray(0, 4).toString("ascii") === "RIFF" && head.subarray(8, 12).toString("ascii") === "WEBP";
    default:
      return false;
  }
}

export type ImageCheck = { ok: true; images: ImageInput[] } | { ok: false; error: string };

/** Validates untrusted image input (it arrives from the webview) before anything is sent to the host. */
export function validateImages(input: unknown): ImageCheck {
  if (input === undefined || input === null) return { ok: true, images: [] };
  if (!Array.isArray(input)) return { ok: false, error: "Images must be a list." };
  if (input.length > MAX_IMAGES) return { ok: false, error: `At most ${MAX_IMAGES} images can be sent in one message.` };
  const images: ImageInput[] = [];
  let total = 0;
  for (const [i, raw] of input.entries()) {
    const label = `Image ${i + 1}`;
    if (typeof raw !== "object" || raw === null) return { ok: false, error: `${label} is not valid.` };
    const { mediaType, base64Data, width, height } = raw as Record<string, unknown>;
    if (typeof mediaType !== "string" || !(ALLOWED_IMAGE_TYPES as readonly string[]).includes(mediaType)) {
      return { ok: false, error: `${label}: unsupported type. Use PNG, JPEG, GIF or WebP.` };
    }
    if (typeof base64Data !== "string" || base64Data.length === 0 || !BASE64.test(base64Data)) {
      return { ok: false, error: `${label}: the data is empty or not valid base64.` };
    }
    const size = decodedSize(base64Data);
    if (size > MAX_IMAGE_BYTES) return { ok: false, error: `${label} is too large (${(size / 1048576).toFixed(1)} MB; the limit is ${MAX_IMAGE_BYTES / 1048576} MB).` };
    total += size;
    if (total > MAX_TOTAL_IMAGE_BYTES) return { ok: false, error: `The images together are too large (the limit is ${MAX_TOTAL_IMAGE_BYTES / 1048576} MB).` };
    if (!matchesSignature(mediaType, base64Data)) return { ok: false, error: `${label}: the content is not a ${mediaType} image.` };
    const hasW = width !== undefined && width !== null;
    const hasH = height !== undefined && height !== null;
    if (hasW !== hasH) return { ok: false, error: `${label}: width and height must be given together.` };
    const image: ImageInput = { mediaType, base64Data };
    if (hasW && hasH) {
      if (!Number.isInteger(width) || !Number.isInteger(height) || (width as number) <= 0 || (height as number) <= 0) {
        return { ok: false, error: `${label}: width and height must be positive whole numbers.` };
      }
      image.width = width as number;
      image.height = height as number;
    }
    images.push(image);
  }
  return { ok: true, images };
}

/**
 * The ordered input parts for a turn: the text first, then the images. A skill invocation (`/name args`
 * resolved against the host's skill list) replaces the text: the host expands the skill itself.
 */
export function buildInputParts(text: string, images: ImageInput[], skill?: { selector: string; source?: string; arguments?: string }): Record<string, unknown>[] {
  const parts: Record<string, unknown>[] = [];
  if (skill) parts.push({ type: "skill", selector: skill.selector, ...(skill.source ? { source: skill.source } : {}), ...(skill.arguments ? { arguments: skill.arguments } : {}) });
  else if (text.trim() !== "") parts.push({ type: "text", text });
  for (const image of images) parts.push({ type: "image", ...image });
  return parts;
}
