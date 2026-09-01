// SOL-98 Phase 3 (MARKET SECURITY) — GÖREV 3, board.exe (Start Ads) mirror
// of pixel-mutations-atomic.ts. See that file's header for the full
// rationale; this is the identical pattern, threading `boardId` through the
// composite (board_id, index) key and into the ownership-history row.
//
// This module (and the accompanying intentId requirement added to
// app/api/boards/route.ts's handleBuyListing/handleRent/handleHijack) is an
// own-initiative scope extension, not literally named in the Phase 3 brief
// (which named `pixels/route.ts`) — while researching how to generalize the
// purchase_intents schema across both marketplaces, the identical P2-F1
// transaction-substitution pattern (and the identical pre-Phase-2.1
// signature-release gap — boards/route.ts was still calling the bare,
// throwing `releaseSignature`, not `releaseSignatureSafely`) was found in
// boards/route.ts's own buy-listing/rent/hijack handlers. Left undisclosed
// and unfixed here, it would be a known, identical vulnerability shipped
// alongside its own fix on the main board. Disclosed in full in
// docs/production-readiness/PHASE-3-MARKET-SECURITY.md.
import "server-only";

import type { BoardPixel } from "@/lib/board-types";
import { getBoardPixel, updateBoardPixel } from "./board-db";
import { consumeIntentFileStore } from "./intent-db";
import { isSupabaseConfigured, requireDurableStore, supabaseBaseUrl, supabaseHeaders } from "./supabase-env";
import { recordPaymentTransaction } from "./payment-ledger";
import { recordOwnershipHistory } from "./ownership-history";
import { logAudit } from "./audit-log";

export interface AtomicBoardUpdateParams {
  boardId: string;
  index: number;
  expectedOwner: string;
  mutate: (current: BoardPixel) => BoardPixel;
  signature: string;
  wallet: string;
  action: string;
  amountSol?: number;
  mint?: string | null;
  intentId: string | null;
  prevOwner: string | null;
  newOwner: string;
  recordHistory: boolean;
}

export type AtomicBoardMutateResult = { ok: true; pixel: BoardPixel } | { ok: false; reason: string };

interface RpcRow {
  ok: boolean;
  reason: string | null;
  data: BoardPixel | null;
}

async function updateViaSupabaseRpc(params: AtomicBoardUpdateParams): Promise<AtomicBoardMutateResult> {
  const current = await getBoardPixel(params.boardId, params.index);
  if (!current) return { ok: false, reason: "not_found" };
  const next = params.mutate(current);

  const res = await fetch(`${supabaseBaseUrl()}/rest/v1/rpc/update_board_pixel_owner_atomic`, {
    method: "POST",
    headers: supabaseHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      p_board_id: params.boardId,
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
    throw new Error(`update_board_pixel_owner_atomic rpc failed: ${res.status}${bodyText ? ` — ${bodyText}` : ""}`);
  }
  const rows = (await res.json()) as RpcRow[];
  const row = rows[0];
  if (!row || !row.ok) return { ok: false, reason: row?.reason ?? "conflict" };
  return { ok: true, pixel: row.data as BoardPixel };
}

async function updateViaFileStore(params: AtomicBoardUpdateParams): Promise<AtomicBoardMutateResult> {
  const result = await updateBoardPixel(params.boardId, params.index, params.expectedOwner, params.mutate);
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
        boardId: params.boardId,
        index: params.index,
        note: "ownership already mutated — file-store dev path is not atomic with intent consumption",
      });
    }
  }
  if (params.recordHistory) {
    await recordOwnershipHistory({
      pixelIndex: params.index,
      boardId: params.boardId,
      prevOwner: params.prevOwner,
      newOwner: params.newOwner,
      action: params.action,
      signature: params.signature,
    });
  }
  return result;
}

export async function updateBoardPixelOwnerAtomic(params: AtomicBoardUpdateParams): Promise<AtomicBoardMutateResult> {
  requireDurableStore();
  if (isSupabaseConfigured()) return updateViaSupabaseRpc(params);
  return updateViaFileStore(params);
}
