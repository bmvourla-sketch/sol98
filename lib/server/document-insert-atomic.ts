// SOL-98 Phase 6 (RED-TEAM HARDENING — BULGU 2, see
// docs/production-readiness/RED-TEAM-FINDINGS.md): app/api/documents/route.ts
// used to do createDocument() followed by a SEPARATE best-effort (never-
// throws) recordPaymentTransaction() call — the exact P2-F4 "ledger
// completeness" gap Phase 3/4 already closed for pixel/board purchases via
// their own atomic RPCs, just never applied to documents. insertDocumentAtomic
// closes it the same way: the document row INSERT and the payment_transactions
// INSERT happen in ONE Postgres transaction (the insert_document_atomic RPC —
// see supabase/migrations/0006_hardening_price_lock_documents_intent_expiry.up.sql).
// A RAISE'd/propagated exception at the ledger step rolls back the document
// insert too — there is no path where a document is created but its sale
// leaves no trace in payment_transactions.
//
// Documents are fixed-price (DOCUMENT_PRICE_SOL, no bonding curve), so unlike
// pixel-insert-atomic.ts / board-insert-atomic.ts there is no price race to
// close here — no advisory lock, no paid-lamports re-check.
import "server-only";

import type { DocumentData } from "@/lib/document-types";
import { createDocument } from "./document-db";
import { isSupabaseConfigured, requireDurableStore, supabaseBaseUrl, supabaseHeaders } from "./supabase-env";
import { recordPaymentTransaction } from "./payment-ledger";

export interface InsertDocumentParams {
  doc: DocumentData;
  signature: string;
  wallet: string;
  action: string; // "buy-document"
  amountSol: number;
}

export type InsertDocumentResult = { ok: true; document: DocumentData } | { ok: false; reason: string };

interface RpcRow {
  ok: boolean;
  reason: string | null;
  doc: DocumentData | null;
}

async function insertViaSupabaseRpc(params: InsertDocumentParams): Promise<InsertDocumentResult> {
  const res = await fetch(`${supabaseBaseUrl()}/rest/v1/rpc/insert_document_atomic`, {
    method: "POST",
    headers: supabaseHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      p_doc: params.doc,
      p_signature: params.signature,
      p_wallet: params.wallet,
      p_action: params.action,
      p_amount_sol: params.amountSol,
    }),
  });
  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    // A RAISE'd/propagated exception inside the function (e.g. the
    // payment_transactions UNIQUE(signature) constraint firing on a
    // duplicate) lands here — surfaced as a thrown error, same contract as
    // insert_pixels_atomic / insert_board_pixels_atomic.
    throw new Error(`insert_document_atomic rpc failed: ${res.status}${bodyText ? ` — ${bodyText}` : ""}`);
  }
  const rows = (await res.json()) as RpcRow[];
  const row = rows[0];
  if (!row || !row.ok) return { ok: false, reason: row?.reason ?? "conflict" };
  return { ok: true, document: row.doc as DocumentData };
}

/**
 * File-store (dev only) fallback. NOT a single transaction — same documented
 * limitation as every other *-insert-atomic.ts file-store path in this
 * codebase.
 */
async function insertViaFileStore(params: InsertDocumentParams): Promise<InsertDocumentResult> {
  const created = await createDocument(params.doc);
  await recordPaymentTransaction({
    signature: params.signature,
    wallet: params.wallet,
    action: params.action,
    amountSol: params.amountSol,
  });
  return { ok: true, document: created };
}

export async function insertDocumentAtomic(params: InsertDocumentParams): Promise<InsertDocumentResult> {
  requireDurableStore();
  if (isSupabaseConfigured()) return insertViaSupabaseRpc(params);
  return insertViaFileStore(params);
}
