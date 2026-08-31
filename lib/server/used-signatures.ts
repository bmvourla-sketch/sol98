// Replay protection: every on-chain signature the API accepts as payment
// proof gets recorded here, and can only ever be "claimed" (accepted) ONCE.
// Without this, a single real transfer could be replayed against the API to
// claim unlimited pixels / hijacks / listings for the price of one.
import "server-only";
import { promises as fs } from "fs";
import path from "path";

import { isSupabaseConfigured, supabaseBaseUrl, supabaseHeaders } from "./supabase-env";
import { createMutex } from "./mutex";

const DATA_DIR = path.join(process.cwd(), "data");
const FILE = path.join(DATA_DIR, "used-signatures.json");
const withLock = createMutex();

let cache: Set<string> | null = null;

async function loadFileCache(): Promise<Set<string>> {
  if (cache) return cache;
  try {
    const raw = await fs.readFile(FILE, "utf8");
    const parsed: unknown = JSON.parse(raw);
    cache = new Set(Array.isArray(parsed) ? (parsed as string[]) : []);
  } catch {
    cache = new Set();
  }
  return cache;
}

async function claimFile(signature: string): Promise<boolean> {
  return withLock(async () => {
    const set = await loadFileCache();
    if (set.has(signature)) return false;
    set.add(signature);
    await fs.mkdir(DATA_DIR, { recursive: true });
    const tmp = `${FILE}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(Array.from(set)), "utf8");
    await fs.rename(tmp, FILE);
    return true;
  });
}

async function claimSupabase(signature: string): Promise<boolean> {
  const table = process.env.SIGNATURES_TABLE?.trim() || "used_signatures";
  const res = await fetch(`${supabaseBaseUrl()}/rest/v1/${table}`, {
    method: "POST",
    headers: supabaseHeaders({ "Content-Type": "application/json", Prefer: "return=minimal" }),
    body: JSON.stringify({ signature }),
  });
  if (res.status === 201 || res.status === 204) return true;
  if (res.status === 409) return false; // primary-key conflict = already used
  // PostgREST also reports unique-violations as 409 with a JSON body in
  // some configs; treat any 4xx we don't recognize defensively as "already
  // used" only for 409, otherwise surface a real error.
  throw new Error(`used-signatures write failed: ${res.status}`);
}

/** Returns true the FIRST time a signature is claimed; false on every reuse. */
export async function claimSignature(signature: string): Promise<boolean> {
  if (isSupabaseConfigured()) return claimSupabase(signature);
  return claimFile(signature);
}

/**
 * Best-effort rollback: used ONLY when a signature was claimed but the write
 * it was paying for then failed for an unrelated reason (e.g. a rare
 * cross-instance race on the target index under the Supabase backend), so
 * the payer's proof isn't burned for nothing and they can retry it against
 * a different spot. Never call this after a successful write.
 */
export async function releaseSignature(signature: string): Promise<void> {
  if (isSupabaseConfigured()) {
    const table = process.env.SIGNATURES_TABLE?.trim() || "used_signatures";
    await fetch(`${supabaseBaseUrl()}/rest/v1/${table}?signature=eq.${encodeURIComponent(signature)}`, {
      method: "DELETE",
      headers: supabaseHeaders(),
    }).catch(() => undefined);
    return;
  }
  await withLock(async () => {
    const set = await loadFileCache();
    if (!set.delete(signature)) return;
    await fs.mkdir(DATA_DIR, { recursive: true });
    const tmp = `${FILE}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(Array.from(set)), "utf8");
    await fs.rename(tmp, FILE);
  });
}
