// Structured, secret-free observability for the critical events Phase 1
// requires: payment verification, ownership mutation, ownership conflict, DB
// failure, duplicate transaction, authorization failure.
//
// NEVER pass a private key, the Supabase service-role key, a full raw
// transaction signature, or signed-message bytes to `fields` — only public
// wallet addresses (already public on-chain), board/pixel indices, action
// names, HTTP-ish status/reason strings, and short error messages. Callers
// are responsible for not passing secrets in; this module does not attempt
// to scrub `fields` itself; there is nothing under lib/server that reads a
// raw private key at all, so the concrete risk is a caller accidentally
// including a full signature or an env var value.
//
// console.* is deliberate: this app has no logging infra of its own, and
// Vercel / most Node hosts capture stdout/stderr as structured logs already.
import "server-only";

export type AuditEvent =
  | "payment_verified"
  | "payment_verification_failed"
  | "payment_recorded"
  | "ownership_mutation"
  | "ownership_conflict"
  | "db_failure"
  | "duplicate_transaction_detected"
  | "authorization_failure"
  // SOL-98 Phase 3 (MARKET SECURITY) — a purchase_intent was created via
  // POST /api/purchase-intents.
  | "intent_created";

const ERROR_EVENTS = new Set<AuditEvent>(["db_failure", "ownership_conflict", "authorization_failure", "payment_verification_failed"]);

export function logAudit(event: AuditEvent, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ event, ts: new Date().toISOString(), ...fields });
  if (ERROR_EVENTS.has(event)) {
    console.error(`[audit] ${line}`);
  } else {
    console.log(`[audit] ${line}`);
  }
}
