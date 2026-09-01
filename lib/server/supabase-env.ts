// Shared Supabase (PostgREST) config helpers — used by every server store
// (pixels, used-signatures, documents) that can optionally persist to
// Supabase instead of the local file store. Server-only: reads the
// SERVICE ROLE key, which must never reach the client bundle.
import "server-only";

function env(name: string): string {
  return process.env[name]?.trim() ?? "";
}

export function isSupabaseConfigured(): boolean {
  return Boolean(env("SUPABASE_URL") && env("SUPABASE_SERVICE_ROLE_KEY"));
}

export function supabaseBaseUrl(): string {
  return env("SUPABASE_URL");
}

export function supabaseServiceKey(): string {
  return env("SUPABASE_SERVICE_ROLE_KEY");
}

export function supabaseHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    apikey: supabaseServiceKey(),
    Authorization: `Bearer ${supabaseServiceKey()}`,
    ...extra,
  };
}

/**
 * Phase 1 production-DB gate (SOL-98 red rule #1–#4): once this app can
 * accept real money, pixel/board ownership must never silently fall back to
 * the local JSON file store. Every WRITE path in pixel-db.ts, board-db.ts,
 * document-db.ts and used-signatures.ts calls this FIRST.
 *
 * - `NODE_ENV=production` + no Supabase config → throws. Callers do not
 *   catch this — it propagates up to the API route's try/catch, which turns
 *   it into a plain 500 response. No JSON write ever happens in production
 *   without durable config. This is the fail-closed behavior; there is no
 *   fallback path here by design.
 * - Any other NODE_ENV (`development`, `test`, unset) → no-op, so local dev
 *   and the existing test suite keep using the file store exactly as today.
 *
 * Reads are NOT gated — GET endpoints keep working (serving whatever the
 * configured backend currently has) even if this check would fail, since a
 * read can't corrupt ownership.
 */
export function requireDurableStore(): void {
  if (process.env.NODE_ENV === "production" && !isSupabaseConfigured()) {
    throw new Error(
      "durable store unavailable in production — configure SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (no JSON fallback in production, see docs/production-readiness/PHASE-1-DATABASE.md)"
    );
  }
}
