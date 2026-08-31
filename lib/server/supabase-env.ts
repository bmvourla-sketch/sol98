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
