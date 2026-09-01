"use client";

// SOL-98 Phase 4 (FRONTEND INTENT INTEGRATION) — GÖREV 1: the client-side
// half of the Purchase Intent flow Phase 3 made mandatory server-side (see
// docs/production-readiness/PHASE-3-MARKET-SECURITY.md and app/api/
// purchase-intents/route.ts). Before Phase 4, lib/pixel-store.tsx and
// lib/board-store.tsx still POSTed a bare `index` for buy-listing / rent /
// hijack(live) — the server has required `intentId` since Phase 3, so those
// three flows were broken until this file + the store rewrites landed.
//
// Required client flow (see app/api/purchase-intents/route.ts's own doc
// comment for the server side of this):
//   1. call createPurchaseIntent() BEFORE asking the wallet to sign anything
//      — the server re-reads the LIVE listing/rent/hijack state itself and
//      returns the authoritative price/seller/expiry.
//   2. build + send the payment using THOSE server-returned values (never
//      whatever the client's own local pixel cache says — that cache can be
//      up to POLL_MS stale).
//   3. redeem by POSTing { intentId, signature } to /api/pixels or
//      /api/boards — never `index`.
export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export type IntentActionType = "buy-listing" | "rent" | "hijack";

export interface IntentResult {
  intentId: string;
  expiresAt: number; // epoch ms — server-authoritative TTL (15 min at creation)
  currency: "SOL" | "PIXEL98";
  sellerWallet: string;
  priceSol?: number;
  pricePixel98?: number;
  days?: number;
  /** hijack only — informational, recomputed fresh again at redemption. */
  hijackCostTokensPreview?: number;
  burnedTokensPreview?: number;
  ownerTokensPreview?: number;
}

const INTENTS_API_URL = process.env.NEXT_PUBLIC_PURCHASE_INTENTS_API_URL || "/api/purchase-intents";

/**
 * Shared POST-JSON-and-throw-ApiError-on-failure helper. Both this module's
 * createPurchaseIntent() and lib/pixel-store.tsx / lib/board-store.tsx's
 * (redemption-call) postAction() go through this single implementation, so
 * a test exercising postJson exercises the EXACT code path the UI runs for
 * both the intent-creation call and the redemption call — see
 * tests/integration/phase4-frontend-intent-staging.test.ts.
 */
export async function postJson<T>(url: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as { error?: string } & T;
  if (!res.ok) {
    throw new ApiError(json.error || `request failed (${res.status})`, res.status);
  }
  return json;
}

export interface CreateIntentParams {
  actor: string;
  actionType: IntentActionType;
  /** null/omit = the main pixel board; a board.exe file id otherwise. */
  boardId?: string | null;
  index: number;
  /** rent only. */
  days?: number;
}

export async function createPurchaseIntent(params: CreateIntentParams): Promise<IntentResult> {
  const json = await postJson<Record<string, unknown>>(INTENTS_API_URL, {
    actor: params.actor,
    actionType: params.actionType,
    boardId: params.boardId ?? null,
    index: params.index,
    ...(params.days !== undefined ? { days: params.days } : {}),
  });
  const currency = json.currency === "PIXEL98" ? "PIXEL98" : "SOL";
  return {
    intentId: String(json.intentId),
    expiresAt: Number(json.expiresAt),
    currency,
    sellerWallet: String(json.sellerWallet ?? ""),
    priceSol: currency === "SOL" && typeof json.price === "number" ? json.price : undefined,
    pricePixel98: currency === "PIXEL98" && typeof json.price === "number" ? json.price : undefined,
    days: typeof json.days === "number" ? json.days : undefined,
    hijackCostTokensPreview: typeof json.hijackCostTokensPreview === "number" ? json.hijackCostTokensPreview : undefined,
    burnedTokensPreview: typeof json.burnedTokensPreview === "number" ? json.burnedTokensPreview : undefined,
    ownerTokensPreview: typeof json.ownerTokensPreview === "number" ? json.ownerTokensPreview : undefined,
  };
}

/**
 * Maps the specific error statuses the intent system can produce into a
 * message a non-technical user can act on. Falls back to the server's own
 * error text (or a generic one) for anything else, so this is always safe
 * to run a caught error through.
 */
export function friendlyIntentError(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.status) {
      case 410:
        return "This offer expired before your payment landed — please try again.";
      case 403:
        return "This purchase request doesn't match your connected wallet — please try again.";
      case 409:
        return "This listing changed right before your payment landed (price, or someone else was faster) — please try again.";
      case 404:
        return "This spot isn't available anymore.";
      case 503:
        return err.message; // "$PIXEL98 not live yet…" — already user-facing as written
      default:
        break;
    }
  }
  return err instanceof Error ? err.message : "Something went wrong — please try again.";
}

/** Milliseconds remaining until `expiresAt`, floored at 0. */
export function msUntil(expiresAt: number): number {
  return Math.max(0, expiresAt - Date.now());
}

/** "14:32"-style mm:ss countdown string for a purchase-intent expiry. */
export function formatCountdown(expiresAt: number): string {
  const totalSeconds = Math.ceil(msUntil(expiresAt) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
