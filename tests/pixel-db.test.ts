import { promises as fs } from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PixelData } from "../lib/pixel-types";

const DATA_DIR = path.join(process.cwd(), "data");
const PIXELS_FILE = path.join(DATA_DIR, "pixels.json");

function makePixel(index: number, owner: string): PixelData {
  return {
    index,
    owner,
    destination: "",
    imageUrl: "",
    message: "",
    neon: "none",
    valuationSol: 0.2,
    purchasedAt: Date.now(),
    isRented: false,
  };
}

// Windows can hold a transient handle on `data/` right after a write/rename,
// so `rm` there occasionally fails with EPERM/EBUSY. Retry briefly.
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
  // Each test gets an isolated module instance (the file store keeps an
  // in-memory cache at module scope) and starts from an empty data file.
  vi.resetModules();
  await rmForce(PIXELS_FILE);
  return import("../lib/server/pixel-db");
}

describe("pixel-db file backend — atomicity", () => {
  beforeEach(async () => {
    await rmForce(DATA_DIR);
  });
  afterEach(async () => {
    await rmForce(DATA_DIR);
  });

  it("createPixels never lets two concurrent buys land on the same index", async () => {
    const store = await freshStore();
    const [a, b] = await Promise.all([
      store.createPixels([makePixel(5, "OwnerA")]),
      store.createPixels([makePixel(5, "OwnerB")]),
    ]);
    // Exactly one of the two concurrent "buy index 5" calls may succeed.
    expect([a.ok, b.ok].filter(Boolean).length).toBe(1);

    const stored = await store.getPixel(5);
    expect(stored).toBeDefined();
    const winner = a.ok ? "OwnerA" : "OwnerB";
    expect(stored?.owner).toBe(winner);
  });

  it("createPixels rejects the WHOLE batch if any index is already taken (no partial write)", async () => {
    const store = await freshStore();
    await store.createPixels([makePixel(1, "Alice")]);
    const result = await store.createPixels([makePixel(1, "Bob"), makePixel(2, "Bob")]);
    expect(result.ok).toBe(false);
    // Index 2 must NOT have been written even though it wasn't the conflict.
    expect(await store.getPixel(2)).toBeUndefined();
    expect((await store.getPixel(1))?.owner).toBe("Alice");
  });

  it("updateOwnedPixel refuses a write from a non-owner", async () => {
    const store = await freshStore();
    await store.createPixels([makePixel(1, "Alice")]);
    const result = await store.updateOwnedPixel(1, "Mallory", (p) => ({ ...p, message: "pwned" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not_owner");
    expect((await store.getPixel(1))?.message).toBe("");
  });

  it("updateOwnedPixel applies the mutation when the owner matches", async () => {
    const store = await freshStore();
    await store.createPixels([makePixel(1, "Alice")]);
    const result = await store.updateOwnedPixel(1, "Alice", (p) => ({ ...p, message: "gm" }));
    expect(result.ok).toBe(true);
    expect((await store.getPixel(1))?.message).toBe("gm");
  });

  it("hijackPixel requires the spot to already exist", async () => {
    const store = await freshStore();
    const result = await store.hijackPixel(999, (p) => ({ ...p, owner: "Hijacker" }));
    expect(result.ok).toBe(false);
  });

  it("soldCount reflects only actually-created pixels", async () => {
    const store = await freshStore();
    expect(await store.soldCount()).toBe(0);
    await store.createPixels([makePixel(1, "Alice"), makePixel(2, "Alice")]);
    expect(await store.soldCount()).toBe(2);
  });
});
