// Supabase (PostgREST) backend for "Start Ads" (board.exe files + their 100
// sub-blocks each). Selected automatically by `board-db.ts` when
// SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are set — added in Phase 1
// because board-db.ts previously had NO durable backend at all (file store
// only), a real-money gap found during the Phase 1 store inventory.
//
// Mirrors pixel-db-supabase.ts's pattern exactly: every ownership-changing
// write uses PostgREST's row-filtered PATCH (`?board_id=eq.B&index=eq.N&
// data->>owner=eq.OWNER`) instead of a blind upsert, so Postgres evaluates
// that WHERE clause against the LIVE row at UPDATE time — two concurrent
// requests racing the same sub-block can't both "win".
import "server-only";

import type { BoardFile, BoardPixel } from "@/lib/board-types";
import { supabaseBaseUrl, supabaseHeaders } from "./supabase-env";
import type { CreateResult, MutateResult } from "./board-db";

interface BoardFileRow {
  id: string;
  data: BoardFile;
}

interface BoardPixelRow {
  board_id: string;
  index: number;
  data: BoardPixel;
}

function filesTable(): string {
  return process.env.BOARD_FILES_TABLE?.trim() || "board_files";
}

function pixelsTable(): string {
  return process.env.BOARD_PIXELS_TABLE?.trim() || "board_pixels";
}

export async function readAllBoards(): Promise<{ files: BoardFile[]; pixels: Record<string, BoardPixel> }> {
  const [filesRes, pixelsRes] = await Promise.all([
    fetch(`${supabaseBaseUrl()}/rest/v1/${filesTable()}?select=data`, { headers: supabaseHeaders() }),
    fetch(`${supabaseBaseUrl()}/rest/v1/${pixelsTable()}?select=board_id,index,data`, { headers: supabaseHeaders() }),
  ]);
  if (!filesRes.ok) throw new Error(`supabase read failed: ${filesRes.status}`);
  if (!pixelsRes.ok) throw new Error(`supabase read failed: ${pixelsRes.status}`);
  const fileRows = (await filesRes.json()) as BoardFileRow[];
  const pixelRows = (await pixelsRes.json()) as BoardPixelRow[];
  const pixels: Record<string, BoardPixel> = {};
  for (const row of pixelRows) pixels[`${row.board_id}:${row.index}`] = row.data;
  return { files: fileRows.map((r) => r.data), pixels };
}

export async function countBoardFiles(): Promise<number> {
  const res = await fetch(`${supabaseBaseUrl()}/rest/v1/${filesTable()}?select=id`, {
    headers: supabaseHeaders({ Prefer: "count=exact", Range: "0-0" }),
  });
  if (!res.ok) throw new Error(`supabase count failed: ${res.status}`);
  const range = res.headers.get("content-range");
  const total = range?.split("/")[1];
  return total ? parseInt(total, 10) : 0;
}

/**
 * Creates a board file and its sub-blocks. Not a single Postgres transaction
 * (PostgREST has no multi-statement transaction endpoint) — the file row is
 * inserted FIRST; if that succeeds but a sub-block insert then fails, the
 * caller sees an error (not a silent partial success), and the orphaned
 * file row is cleaned up before re-throwing so a failed purchase can't leave
 * a half-created board.exe behind. board file IDs are timestamp+random, so a
 * PK collision here is effectively impossible in practice; the 409 branch
 * exists for correctness, not because it's expected to fire.
 */
export async function createBoard(file: BoardFile, subBlocks: BoardPixel[]): Promise<CreateResult> {
  const fileRes = await fetch(`${supabaseBaseUrl()}/rest/v1/${filesTable()}`, {
    method: "POST",
    headers: supabaseHeaders({ "Content-Type": "application/json", Prefer: "return=minimal" }),
    body: JSON.stringify([{ id: file.id, data: file }]),
  });
  if (fileRes.status === 409) return { ok: false, reason: "already exists" };
  if (!(fileRes.status === 201 || fileRes.status === 204)) {
    throw new Error(`supabase insert failed: ${fileRes.status}`);
  }

  const pixelBody = subBlocks.map((p) => ({ board_id: p.boardId, index: p.index, data: p }));
  const pixelsRes = await fetch(`${supabaseBaseUrl()}/rest/v1/${pixelsTable()}`, {
    method: "POST",
    headers: supabaseHeaders({ "Content-Type": "application/json", Prefer: "return=minimal" }),
    body: JSON.stringify(pixelBody),
  });
  if (!(pixelsRes.status === 201 || pixelsRes.status === 204)) {
    // Clean up the orphaned file row so we don't leave a board.exe with zero
    // sub-blocks behind — best-effort; the write error still propagates.
    await fetch(`${supabaseBaseUrl()}/rest/v1/${filesTable()}?id=eq.${encodeURIComponent(file.id)}`, {
      method: "DELETE",
      headers: supabaseHeaders(),
    }).catch(() => undefined);
    throw new Error(`supabase insert failed: ${pixelsRes.status}`);
  }
  return { ok: true, file };
}

