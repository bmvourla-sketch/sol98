// Server-only append-only ownership audit trail — writes to
// `pixel_ownership_history` (see supabase/migrations/0003_ownership_integrity.up.sql).
//
// Only ever called from server route handlers, AFTER a mutation has already
// won its DB-level conditional-update race (see pixel-db-supabase.ts /
// board-db-supabase.ts) — never from client code, never derived from
// client-claimed state. Covers actions that actually change `owner`: buy,
// buy-area, hijack, buy-listing. Rent is deliberately NOT logged here — it
// changes usage rights (rentedTo/rentedUntil), not `owner` — it's still
// captured in payment_transactions.
//
// Best-effort like payment-ledger.ts: a failed history write must not roll
// back an already-successful ownership change; failures are logged via
// audit-log, never thrown.
import "server-only";

import { isSupabaseConfigured, supabaseBaseUrl, supabaseHeaders } from "./supabase-env";
import { logAudit } from "./audit-log";

export interface OwnershipHistoryRecord {
  pixelIndex: number;
  boardId?: string | null;
  prevOwner?: string | null;
  newOwner: string;
  action: string;
  signature?: string | null;
}

function table(): string {
  return process.env.OWNERSHIP_HISTORY_TABLE?.trim() || "pixel_ownership_history";
}

function toRow(record: OwnershipHistoryRecord) {
  return {
    pixel_index: record.pixelIndex,
    board_id: record.boardId ?? null,
    prev_owner: record.prevOwner ?? null,
    new_owner: record.newOwner,
    action: record.action,
    signature: record.signature ?? null,
  };
}

async function insert(rows: ReturnType<typeof toRow>[], action: string): Promise<void> {
  if (!isSupabaseConfigured() || rows.length === 0) return;
  try {
    const res = await fetch(`${supabaseBaseUrl()}/rest/v1/${table()}`, {
      method: "POST",
      headers: supabaseHeaders({ "Content-Type": "application/json", Prefer: "return=minimal" }),
      body: JSON.stringify(rows),
    });
    if (res.status === 201 || res.status === 204) {
      logAudit("ownership_mutation", { action, count: rows.length });
      return;
    }
    logAudit("db_failure", { where: "pixel_ownership_history insert", status: res.status, action });
  } catch (error) {
    logAudit("db_failure", {
      where: "pixel_ownership_history insert",
      action,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Single ownership change (buy / hijack / buy-listing on one spot). */
export async function recordOwnershipHistory(record: OwnershipHistoryRecord): Promise<void> {
  await insert([toRow(record)], record.action);
}

/** Multiple spots changing owner in one action (buy-area / buy-board), one batched insert. */
export async function recordOwnershipHistoryBatch(records: OwnershipHistoryRecord[]): Promise<void> {
  if (records.length === 0) return;
  await insert(
    records.map(toRow),
    records[0].action
  );
}
