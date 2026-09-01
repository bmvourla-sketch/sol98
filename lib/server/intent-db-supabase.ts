// Supabase (PostgREST) backend for `purchase_intents` (see
// supabase/migrations/0004_purchase_intents_and_atomicity.up.sql). Selected
// automatically by intent-db.ts when SUPABASE_URL +
// SUPABASE_SERVICE_ROLE_KEY are set.
//
// Creation/read here are plain PostgREST calls. CONSUMPTION is deliberately
// NOT exposed from this module — it happens exclusively inside the
// update_*_owner_atomic RPC functions (called directly from
// pixel-mutations-atomic.ts / board-mutations-atomic.ts), so that consuming
// an intent and mutating ownership are the SAME Postgres transaction. A
// second, independent "consume intent" write here would reintroduce
// exactly the non-atomicity this phase exists to close.
import "server-only";

import { supabaseBaseUrl, supabaseHeaders } from "./supabase-env";
import type { PurchaseIntent } from "./intent-db";

function table(): string {
  return process.env.PURCHASE_INTENTS_TABLE?.trim() || "purchase_intents";
}

interface IntentRow {
  id: string;
  action_type: string;
  board_id: string | null;
  pixel_index: number;
  buyer_wallet: string;
  seller_wallet: string;
  currency: string;
  price_sol: number | null;
  price_pixel98: number | null;
  mint: string | null;
  rent_days: number | null;
  status: string;
  expires_at: string;
  created_at: string;
  consumed_at: string | null;
  consumed_by_signature: string | null;
}

function toRow(intent: PurchaseIntent) {
  return {
    id: intent.id,
    action_type: intent.actionType,
    board_id: intent.boardId,
    pixel_index: intent.pixelIndex,
    buyer_wallet: intent.buyerWallet,
    seller_wallet: intent.sellerWallet,
    currency: intent.currency,
    price_sol: intent.priceSol ?? null,
    price_pixel98: intent.pricePixel98 ?? null,
    mint: intent.mint ?? null,
    rent_days: intent.rentDays ?? null,
    status: intent.status,
    expires_at: new Date(intent.expiresAt).toISOString(),
  };
}

function fromRow(row: IntentRow): PurchaseIntent {
  return {
    id: row.id,
    actionType: row.action_type as PurchaseIntent["actionType"],
    boardId: row.board_id,
    pixelIndex: row.pixel_index,
    buyerWallet: row.buyer_wallet,
    sellerWallet: row.seller_wallet,
    currency: row.currency as PurchaseIntent["currency"],
    priceSol: row.price_sol ?? undefined,
    pricePixel98: row.price_pixel98 ?? undefined,
    mint: row.mint,
    rentDays: row.rent_days ?? undefined,
    status: row.status as PurchaseIntent["status"],
    expiresAt: new Date(row.expires_at).getTime(),
    createdAt: new Date(row.created_at).getTime(),
    consumedAt: row.consumed_at ? new Date(row.consumed_at).getTime() : undefined,
    consumedBySignature: row.consumed_by_signature ?? undefined,
  };
}

export async function createIntent(intent: PurchaseIntent): Promise<PurchaseIntent> {
  const res = await fetch(`${supabaseBaseUrl()}/rest/v1/${table()}`, {
    method: "POST",
    headers: supabaseHeaders({ "Content-Type": "application/json", Prefer: "return=representation" }),
    body: JSON.stringify(toRow(intent)),
  });
  if (!res.ok) throw new Error(`supabase intent insert failed: ${res.status}`);
  const rows = (await res.json()) as IntentRow[];
  if (!rows[0]) throw new Error("supabase intent insert returned no row");
  return fromRow(rows[0]);
}

export async function getIntent(id: string): Promise<PurchaseIntent | undefined> {
  const res = await fetch(`${supabaseBaseUrl()}/rest/v1/${table()}?id=eq.${encodeURIComponent(id)}&select=*`, {
    headers: supabaseHeaders(),
  });
  if (!res.ok) throw new Error(`supabase intent read failed: ${res.status}`);
  const rows = (await res.json()) as IntentRow[];
  return rows[0] ? fromRow(rows[0]) : undefined;
}