export async function getBoardPixel(boardId: string, index: number): Promise<BoardPixel | undefined> {
  const res = await fetch(
    `${supabaseBaseUrl()}/rest/v1/${pixelsTable()}?board_id=eq.${encodeURIComponent(boardId)}&index=eq.${index}&select=data`,
    { headers: supabaseHeaders() }
  );
  if (!res.ok) throw new Error(`supabase read failed: ${res.status}`);
  const rows = (await res.json()) as BoardPixelRow[];
  return rows[0]?.data;
}

export async function updateBoardPixel(
  boardId: string,
  index: number,
  expectedOwner: string,
  mutate: (current: BoardPixel) => BoardPixel
): Promise<MutateResult> {
  const current = await getBoardPixel(boardId, index);
  if (!current) return { ok: false, reason: "not_found" };
  if (current.owner !== expectedOwner) return { ok: false, reason: "not_owner" };
  const next = mutate(current);
  const res = await fetch(
    `${supabaseBaseUrl()}/rest/v1/${pixelsTable()}?board_id=eq.${encodeURIComponent(boardId)}&index=eq.${index}&data->>owner=eq.${encodeURIComponent(
      expectedOwner
    )}`,
    {
      method: "PATCH",
      headers: supabaseHeaders({ "Content-Type": "application/json", Prefer: "return=representation" }),
      body: JSON.stringify({ data: next }),
    }
  );
  if (!res.ok) throw new Error(`supabase update failed: ${res.status}`);
  const rows = (await res.json()) as BoardPixelRow[];
  if (rows.length === 0) return { ok: false, reason: "conflict" };
  return { ok: true, pixel: rows[0].data };
}

export async function renameBoardFile(boardId: string, expectedOwner: string, newName: string): Promise<CreateResult> {
  const res = await fetch(`${supabaseBaseUrl()}/rest/v1/${filesTable()}?id=eq.${encodeURIComponent(boardId)}&select=data`, {
    headers: supabaseHeaders(),
  });
  if (!res.ok) throw new Error(`supabase read failed: ${res.status}`);
  const rows = (await res.json()) as BoardFileRow[];
  const current = rows[0]?.data;
  if (!current) return { ok: false, reason: "not_found" };
  if (current.owner !== expectedOwner) return { ok: false, reason: "not_owner" };
  const next: BoardFile = { ...current, name: newName };
  const patchRes = await fetch(
    `${supabaseBaseUrl()}/rest/v1/${filesTable()}?id=eq.${encodeURIComponent(boardId)}&data->>owner=eq.${encodeURIComponent(
      expectedOwner
    )}`,
    {
      method: "PATCH",
      headers: supabaseHeaders({ "Content-Type": "application/json", Prefer: "return=representation" }),
      body: JSON.stringify({ data: next }),
    }
  );
  if (!patchRes.ok) throw new Error(`supabase update failed: ${patchRes.status}`);
  const patched = (await patchRes.json()) as BoardFileRow[];
  if (patched.length === 0) return { ok: false, reason: "conflict" };
  return { ok: true, file: patched[0].data };
}

export async function hijackBoardPixel(
  boardId: string,
  index: number,
  mutate: (current: BoardPixel) => BoardPixel
): Promise<MutateResult> {
  const current = await getBoardPixel(boardId, index);
  if (!current) return { ok: false, reason: "not_found" };
  const next = mutate(current);
  const res = await fetch(
    `${supabaseBaseUrl()}/rest/v1/${pixelsTable()}?board_id=eq.${encodeURIComponent(boardId)}&index=eq.${index}&data->>owner=eq.${encodeURIComponent(
      current.owner
    )}`,
    {
      method: "PATCH",
      headers: supabaseHeaders({ "Content-Type": "application/json", Prefer: "return=representation" }),
      body: JSON.stringify({ data: next }),
    }
  );
  if (!res.ok) throw new Error(`supabase update failed: ${res.status}`);
  const rows = (await res.json()) as BoardPixelRow[];
  if (rows.length === 0) {
    return { ok: false, reason: "conflict — someone else just changed this spot, please retry" };
  }
  return { ok: true, pixel: rows[0].data };
}
