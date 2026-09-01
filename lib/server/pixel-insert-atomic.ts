// SOL-98 Phase 4 (FRONTEND INTENT INTEGRATION, TREASURY ATOMICITY & TOKEN
// PREP) — GÖREV 2: atomic ownership + ledger writes for TREASURY purchases
// on the main pixel board (buy / buy-area).
//
// Phase 3 (GÖREV 3) made the three UPDATE-based peer-to-peer handlers
// (buy-listing/rent/hijack-live) atomic via update_pixel_owner_atomic, but
// explicitly left buy/buy-area out of scope — see
// docs/production-readiness/PHASE-3-MARKET-SECURITY.md §4.4. Those two
// still used createPixels() followed by two separate best-effort writes
// (recordPaymentTransaction, recordOwnershipHistoryBatch) — the exact same
// P2-F4 "ownership can change hands with no corresponding ledger row" risk
// Phase 3 closed for the peer-to-peer paths, just not yet for these
// INSERT-based ones.
//
// insertPixelsAtomic wraps the pixel row INSERT, the payment_transactions
// INSERT, and the pixel_ownership_history INSERT in ONE Postgres transaction
// (the insert_pixels_atomic RPC — see
// supabase/migrations/0005_treasury_purchase_atomicity.up.sql). A "one of
// these spots was just sold" race is reported back CLEANLY (ok:false,
// taken:[...]) — exactly like createPixels()'s existing contract, so
// app/api/pixels/route.ts's callers don't need to change their 409 handling
// at all — while a genuine anomaly at the ledger step (e.g. a duplicate
// signature reaching payment_transactions' own UNIQUE constraint) raises and
// rolls back the WHOLE transaction, pixel rows included. See
// docs/production-readiness/PHASE-4-FRONTEND-TOKEN-PREP.md for the
// RED TEAM test that proves this against real staging Postgres.
//
// SOL-98 Phase 6 (RED-TEAM HARDENING — BULGU 1, see
// docs/production-readiness/RED-TEAM-FINDINGS.md and
// supabase/migrations/0006_hardening_price_lock_documents_intent_expiry.up.sql):
// `paidLamports` (the REAL amount verifySolTransfer found on-chain — see
// lib/server/verify-tx.ts's `lamportsFound`) is now forwarded to the RPC,
// which re-derives the TRUE current price under a pg_advisory_xact_lock and
// rejects (ok:false, reason:"underpaid") if the caller's payment falls short
// of it — closing the race where two concurrent buy/buy-area requests could
// both read the same stale soldCount and both underpay.
import "server-only";

import type { PixelData } from "@/lib/pixel-types";
import { createPixels } from "./pixel-db";
import { isSupabaseConfigured, requireDurableStore, supabaseBaseUrl, supabaseHeaders } from "./supabase-env";
import { recordPaymentTransaction } from "./payment-ledger";
import { recordOwnershipHistoryBatch } from "./ownership-history";

export interface InsertPixelsParams {
  pixels: PixelData[];
  signature: string;
  wallet: string;
  action: string; // "buy" | "buy-area"
  amountSol: number;
  /** The REAL, already on-chain-verified lamport amount (verifySolTransfer's
   * `lamportsFound`) — re-checked by the RPC against a freshly, atomically
   * computed price. See this file's Phase 6 header comment. */
  paidLamports: number;
}

export type InsertPixelsResult =
  | { ok: true }
  | { ok: false; reason: "conflict" | "underpaid"; taken: number[] };

interface RpcRow {
  ok: boolean;
  reason: string | null;
  taken: number[] | null;
}

async function insertViaSupabaseRpc(params: InsertPixelsParams): Promise<InsertPixelsResult> {
  const res = await fetch(`${supabaseBaseUrl()}/rest/v1/rpc/insert_pixels_atomic`, {
    method: "POST",
    headers: supabaseHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      p_records: params.pixels,
      p_signature: params.signature,
      p_wallet: params.wallet,
      p_action: params.action,
      p_amount_sol: params.amountSol,
      p_mint: null, // buy / buy-area are always SOL-priced in this codebase
      p_paid_lamports: params.paidLamports,
    }),
  });
  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    // A RAISE'd/propagated exception inside the function (e.g. the
    // payment_transactions UNIQUE(signature) constraint firing on a
    // duplicate) lands here — surfaced as a thrown error so the caller's
    // existing Phase 2.1 try/catch + releaseSignatureSafely handling
    // applies unchanged, exactly like update_pixel_owner_atomic.
    throw new Error(`insert_pixels_atomic rpc failed: ${res.status}${bodyText ? ` — ${bodyText}` : ""}`);
  }
  const rows = (await res.json()) as RpcRow[];
  const row = rows[0];
  if (!row || !row.ok) {
    const reason = row?.reason === "underpaid" ? "underpaid" : "conflict";
    return { ok: false, reason, taken: row?.taken ?? [] };
  }
  return { ok: true };
}

/**
 * File-store (dev only) fallback. NOT a single transaction — the ledger
 * writes here are best-effort, same documented limitation as
 * pixel-mutations-atomic.ts's updateViaFileStore. `paidLamports` is NOT
 * re-verified here: the price race this guards against is a cross-instance/
 * cross-serverless-process phenomenon, which the single-process file store
 * (guarded by the same in-process mutex as everything else on this backend)
 * cannot exhibit — documented dev-only limitation, same class as every other
 * file-store caveat in this codebase.
 */
async function insertViaFileStore(params: InsertPixelsParams): Promise<InsertPixelsResult> {
  const created = await createPixels(params.pixels);
  if (!created.ok) return { ok: false, reason: "conflict", taken: created.taken };
  await recordPaymentTransaction({
    signature: params.signature,
    wallet: params.wallet,
    action: params.action,
    amountSol: params.amountSol,
  });
  await recordOwnershipHistoryBatch(
    params.pixels.map((p) => ({
      pixelIndex: p.index,
      boardId: null,
      prevOwner: null,
      newOwner: params.wallet,
      action: params.action,
      signature: params.signature,
    }))
  );
  return { ok: true };
}

export async function insertPixelsAtomic(params: InsertPixelsParams): Promise<InsertPixelsResult> {
  requireDurableStore();
  if (isSupabaseConfigured()) return insertViaSupabaseRpc(params);
  return insertViaFileStore(params);
}
