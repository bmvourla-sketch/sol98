// Server-side store for "Start Ads" board.exe files + their sub-blocks.
// Single file-backed store (data/boards.json) — durable for single-instance
// deploys, guarded by an in-process mutex. Mirrors pixel-db.ts's conditional
// update primitives so the secondary market (buy-listing / rent) and hijack
// re-check the LIVE row before writing (no clobbering under concurrency).
import "server-only";
import { promises as fs } from "fs";
import path from "path";

import {
  boardPixelKey,
  BOARD_FILE_BLOCKS,
  BOARD_BLOCK_BASE_SOL,
  type BoardFile,
  type BoardPixel,
} from "@/lib/board-types";
import { createMutex } from "./mutex";

const DATA_DIR = path.join(process.cwd(), "data");
const FILE = path.join(DATA_DIR, "boards.json");
const withLock = createMutex();

interface BoardsState {
  files: BoardFile[];
  pixels: Record<string, BoardPixel>;
}

let cache: BoardsState | null = null;

async function load(): Promise<BoardsState> {
  if (cache) return cache;
  try {
    const raw = await fs.readFile(FILE, "utf8");
    const parsed: unknown = JSON.parse(raw);
    const obj = parsed && typeof parsed === "object" ? (parsed as Partial<BoardsState>) : {};
    cache = {
      files: Array.isArray(obj.files) ? obj.files : [],
      pixels: obj.pixels && typeof obj.pixels === "object" ? obj.pixels : {},
    };
  } catch {
    cache = { files: [], pixels: {} };
  }
  return cache;
}

async function persist(state: BoardsState): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state), "utf8");
  await fs.rename(tmp, FILE);
}

export type CreateResult = { ok: true; file: BoardFile } | { ok: false; reason: string };
export type MutateResult = { ok: true; pixel: BoardPixel } | { ok: false; reason: string };

/** Whole Start Ads state — every client GETs this same global snapshot. */
export async function readAllBoards(): Promise<BoardsState> {
  const state = await load();
  return { files: [...state.files], pixels: { ...state.pixels } };
}

export async function countBoardFiles(): Promise<number> {
  const state = await load();
  return state.files.length;
}

/** A fresh 10×10 grid of sub-blocks, all owned by `owner`. */
export function makeSubBlocks(boardId: string, owner: string, purchasedAt: number): BoardPixel[] {
  return Array.from({ length: BOARD_FILE_BLOCKS }, (_, index) => ({
    boardId,
    index,
    owner,
    destination: "",
    imageUrl: "",
    message: "",
    neon: "none" as const,
    valuationSol: BOARD_BLOCK_BASE_SOL,
    purchasedAt,
    isRented: false,
  }));
}

/**
 * Creates a board file and its 100 sub-blocks atomically (no partial write).
 */
export async function createBoard(file: BoardFile, subBlocks: BoardPixel[]): Promise<CreateResult> {
  return withLock(async () => {
    const state = await load();
    if (state.files.some((f) => f.id === file.id)) return { ok: false, reason: "already exists" };
    state.files.push(file);
    for (const pixel of subBlocks) {
      state.pixels[boardPixelKey(pixel.boardId, pixel.index)] = pixel;
    }
    await persist(state);
    return { ok: true, file };
  });
}

export async function getBoardPixel(boardId: string, index: number): Promise<BoardPixel | undefined> {
  const state = await load();
  return state.pixels[boardPixelKey(boardId, index)];
}

/**
 * Applies `mutate` to a sub-block ONLY if it exists and its stored owner is
 * `expectedOwner` — used for owner-only actions (edit / list / unlist) and
 * for buy-listing / rent (ownership changes; `expectedOwner` is the seller).
 */
export async function updateBoardPixel(
  boardId: string,
  index: number,
  expectedOwner: string,
  mutate: (current: BoardPixel) => BoardPixel
): Promise<MutateResult> {
  return withLock(async () => {
    const state = await load();
    const key = boardPixelKey(boardId, index);
    const current = state.pixels[key];
    if (!current) return { ok: false, reason: "not_found" };
    if (current.owner !== expectedOwner) return { ok: false, reason: "not_owner" };
    const next = mutate(current);
    state.pixels[key] = next;
    await persist(state);
    return { ok: true, pixel: next };
  });
}

/**
 * Overtakes a sub-block regardless of current owner (hijack targets anyone) —
 * still atomically re-checks the row exists at write time.
 */
/** Renames a board file, only by its current owner. */
export async function renameBoardFile(
  boardId: string,
  expectedOwner: string,
  newName: string
): Promise<CreateResult> {
  return withLock(async () => {
    const state = await load();
    const file = state.files.find((f) => f.id === boardId);
    if (!file) return { ok: false, reason: "not_found" };
    if (file.owner !== expectedOwner) return { ok: false, reason: "not_owner" };
    file.name = newName;
    await persist(state);
    return { ok: true, file };
  });
}

export async function hijackBoardPixel(
  boardId: string,
  index: number,
  mutate: (current: BoardPixel) => BoardPixel
): Promise<MutateResult> {
  return withLock(async () => {
    const state = await load();
    const key = boardPixelKey(boardId, index);
    const current = state.pixels[key];
    if (!current) return { ok: false, reason: "not_found" };
    const next = mutate(current);
    state.pixels[key] = next;
    await persist(state);
    return { ok: true, pixel: next };
  });
}
