import { promises as fs } from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BoardFile, BoardPixel } from "../lib/board-types";

const DATA_DIR = path.join(process.cwd(), "data");

async function rmForce(target: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await fs.rm(target, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EPERM" && code !== "EBUSY" && code !== "ENOTEMPTY") throw err;
      await new Promise((resolve) => setTimeout(resolve, 40 * (attempt + 1)));
    }
  }
}

async function freshStore() {
  vi.resetModules();
  await rmForce(DATA_DIR);
  return import("../lib/server/board-db");
}

function makeFile(id: string, owner: string): BoardFile {
  return { id, name: "Board.exe", owner, purchasedAt: Date.now(), priceSol: 2 };
}

describe("board-db (Start Ads) — atomicity", () => {
  beforeEach(async () => {
    await rmForce(DATA_DIR);
  });
  afterEach(async () => {
    await rmForce(DATA_DIR);
  });

  it("makeSubBlocks yields exactly 100 sub-blocks owned by the buyer", async () => {
    const store = await freshStore();
    const blocks = store.makeSubBlocks("b-1", "Alice", Date.now());
    expect(blocks).toHaveLength(100);
    expect(blocks.every((b) => b.owner === "Alice" && b.boardId === "b-1")).toBe(true);
    expect(new Set(blocks.map((b) => b.index)).size).toBe(100);
  });

  it("createBoard writes the file and all its sub-blocks atomically", async () => {
    const store = await freshStore();
    const file = makeFile("b-1", "Alice");
    const subs = store.makeSubBlocks(file.id, file.owner, file.purchasedAt);
    const result = await store.createBoard(file, subs);
    expect(result.ok).toBe(true);

    const { files, pixels } = await store.readAllBoards();
    expect(files).toHaveLength(1);
    expect(Object.keys(pixels)).toHaveLength(100);
    expect(await store.countBoardFiles()).toBe(1);
  });

  it("createBoard refuses to create a file with a duplicate id", async () => {
    const store = await freshStore();
    const file = makeFile("b-dup", "Alice");
    const subs = store.makeSubBlocks(file.id, file.owner, file.purchasedAt);
    expect((await store.createBoard(file, subs)).ok).toBe(true);
    const second = await store.createBoard(file, subs);
    expect(second.ok).toBe(false);
    expect(await store.countBoardFiles()).toBe(1); // no duplicate landed
  });

  it("two concurrent buy-board creates for the same id: exactly one wins", async () => {
    const store = await freshStore();
    const file = makeFile("b-race", "Racer");
    const subs = store.makeSubBlocks(file.id, file.owner, file.purchasedAt);
    const [a, b] = await Promise.all([store.createBoard(file, subs), store.createBoard(file, subs)]);
    expect([a.ok, b.ok].filter(Boolean).length).toBe(1);
  });

  it("updateBoardPixel refuses a write from a non-owner (ownership check re-validated server-side)", async () => {
    const store = await freshStore();
    const file = makeFile("b-1", "Alice");
    await store.createBoard(file, store.makeSubBlocks(file.id, file.owner, file.purchasedAt));

    const result = await store.updateBoardPixel(file.id, 0, "Mallory", (p) => ({ ...p, message: "pwned" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not_owner");

    const stored = await store.getBoardPixel(file.id, 0);
    expect(stored?.message).toBe("");
  });

  it("updateBoardPixel applies the mutation when the owner matches", async () => {
    const store = await freshStore();
    const file = makeFile("b-1", "Alice");
    await store.createBoard(file, store.makeSubBlocks(file.id, file.owner, file.purchasedAt));

    const result = await store.updateBoardPixel(file.id, 0, "Alice", (p) => ({ ...p, message: "gm" }));
    expect(result.ok).toBe(true);
    expect((await store.getBoardPixel(file.id, 0))?.message).toBe("gm");
  });

  it("hijackBoardPixel overtakes regardless of current owner, but requires the block to exist", async () => {
    const store = await freshStore();
    const file = makeFile("b-1", "Alice");
    await store.createBoard(file, store.makeSubBlocks(file.id, file.owner, file.purchasedAt));

    const missing = await store.hijackBoardPixel(file.id, 999, (p: BoardPixel) => ({ ...p, owner: "Hijacker" }));
    expect(missing.ok).toBe(false);

    const result = await store.hijackBoardPixel(file.id, 3, (p) => ({ ...p, owner: "Hijacker" }));
    expect(result.ok).toBe(true);
    expect((await store.getBoardPixel(file.id, 3))?.owner).toBe("Hijacker");
  });

  it("renameBoardFile only lets the OWNER rename their board.exe file", async () => {
    const store = await freshStore();
    const file = makeFile("b-1", "Alice");
    await store.createBoard(file, store.makeSubBlocks(file.id, file.owner, file.purchasedAt));

    const denied = await store.renameBoardFile(file.id, "Mallory", "Stolen Name");
    expect(denied.ok).toBe(false);

    const allowed = await store.renameBoardFile(file.id, "Alice", "Alice's Ads");
    expect(allowed.ok).toBe(true);
    if (allowed.ok) expect(allowed.file.name).toBe("Alice's Ads");
  });

  it("renameBoardFile on a nonexistent board fails cleanly", async () => {
    const store = await freshStore();
    const result = await store.renameBoardFile("nope", "Alice", "X");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not_found");
  });
});
