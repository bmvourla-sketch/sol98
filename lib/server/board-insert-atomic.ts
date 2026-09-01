// SOL-98 Phase 4 — GÖREV 2, board.exe (Start Ads) mirror of
// pixel-insert-atomic.ts. See that file's header for the full P2-F4
// rationale; this is the identical pattern for buy-board, additionally
// closing the non-atomicity board-db-supabase.ts's createBoard() already
// documented in its own header comment: the board_files row was inserted
// FIRST and the board_pixels sub-blocks SECOND, with a manual best-effort
// compensating DELETE of the file row if the sub-block insert failed — a
// real "half-created board.exe" window under a genuine DB error between the
// two INSERTs. insertBoardAtomic removes that window: both inserts (plus
// the payment ledger + ownership history writes) happen in ONE Postgres
// transaction (the insert_board_pixels_atomic RPC — see
// supabase/migrations/0005_treasury_purchase_atomicity.up.sql).
import "server-only";

import type { BoardFile, BoardPixel } from "@/lib/board-types";
import { createBoard } from "./board-db";
import { isSupabaseConfigured, requireDurableStore, supabaseBaseUrl, supabaseHeaders } from "./supabase-env";
import { recordPaymentTransaction } from "./payment-ledger";
import { recordOwnershipHistoryBatch } from "./ownership-history";

export interface InsertBoardParams {
  file: BoardFile;
  subBlocks: BoardPixel[];
  signature: string;
  wallet: string;
  action: string; // "buy-board"
  amountSol: number;
}

export type InsertBoardResult = { ok: true; file: BoardFile } | { ok: false; reason: string };

interface RpcRow {
  ok: boolean;
  reason: string | null;
}

async function insertViaSupabaseRpc(params: InsertBoardParams): Promise<InsertBoardResult> {
  const res = await fetch(`${supabaseBaseUrl()}/rest/v1/rpc/insert_board_pixels_atomic`, {
    method: "POST",
    headers: supabaseHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      p_file_id: params.file.id,
      p_file_data: params.file,
      p_records: params.subBlocks,
      p_signature: params.signature,
      p_wallet: params.wallet,
      p_action: params.action,
      p_amount_sol: params.amountSol,
      p_mint: null, // buy-board is always SOL-priced in this codebase
    }),
  });
  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    throw new Error(`insert_board_pixels_atomic rpc failed: ${res.status}${bodyText ? ` — ${bodyText}` : ""}`);
  }
  const rows = (await res.json()) as RpcRow[];
  const row = rows[0];
  if (!row || !row.ok) return { ok: false, reason: row?.reason ?? "conflict" };
  return { ok: true, file: params.file };
}

/**
 * File-store (dev only) fallback. NOT a single transaction — same
 * documented limitation as pixel-insert-atomic.ts's insertViaFileStore.
 */
async function insertViaFileStore(params: InsertBoardParams): Promise<InsertBoardResult> {
  const created = await createBoard(params.file, params.subBlocks);
  if (!created.ok) return created;
  await recordPaymentTransaction({
    signature: params.signature,
    wallet: params.wallet,
    action: params.action,
    amountSol: params.amountSol,
  });
  await recordOwnershipHistoryBatch(
    params.subBlocks.map((p) => ({
      pixelIndex: p.index,
      boardId: params.file.id,
      prevOwner: null,
      newOwner: params.wallet,
      action: params.action,
      signature: params.signature,
    }))
  );
  return { ok: true, file: params.file };
}

export async function insertBoardAtomic(params: InsertBoardParams): Promise<InsertBoardResult> {
  requireDurableStore();
  if (isSupabaseConfigured()) return insertViaSupabaseRpc(params);
  return insertViaFileStore(params);
}
