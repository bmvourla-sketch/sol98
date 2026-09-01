// SOL-98 Phase 3 (MARKET SECURITY) — GÖREV 3: atomic ownership + ledger
// writes for the main pixel board.
//
// Closes finding P2-F4 (ledger completeness): payment-ledger.ts and
// ownership-history.ts are, by design, best-effort and never throw (a
// failed telemetry write must never roll back an already-successful
// ownership change written through the OLD, non-atomic call sequence). That
// was fine as pure telemetry, but is NOT acceptable if this ledger is ever
// used for financial accounting or an airdrop snapshot — ownership could
// change hands with no corresponding history row.
//
// `updatePixelOwnerAtomic` replaces that sequence, for the THREE handlers
// this phase touches (buy-listing / rent / hijack-live), with ONE Postgres
// transaction on the Supabase backend: the update_pixel_owner_atomic RPC
// (supabase/migrations/0004_purchase_intents_and_atomicity.up.sql) performs
// the conditional ownership UPDATE, the purchase_intent consumption, the
// payment_transactions INSERT, and (when requested) the
// pixel_ownership_history INSERT as one function call — a RAISE EXCEPTION
// at any step rolls back everything already executed in that same call.
//
// Deliberately NOT extended to the treasury-purchase paths (buy / buy-area)
// — see docs/production-readiness/PHASE-3-MARKET-SECURITY.md's scope-
// boundary section: those have no transaction-substitution exposure
// (uniform bonding-curve pricing, INSERT-based) and are outside GÖREV 1/2/3.
import "server-only";

import type { PixelData } from "@/lib/pixel-types";
import { getPixel, updateOwnedPixel } from "./pixel-db";
import { consumeIntentFileStore } from "./intent-db";
import { isSupabaseConfigured, requireDurableStore, supabaseBaseUrl, supabaseHeaders } from "./supabase-env";
import { recordPaymentTransaction } from "./payment-ledger";
import { recordOwnershipHistory } from "./ownership-history";
import { logAudit } from "./audit-log";

export interface AtomicUpdateParams {
  index: number;
  /** The owner the write is conditioned on — the seller for buy-listing/rent
   * (already re-verified fresh against live state by the caller), or the
   * CURRENT live owner for hijack (any owner can be hijacked; this is just
   * the race-closing "nothing changed between my read and my write" guard —
   * see pixel-db-supabase.ts's hijackPixel, which conditions its PATCH on
   * the exact same thing). */
  expectedOwner: string;
  mutate: (current: PixelData) => PixelData;
  signature: string;
  wallet: string;
  action: string;
  amountSol?: number;
  mint?: string | null;
  /** null for actions that don't go through the intent system (there are
   * none left in the three handlers that call this — kept nullable so the
   * RPC's intent re-check is skippable in principle, e.g. for future
   * reuse). */
  intentId: string | null;
  prevOwner: string | null;
  newOwner: string;
  recordHistory: boolean;
}

export type AtomicMutateResult = { ok: true; pixel: PixelData } | { ok: false; reason: string };

interface RpcRow {
  ok: boolean;
  reason: string | null;
  data: PixelData | null;
}

async function updateViaSupabaseRpc(params: AtomicUpdateParams): Promise<AtomicMutateResult> {
  const current = await getPixel(params.index);
  if (!current) return { ok: false, reason: "not_found" };
  const next = params.mutate(current);

  const res = await fetch(`${supabaseBaseUrl()}/rest/v1/rpc/update_pixel_owner_atomic`, {
    method: "POST",
    headers: supabaseHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      p_index: params.index,
      p_expected_owner: params.expectedOwner,
      p_new_data: next,
      p_signature: params.signature,
      p_wallet: params.wallet,
      p_action: params.action,
      p_amount_sol: params.amountSol ?? null,
      p_mint: params.mint ?? null,
      p_intent_id: params.intentId,
      p_prev_owner: params.prevOwner,
      p_new_owner: params.newOwner,
      p_record_history: params.recordHistory,
    }),
  });
  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    // A RAISE EXCEPTION inside the function (e.g. the intent re-check
    // failing) lands here too — surfaced as a thrown error, same as any
    // other mutation failure, so the caller's existing Phase 2.1
    // try/catch + releaseSignatureSafely handling applies unchanged.
    throw new Error(`update_pixel_owner_atomic rpc failed: ${res.status}${bodyText ? ` — ${bodyText}` : ""}`);
  }
  const rows = (await res.json()) as RpcRow[];
  const row = rows[0];
  if (!row || !row.ok) return { ok: false, reason: row?.reason ?? "conflict" };
  return { ok: true, pixel: row.data as PixelData };
}

/**
 * File-store (dev only) fallback. NOT a single transaction — the ledger and
 * intent-consumption writes here are best-effort, same limitation
 * payment-ledger.ts / ownership-history.ts already document, and the
 * conditional ownership write itself reuses updateOwnedPixel (which, for
 * hijack, is passed the freshly-read current owner as `expectedOwner`, so
 * it behaves the same as the existing race-check hijackPixel already does
 * on Supabase — see the AtomicUpdateParams.expectedOwner doc comment).
 * Documented, not silently pretended to be atomic, in
 * docs/production-readiness/PHASE-3-MARKET-SECURITY.md.
 */
async function updateViaFileStore(params: AtomicUpdateParams): Promise<AtomicMutateResult> {
  const result = await updateOwnedPixel(params.index, params.expectedOwner, params.mutate);
  if (!result.ok) return result;

  await recordPaymentTransaction({
    signature: params.signature,
    wallet: params.wallet,
    action: params.action,
    amountSol: params.amountSol,
    mint: params.mint,
  });
  if (params.intentId) {
    const consumed = await consumeIntentFileStore(params.intentId, params.signature);
    if (!consumed) {
      logAudit("db_failure", {
        where: "consumeIntentFileStore",
        action: params.action,
        wallet: params.wallet,
        index: params.index,
        note: "ownership already mutated — file-store dev path is not atomic with intent consumption",
      });
    }
  }
  if (params.recordHistory) {
    await recordOwnershipHistory({
      pixelIndex: params.index,
      boardId: null,
      prevOwner: params.prevOwner,
      newOwner: params.newOwner,
      action: params.action,
      signature: params.signature,
    });
  }
  return result;
}

export async function updatePixelOwnerAtomic(params: AtomicUpdateParams): Promise<AtomicMutateResult> {
  requireDurableStore();
  if (isSupabaseConfigured()) return updateViaSupabaseRpc(params);
  return updateViaFileStore(params);
}
