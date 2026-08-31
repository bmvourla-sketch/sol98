// Server-side centralized board store (Node runtime only).
//
// This is the SINGLE place that mutates board state, and every mutation is
// conditioned on the CURRENT stored state (not on whatever the client
// claims) — see the primitives below. Two interchangeable backends:
//   1. Supabase (PostgREST) — auto-selected when SUPABASE_URL +
//      SUPABASE_SERVICE_ROLE_KEY are set. Durable across serverless
//      instances (the correct choice for Vercel), and its conditional
//      UPDATE ... WHERE filters give real cross-instance atomicity.
//   2. File store (`data/pixels.json`) — atomic tmp+rename write, guarded by
//      an in-process mutex. Fine for a single-machine deploy (Render/Docker/
//      VPS); ephemeral on Vercel; the mutex only protects one process.
import "server-only";
import { promises as fs } from "fs";
import path from "path";

import type { PixelData } from "@/lib/pixel-types";
import { isSupabaseConfigured } from "./supabase-env";
import { createMutex } from "./mutex";
import * as supabaseStore from "./pixel-db-supabase";

const DATA_DIR = path.join(process.cwd(), "data");
const FILE = path.join(DATA_DIR, "pixels.json");
const withLock = createMutex();

let cache: Record<number, PixelData> | null = null;

async function load(): Promise<Record<number, PixelData>> {
  if (cache) return cache;
  try {
    const raw = await fs.readFile(FILE, "utf8");
    const parsed: unknown = JSON.parse(raw);
    cache = parsed && typeof parsed === "object" ? (parsed as Record<number, PixelData>) : {};
  } catch {
    cache = {};
  }
  return cache;
}

async function persist(store: Record<number, PixelData>): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(store), "utf8");
  await fs.rename(tmp, FILE);
}

export type CreateResult = { ok: true } | { ok: false; taken: number[] };
export type MutateResult = { ok: true; pixel: PixelData } | { ok: false; reason: string };
export type MutateGroupResult = { ok: true; pixels: PixelData[] } | { ok: false; reason: string };

/** The whole board — every client GETs this same global state. */
export async function readAllPixels(): Promise<Record<number, PixelData>> {
  if (isSupabaseConfigured()) return supabaseStore.readAllPixels();
  return { ...(await load()) };
}

export async function getPixel(index: number): Promise<PixelData | undefined> {
  if (isSupabaseConfigured()) return supabaseStore.getPixel(index);
  const store = await load();
  return store[index];
}

export async function getPixels(indices: number[]): Promise<Map<number, PixelData>> {
  if (isSupabaseConfigured()) return supabaseStore.getPixels(indices);
  const store = await load();
  const map = new Map<number, PixelData>();
  for (const i of indices) {
    const p = store[i];
    if (p) map.set(i, p);
  }
  return map;
}

export async function soldCount(): Promise<number> {
  if (isSupabaseConfigured()) return supabaseStore.soldCount();
  const store = await load();
  return Object.keys(store).length;
}

/**
 * Creates brand-new pixel rows. Fails atomically (no partial write) if ANY
 * requested index is already taken — used for "buy" / "buy-area", so a
 * purchase can never silently overwrite someone else's spot.
 */
export async function createPixels(records: PixelData[]): Promise<CreateResult> {
  if (isSupabaseConfigured()) return supabaseStore.createPixels(records);
  return withLock(async () => {
    const store = await load();
    const taken = records.map((r) => r.index).filter((i) => store[i] !== undefined);
    if (taken.length > 0) return { ok: false, taken };
    for (const record of records) store[record.index] = record;
    await persist(store);
    return { ok: true };
  });
}

/**
 * Applies `mutate` to an existing pixel ONLY if it currently exists and its
 * stored owner is exactly `expectedOwner` — used for edit / list-sale /
 * list-rent / unlist (owner-only, no ownership change) AND for buy-listing /
 * rent (ownership DOES change, `expectedOwner` is the seller read just
 * before calling this). Re-checked against the LIVE row, closing the race
 * where the owner changes between a caller's read and this write.
 */
export async function updateOwnedPixel(
  index: number,
  expectedOwner: string,
  mutate: (current: PixelData) => PixelData
): Promise<MutateResult> {
  if (isSupabaseConfigured()) return supabaseStore.updateOwnedPixel(index, expectedOwner, mutate);
  return withLock(async () => {
    const store = await load();
    const current = store[index];
    if (!current) return { ok: false, reason: "not_found" };
    if (current.owner !== expectedOwner) return { ok: false, reason: "not_owner" };
    const next = mutate(current);
    store[index] = next;
    await persist(store);
    return { ok: true, pixel: next };
  });
}

/** Same as `updateOwnedPixel` but for every block sharing a banner group (Banner.exe "place"). */
export async function updateGroupOwnedPixels(
  groupId: string,
  expectedOwner: string,
  mutate: (current: PixelData) => PixelData
): Promise<MutateGroupResult> {
  if (isSupabaseConfigured()) return supabaseStore.updateGroupOwnedPixels(groupId, expectedOwner, mutate);
  return withLock(async () => {
    const store = await load();
    const matches = Object.values(store).filter(
      (p) => p.bannerGroupId === groupId && p.owner === expectedOwner
    );
    if (matches.length === 0) return { ok: false, reason: "not_found" };
    const updated = matches.map(mutate);
    for (const p of updated) store[p.index] = p;
    await persist(store);
    return { ok: true, pixels: updated };
  });
}

/**
 * Overtakes an existing pixel regardless of current owner (a hijack can
 * target anyone) — but still atomically re-checks the row exists at write
 * time, so two simultaneous hijacks of the same spot can't both "succeed"
 * and silently clobber each other.
 */
export async function hijackPixel(
  index: number,
  mutate: (current: PixelData) => PixelData
): Promise<MutateResult> {
  if (isSupabaseConfigured()) return supabaseStore.hijackPixel(index, mutate);
  return withLock(async () => {
    const store = await load();
    const current = store[index];
    if (!current) return { ok: false, reason: "not_found" };
    const next = mutate(current);
    store[index] = next;
    await persist(store);
    return { ok: true, pixel: next };
  });
}
