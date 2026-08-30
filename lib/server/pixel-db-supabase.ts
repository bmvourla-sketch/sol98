// Supabase (PostgREST) backend for the shared board. Selected automatically
// by `pixel-db.ts` when `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` are set.
//
// NOTE: this path is code-complete but UNTESTED locally — it requires a
// Supabase project with the `pixels` table (see README). Uses the PostgREST
// HTTP API directly (no SDK) with the service-role key (bypasses RLS).
export interface PixelRow {
  index: number;
  data: unknown;
}

function env(name: string): string {
  return process.env[name]?.trim() ?? "";
}

export function isSupabaseConfigured(): boolean {
  return Boolean(env("SUPABASE_URL") && env("SUPABASE_SERVICE_ROLE_KEY"));
}

function baseUrl(): string {
  return env("SUPABASE_URL");
}

function key(): string {
  return env("SUPABASE_SERVICE_ROLE_KEY");
}

function table(): string {
  return env("PIXELS_TABLE") || "pixels";
}

export async function supabaseReadPixels(): Promise<Record<number, unknown>> {
  const res = await fetch(`${baseUrl()}/rest/v1/${table()}?select=index,data`, {
    headers: { apikey: key(), Authorization: `Bearer ${key()}` },
  });
  if (!res.ok) throw new Error(`supabase read failed: ${res.status}`);
  const rows = (await res.json()) as PixelRow[];
  const out: Record<number, unknown> = {};
  for (const row of rows) out[row.index] = row.data;
  return out;
}

export async function supabaseWritePixel(pixel: unknown): Promise<void> {
  const rec = pixel as { index?: number };
  if (typeof rec?.index !== "number") throw new Error("pixel.index must be a number");
  const res = await fetch(`${baseUrl()}/rest/v1/${table()}`, {
    method: "POST",
    headers: {
      apikey: key(),
      Authorization: `Bearer ${key()}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify({ index: rec.index, data: pixel }),
  });
  if (!res.ok) throw new Error(`supabase write failed: ${res.status}`);
}
