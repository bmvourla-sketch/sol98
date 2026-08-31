// Shared, framework-agnostic types + pure validators for the pixel board.
// No "use client" here on purpose: this file is imported by BOTH the client
// store (lib/pixel-store.tsx) and the server route/db modules, so it must
// stay free of React and browser-only globals.

export type NeonTemplate =
  | "none"
  | "cyberpunk-pulse"
  | "matrix"
  | "flashing"
  | "glitch"
  | "rainbow"
  | "sequential";

/** The ad payload attached to a block (or a multi-block banner). */
export interface AdContent {
  destination: string; // destination link
  imageUrl: string; // image / neon GIF / data: URL from Banner.exe
  message: string; // tooltip message
  neon: NeonTemplate;
}

export interface PixelData extends AdContent {
  index: number; // 0-based board index
  owner: string; // wallet public key (base58)
  valuationSol: number; // current SOL valuation (decays on hijack)
  purchasedAt: number; // epoch ms
  isRented: boolean;
  rentedTo?: string;
  rentedUntil?: number;
  listingPriceSol?: number; // set → for sale
  rentPriceSol?: number; // set → for rent (per day)
  // Multi-block banner grouping (spanning ad).
  bannerGroupId?: string;
  bannerCols?: number;
  bannerRows?: number;
  bannerX?: number; // 0-based col within the banner
  bannerY?: number; // 0-based row within the banner
}

const NEON_VALUES: NeonTemplate[] = [
  "none",
  "cyberpunk-pulse",
  "matrix",
  "flashing",
  "glitch",
  "rainbow",
  "sequential",
];

export function isNeonTemplate(value: unknown): value is NeonTemplate {
  return typeof value === "string" && (NEON_VALUES as string[]).includes(value);
}

const MAX_LINK_LEN = 500;
const MAX_IMAGE_LEN = 2_000_000; // generous — Banner.exe can export a data: PNG
const MAX_MESSAGE_LEN = 200;

/** Destination / "buy area" click-through link: http(s) only, or empty. */
export function isSafeLinkUrl(url: string): boolean {
  if (url === "") return true;
  if (url.length > MAX_LINK_LEN) return false;
  return /^https?:\/\/\S+$/i.test(url);
}

/** Ad image: http(s) URL, a same-origin-safe data:image/* URL, or empty. */
export function isSafeImageUrl(url: string): boolean {
  if (url === "") return true;
  if (url.length > MAX_IMAGE_LEN) return false;
  if (/^https?:\/\/\S+$/i.test(url)) return true;
  return /^data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,/i.test(url);
}

export function isSafeMessage(message: string): boolean {
  return message.length <= MAX_MESSAGE_LEN;
}

export interface AdValidationError {
  field: string;
  reason: string;
}

/** Validates + trims an ad payload. Returns the sanitized ad or a field error. */
export function sanitizeAdContent(input: unknown): AdContent | AdValidationError {
  const raw = (input ?? {}) as Partial<Record<keyof AdContent, unknown>>;
  const destination = typeof raw.destination === "string" ? raw.destination.trim() : "";
  const imageUrl = typeof raw.imageUrl === "string" ? raw.imageUrl.trim() : "";
  const message = typeof raw.message === "string" ? raw.message.trim() : "";
  const neon = isNeonTemplate(raw.neon) ? raw.neon : "none";

  if (!isSafeLinkUrl(destination)) {
    return { field: "destination", reason: "must be an http(s) URL (or empty)" };
  }
  if (!isSafeImageUrl(imageUrl)) {
    return { field: "imageUrl", reason: "must be an http(s) or data:image URL (or empty)" };
  }
  if (!isSafeMessage(message)) {
    return { field: "message", reason: `must be at most ${MAX_MESSAGE_LEN} characters` };
  }
  return { destination, imageUrl, message, neon };
}

export function isAdValidationError(value: AdContent | AdValidationError): value is AdValidationError {
  return "reason" in value;
}

export const MAX_AREA_BLOCKS = 5000;

export interface BannerLayout {
  cols: number;
  rows: number;
  minRow: number;
  minCol: number;
}

/**
 * Derives the banner rectangle (and each block's position within it) from a
 * raw list of board indices — computed the SAME way on the client (preview)
 * and the server (authoritative, on write), so nobody can hand the API a
 * spoofed banner shape.
 */
export function computeBannerLayout(indices: number[], boardSize: number): BannerLayout {
  const cols = indices.map((i) => i % boardSize);
  const rows = indices.map((i) => Math.floor(i / boardSize));
  const minCol = Math.min(...cols);
  const minRow = Math.min(...rows);
  return {
    cols: Math.max(...cols) - minCol + 1,
    rows: Math.max(...rows) - minRow + 1,
    minRow,
    minCol,
  };
}

export function bannerPosition(
  index: number,
  boardSize: number,
  layout: BannerLayout
): { bannerX: number; bannerY: number } {
  return {
    bannerX: (index % boardSize) - layout.minCol,
    bannerY: Math.floor(index / boardSize) - layout.minRow,
  };
}
