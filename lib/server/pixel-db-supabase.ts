// Supabase (PostgREST) backend for the shared board. Selected automatically
// by `pixel-db.ts` when `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` are set.
//
// Every write here uses PostgREST's row-filtered PATCH (`?index=eq.N&
// data->>owner=eq.OWNER`) instead of a blind upsert — Postgres evaluates
// that WHERE clause against the LIVE row at UPDATE time, so two concurrent
// requests racing the same row can't both "win": whichever lands first
// changes the owner, and the second's WHERE simply stops matching.
//
// NOTE: this path is code-complete but UNTESTED locally — it requires a
// Supabase project with the `pixels` table (see README). Uses the PostgREST
// HTTP API directly (no SDK) with the service-role key (bypasses RLS).
import "server-only";

import type { PixelData } from "@/lib/pixel-types";
import { supabaseBaseUrl, supabaseHeaders } from "./supabase-env";
import type { CreateResult, MutateGroupResult, MutateResult } from "./pixel-db";

interface PixelRow {
  index: number;
  data: PixelData;
}

function table(): string {
  return process.env.PIXELS_TABLE?.trim() || "pixels";
}

export async function readAllPixels(): Promise<Record<number, PixelData>> {
  const res = await fetch(`${supabaseBaseUrl()}/rest/v1/${table()}?select=index,data`, {
    headers: supabaseHeaders(),
  });
  if (!res.ok) throw new Error(`supabase read failed: ${res.status}`);
  const rows = (await res.json()) as PixelRow[];
  const out: Record<number, PixelData> = {};
  for (const row of rows) out[row.index] = row.data;
  return out;
}

export async function getPixel(index: number): Promise<PixelData | undefined> {
  const res = await fetch(`${supabaseBaseUrl()}/rest/v1/${table()}?index=eq.${index}&select=data`, {
    headers: supabaseHeaders(),
  });
  if (!res.ok) throw new Error(`supabase read failed: ${res.status}`);
  const rows = (await res.json()) as PixelRow[];
  return rows[0]?.data;
}

export async function getPixels(indices: number[]): Promise<Map<number, PixelData>> {
  if (indices.length === 0) return new Map();
  const list = indices.join(",");
  const res = await fetch(`${supabaseBaseUrl()}/rest/v1/${table()}?index=in.(${list})&select=index,data`, {
    headers: supabaseHeaders(),
  });
  if (!res.ok) throw new Error(`supabase read failed: ${res.status}`);
  const rows = (await res.json()) as PixelRow[];
  const map = new Map<number, PixelData>();
  for (const row of rows) map.set(row.index, row.data);
  return map;
}

export async function soldCount(): Promise<number> {
  const res = await fetch(`${supabaseBaseUrl()}/rest/v1/${table()}?select=index`, {
    headers: supabaseHeaders({ Prefer: "count=exact", Range: "0-0" }),
  });
  if (!res.ok) throw new Error(`supabase count failed: ${res.status}`);
  const range = res.headers.get("content-range"); // e.g. "0-0/1234"
  const total = range?.split("/")[1];
  return total ? parseInt(total, 10) : 0;
}

export async function createPixels(records: PixelData[]): Promise<CreateResult> {
  const body = records.map((r) => ({ index: r.index, data: r }));
  const res = await fetch(`${supabaseBaseUrl()}/rest/v1/${table()}`, {
    method: "POST",
    headers: supabaseHeaders({ "Content-Type": "application/json", Prefer: "return=minimal" }),
    body: JSON.stringify(body),
  });
  if (res.status === 201 || res.status === 204) return { ok: true };
  if (res.status === 409) {
    const existing = await getPixels(records.map((r) => r.index));
    return { ok: false, taken: Array.from(existing.keys()) };
  }
  throw new Error(`supabase insert failed: ${res.status}`);
}

export async function updateOwnedPixel(
  index: number,
  expectedOwner: string,
  mutate: (current: PixelData) => PixelData
): Promise<MutateResult> {
  const current = await getPixel(index);
  if (!current) return { ok: false, reason: "not_found" };
  if (current.owner !== expectedOwner) return { ok: false, reason: "not_owner" };
  const next = mutate(current);
  const res = await fetch(
    `${supabaseBaseUrl()}/rest/v1/${table()}?index=eq.${index}&data->>owner=eq.${encodeURIComponent(expectedOwner)}`,
    {
      method: "PATCH",
      headers: supabaseHeaders({ "Content-Type": "application/json", Prefer: "return=representation" }),
      body: JSON.stringify({ data: next }),
    }
  );
  if (!res.ok) throw new Error(`supabase update failed: ${res.status}`);
  const rows = (await res.json()) as PixelRow[];
  if (rows.length === 0) return { ok: false, reason: "conflict" };
  return { ok: true, pixel: rows[0].data };
}

export async function updateGroupOwnedPixels(
  groupId: string,
  expectedOwner: string,
  mutate: (current: PixelData) => PixelData
): Promise<MutateGroupResult> {
  const res = await fetch(
    `${supabaseBaseUrl()}/rest/v1/${table()}?data->>bannerGroupId=eq.${encodeURIComponent(
      groupId
    )}&data->>owner=eq.${encodeURIComponent(expectedOwner)}&select=data`,
    { headers: supabaseHeaders() }
  );
  if (!res.ok) throw new Error(`supabase read failed: ${res.status}`);
  const rows = (await res.json()) as PixelRow[];
  if (rows.length === 0) return { ok: false, reason: "not_found" };

  const updated: PixelData[] = [];
  for (const row of rows) {
    const next = mutate(row.data);
    const patchRes = await fetch(
      `${supabaseBaseUrl()}/rest/v1/${table()}?index=eq.${next.index}&data->>owner=eq.${encodeURIComponent(
        expectedOwner
      )}`,
      {
        method: "PATCH",
        headers: supabaseHeaders({ "Content-Type": "application/json", Prefer: "return=representation" }),
        body: JSON.stringify({ data: next }),
      }
    );
    if (!patchRes.ok) throw new Error(`supabase update failed: ${patchRes.status}`);
    const patched = (await patchRes.json()) as PixelRow[];
    if (patched[0]) updated.push(patched[0].data);
  }
  if (updated.length === 0) return { ok: false, reason: "conflict" };
  return { ok: true, pixels: updated };
}

export async function hijackPixel(
  index: number,
  mutate: (current: PixelData) => PixelData
): Promise<MutateResult> {
  const current = await getPixel(index);
  if (!current) return { ok: false, reason: "not_found" };
  const next = mutate(current);
  const res = await fetch(
    `${supabaseBaseUrl()}/rest/v1/${table()}?index=eq.${index}&data->>owner=eq.${encodeURIComponent(current.owner)}`,
    {
      method: "PATCH",
      headers: supabaseHeaders({ "Content-Type": "application/json", Prefer: "return=representation" }),
      body: JSON.stringify({ data: next }),
    }
  );
  if (!res.ok) throw new Error(`supabase update failed: ${res.status}`);
  const rows = (await res.json()) as PixelRow[];
  if (rows.length === 0) {
    return { ok: false, reason: "conflict — someone else just changed this spot, please retry" };
  }
  return { ok: true, pixel: rows[0].data };
}
