// Server-side centralized board store (Node runtime only).
//
// Two interchangeable backends behind the same `readPixels` / `writePixel`
// interface:
//   1. Supabase (PostgREST) — auto-selected when SUPABASE_URL +
//      SUPABASE_SERVICE_ROLE_KEY are set. Durable across serverless instances
//      (the correct choice for Vercel).
//   2. File store (`data/pixels.json`) — atomic tmp+rename write. Fine for a
//      single-machine deploy (Render/Docker/VPS); ephemeral on Vercel.
import { promises as fs } from "fs";
import path from "path";

import {
  isSupabaseConfigured,
  supabaseReadPixels,
  supabaseWritePixel,
} from "./pixel-db-supabase";

const DATA_DIR = path.join(process.cwd(), "data");
const FILE = path.join(DATA_DIR, "pixels.json");

let cache: Record<number, unknown> | null = null;

async function load(): Promise<Record<number, unknown>> {
  if (cache) return cache;
  try {
    const raw = await fs.readFile(FILE, "utf8");
    const parsed: unknown = JSON.parse(raw);
    cache = parsed && typeof parsed === "object" ? (parsed as Record<number, unknown>) : {};
  } catch {
    cache = {};
  }
  return cache;
}

/** The whole board — shared by every client. */
export async function readPixels(): Promise<Record<number, unknown>> {
  if (isSupabaseConfigured()) return supabaseReadPixels();
  return load();
}

/** Upsert a single pixel (buy/hijack/edit/sell/rent all land here). */
export async function writePixel(pixel: unknown): Promise<void> {
  if (isSupabaseConfigured()) return supabaseWritePixel(pixel);

  const store = await load();
  const rec = pixel as { index?: number };
  if (typeof rec?.index !== "number" || rec.index < 0 || rec.index >= 40_000) {
    throw new Error("pixel.index must be a number in [0, 39999]");
  }
  store[rec.index] = pixel;

  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(store), "utf8");
  await fs.rename(tmp, FILE);
}
