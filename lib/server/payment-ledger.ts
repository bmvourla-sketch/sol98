// Server-only, best-effort payment audit ledger — writes to
// `payment_transactions` (see supabase/migrations/0003_ownership_integrity.up.sql).
//
// This is a SECOND, independent safeguard alongside `used_signatures`
// (lib/server/used-signatures.ts) — Red Rule #6 says don't change existing
// auth/payment verification logic, so this module never gates or replaces
// that check. `used_signatures` is what decides whether a signature is
// allowed to pay for anything; `payment_transactions` just durably records
// that a payment happened, with its own DB-level UNIQUE(signature) as a
// belt-and-suspenders idempotency check.
//
// Deliberately best-effort: a customer who already passed verification and
// claimed their signature must not lose their purchase because this
// telemetry write failed. Failures are logged via audit-log, never thrown.
import "server-only";

import { isSupabaseConfigured, supabaseBaseUrl, supabaseHeaders } from "./supabase-env";
import { logAudit } from "./audit-log";

export interface PaymentRecord {
  signature: string;
  wallet: string;
  action: string;
  amountSol?: number;
  mint?: string | null;
}

function table(): string {
  return process.env.PAYMENT_TRANSACTIONS_TABLE?.trim() || "payment_transactions";
}

export async function recordPaymentTransaction(record: PaymentRecord): Promise<void> {
  if (!isSupabaseConfigured()) return; // dev-only file mode has no ledger table
  try {
    const res = await fetch(`${supabaseBaseUrl()}/rest/v1/${table()}`, {
      method: "POST",
      headers: supabaseHeaders({ "Content-Type": "application/json", Prefer: "return=minimal" }),
      body: JSON.stringify({
        signature: record.signature,
        wallet: record.wallet,
        action: record.action,
        amount_sol: record.amountSol ?? null,
        mint: record.mint ?? null,
      }),
    });
    if (res.status === 201 || res.status === 204) {
      logAudit("payment_recorded", { action: record.action, wallet: record.wallet });
      return;
    }
    if (res.status === 409) {
      // Defensive only — used_signatures already gated this signature as
      // single-use before we ever reached this write.
      logAudit("duplicate_transaction_detected", { action: record.action, wallet: record.wallet, where: "payment_transactions" });
      return;
    }
    logAudit("db_failure", { where: "payment_transactions insert", status: res.status, action: record.action });
  } catch (error) {
    logAudit("db_failure", {
      where: "payment_transactions insert",
      action: record.action,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
