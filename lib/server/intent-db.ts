// SOL-98 Phase 3 (MARKET SECURITY) — server-issued Purchase Intents.
//
// Closes finding P2-F1 (transaction substitution — see
// docs/production-readiness/PHASE-2-PAYMENT-SECURITY.md and
// docs/production-readiness/PHASE-3-MARKET-SECURITY.md): a peer-to-peer
// payment (buy-listing / rent) or a future hijack burn is verified on-chain
// as a transfer tied to (fromOwner, toOwner, amount) — NOT to a specific
// pixel. Without something extra, a payment made in good faith for one
// listing could be redeemed against a different listing that happens to
// share the same seller and price.
//
// A purchase intent is that "something extra": a discrete, auditable,
// pre-payment server action. The client commits to a specific
// (action_type, board_id, pixel_index) BEFORE paying; the server derives
// who/what/how-much EXCLUSIVELY from this record at redemption time —
// see pixel-mutations-atomic.ts / board-mutations-atomic.ts and the
// rewritten handleBuyListing/handleRent/handleHijack in
// app/api/pixels/route.ts + app/api/boards/route.ts.
//
// Same dual-backend pattern as pixel-db.ts / board-db.ts: Supabase
// (PostgREST + the update_*_owner_atomic RPCs) in production, a local JSON
// file store for dev. Every WRITE path calls requireDurableStore() first.
import "server-only";
import { promises as fs } from "fs";
import path from "path";
import crypto from "crypto";

import { isSupabaseConfigured, requireDurableStore } from "./supabase-env";
import { createMutex } from "./mutex";
import * as supabaseStore from "./intent-db-supabase";

export type IntentActionType = "buy-listing" | "rent" | "hijack";
export type IntentCurrency = "SOL" | "PIXEL98";
export type IntentStatus = "pending" | "consumed" | "expired" | "cancelled";

export interface PurchaseIntent {
  id: string;
  actionType: IntentActionType;
  boardId: string | null;
  pixelIndex: number;
  buyerWallet: string;
  sellerWallet: string;
  currency: IntentCurrency;
  priceSol?: number;
  pricePixel98?: number;
  mint?: string | null;
  rentDays?: number;
  status: IntentStatus;
  expiresAt: number; // epoch ms
  createdAt: number; // epoch ms
  consumedAt?: number;
  consumedBySignature?: string;
}

export interface CreateIntentInput {
  actionType: IntentActionType;
  boardId: string | null;
  pixelIndex: number;
  buyerWallet: string;
  sellerWallet: string;
  currency: IntentCurrency;
  priceSol?: number;
  pricePixel98?: number;
  mint?: string | null;
  rentDays?: number;
  ttlMs: number;
}

const DATA_DIR = path.join(process.cwd(), "data");
const FILE = path.join(DATA_DIR, "purchase-intents.json");
const withLock = createMutex();

let cache: Record<string, PurchaseIntent> | null = null;

async function load(): Promise<Record<string, PurchaseIntent>> {
  if (cache) return cache;
  try {
    const raw = await fs.readFile(FILE, "utf8");
    const parsed: unknown = JSON.parse(raw);
    cache = parsed && typeof parsed === "object" ? (parsed as Record<string, PurchaseIntent>) : {};
  } catch {
    cache = {};
  }
  return cache;
}

async function persist(store: Record<string, PurchaseIntent>): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(store), "utf8");
  await fs.rename(tmp, FILE);
}

/** Creates a new pending intent, valid for `input.ttlMs` from now. */
export async function createIntent(input: CreateIntentInput): Promise<PurchaseIntent> {
  requireDurableStore();
  const now = Date.now();
  const intent: PurchaseIntent = {
    id: crypto.randomUUID(),
    actionType: input.actionType,
    boardId: input.boardId,
    pixelIndex: input.pixelIndex,
    buyerWallet: input.buyerWallet,
    sellerWallet: input.sellerWallet,
    currency: input.currency,
    priceSol: input.priceSol,
    pricePixel98: input.pricePixel98,
    mint: input.mint ?? null,
    rentDays: input.rentDays,
    status: "pending",
    expiresAt: now + input.ttlMs,
    createdAt: now,
  };

  if (isSupabaseConfigured()) {
    // SOL-98 Phase 6 (BULGU 3) — opportunistic, non-blocking sweep: piggy-
    // back on every intent creation to also flip any now-stale 'pending'
    // rows to 'expired'. Fire-and-forget (not awaited) so a slow/failed
    // sweep never adds latency to, or fails, THIS creation — see
    // intent-db-supabase.ts's expireStaleIntents doc comment.
    void supabaseStore.expireStaleIntents();
    return supabaseStore.createIntent(intent);
  }
  return withLock(async () => {
    const store = await load();
    store[intent.id] = intent;
    await persist(store);
    return intent;
  });
}

/** Reads a single intent by id. Does NOT check status/expiry — callers must. */
export async function getIntent(id: string): Promise<PurchaseIntent | undefined> {
  if (isSupabaseConfigured()) return supabaseStore.getIntent(id);
  const store = await load();
  return store[id];
}

/**
 * File-store-only fallback consumption (dev/test, no Supabase configured).
 * On Supabase, the intent is instead consumed ATOMICALLY inside the
 * update_*_owner_atomic RPC alongside the ownership mutation — see
 * pixel-mutations-atomic.ts / board-mutations-atomic.ts. This function
 * exists so the file-store dev path has an equivalent (best-effort, single-
 * process-mutex-guarded, NOT cross-process-atomic with the ownership write)
 * single-use guarantee, documented as a dev-only limitation in
 * docs/production-readiness/PHASE-3-MARKET-SECURITY.md.
 */
export async function consumeIntentFileStore(id: string, signature: string): Promise<boolean> {
  return withLock(async () => {
    const store = await load();
    const intent = store[id];
    if (!intent) return false;
    if (intent.status !== "pending") return false;
    if (intent.expiresAt <= Date.now()) return false;
    store[id] = { ...intent, status: "consumed", consumedAt: Date.now(), consumedBySignature: signature };
    await persist(store);
    return true;
  });
}
