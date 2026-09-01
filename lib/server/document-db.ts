// Server-side store for Board.exe's purchased documents. Same two-backend
// shape as pixel-db.ts, much simpler: documents are only ever appended
// (nobody edits or deletes one), so no conditional-update primitives needed.
import "server-only";
import { promises as fs } from "fs";
import path from "path";

import type { DocumentData } from "@/lib/document-types";
import { isSupabaseConfigured, requireDurableStore, supabaseBaseUrl, supabaseHeaders } from "./supabase-env";
import { createMutex } from "./mutex";

const DATA_DIR = path.join(process.cwd(), "data");
const FILE = path.join(DATA_DIR, "documents.json");
const withLock = createMutex();

let cache: DocumentData[] | null = null;

async function load(): Promise<DocumentData[]> {
  if (cache) return cache;
  try {
    const raw = await fs.readFile(FILE, "utf8");
    const parsed: unknown = JSON.parse(raw);
    cache = Array.isArray(parsed) ? (parsed as DocumentData[]) : [];
  } catch {
    cache = [];
  }
  return cache;
}

function table(): string {
  return process.env.DOCUMENTS_TABLE?.trim() || "documents";
}

export async function readAllDocuments(): Promise<DocumentData[]> {
  if (isSupabaseConfigured()) {
    const res = await fetch(`${supabaseBaseUrl()}/rest/v1/${table()}?select=id,name,content,owner,purchasedAt&order=purchasedAt.asc`, {
      headers: supabaseHeaders(),
    });
    if (!res.ok) throw new Error(`supabase read failed: ${res.status}`);
    return (await res.json()) as DocumentData[];
  }
  return [...(await load())];
}

export async function createDocument(doc: DocumentData): Promise<DocumentData> {
  requireDurableStore();
  if (isSupabaseConfigured()) {
    const res = await fetch(`${supabaseBaseUrl()}/rest/v1/${table()}`, {
      method: "POST",
      headers: supabaseHeaders({ "Content-Type": "application/json", Prefer: "return=representation" }),
      body: JSON.stringify(doc),
    });
    if (!res.ok) throw new Error(`supabase insert failed: ${res.status}`);
    const rows = (await res.json()) as DocumentData[];
    return rows[0] ?? doc;
  }
  return withLock(async () => {
    const list = await load();
    list.push(doc);
    await fs.mkdir(DATA_DIR, { recursive: true });
    const tmp = `${FILE}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(list), "utf8");
    await fs.rename(tmp, FILE);
    return doc;
  });
}
