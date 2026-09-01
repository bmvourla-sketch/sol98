// Phase 1 test matrix — scenarios that need NO live database:
//   #2 DB unavailable · #3 missing credentials · #4 production + DB down ·
//   #5 JSON-fallback-attempt-in-production
//
// Proves the fail-closed gate (lib/server/supabase-env.ts requireDurableStore)
// actually stops a write BEFORE any data/*.json file is touched, whenever
// NODE_ENV=production and Supabase isn't configured — the core of red rules
// #2–#4 ("no JSON fallback in production, ever" / "fail closed").
import { promises as fs } from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const DATA_DIR = path.join(process.cwd(), "data");

async function resetModulesAndData() {
  vi.resetModules();
  await fs.rm(DATA_DIR, { recursive: true, force: true });
}

async function dataDirExists(): Promise<boolean> {
  try {
    await fs.access(DATA_DIR);
    return true;
  } catch {
    return false;
  }
}

describe("requireDurableStore — production fail-closed gate", () => {
  beforeEach(async () => {
    await resetModulesAndData();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(DATA_DIR, { recursive: true, force: true });
  });

  it("#3 missing credentials: NODE_ENV=production + no SUPABASE_URL/KEY → requireDurableStore throws", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SUPABASE_URL", "");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    const { requireDurableStore } = await import("../lib/server/supabase-env");
    expect(() => requireDurableStore()).toThrow(/durable store unavailable/);
  });

  it("#2/#4 DB unavailable in production: createPixels throws instead of writing JSON, and no data/pixels.json is created", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SUPABASE_URL", "");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    const { createPixels } = await import("../lib/server/pixel-db");
    await expect(
      createPixels([
        {
          index: 1,
          owner: "TestWallet1111111111111111111111111111111",
          destination: "",
          imageUrl: "",
          message: "",
          neon: "none",
          valuationSol: 0.2,
          purchasedAt: Date.now(),
          isRented: false,
        },
      ])
    ).rejects.toThrow(/durable store unavailable/);
    expect(await dataDirExists()).toBe(false);
  });

  it("#5 JSON-fallback-attempt: every write path (pixels/boards/documents/used-signatures) fails closed in production without credentials — none falls back to JSON", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SUPABASE_URL", "");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");

    const { updateOwnedPixel, hijackPixel, updateGroupOwnedPixels } = await import("../lib/server/pixel-db");
    const { createBoard, updateBoardPixel, hijackBoardPixel, renameBoardFile, makeSubBlocks } = await import(
      "../lib/server/board-db"
    );
    const { createDocument } = await import("../lib/server/document-db");
    const { claimSignature } = await import("../lib/server/used-signatures");

    await expect(updateOwnedPixel(1, "X", (p) => p)).rejects.toThrow(/durable store unavailable/);
    await expect(hijackPixel(1, (p) => p)).rejects.toThrow(/durable store unavailable/);
    await expect(updateGroupOwnedPixels("g", "X", (p) => p)).rejects.toThrow(/durable store unavailable/);
    await expect(createBoard({ id: "b1", name: "n", owner: "X", purchasedAt: 1, priceSol: 2 }, makeSubBlocks("b1", "X", 1))).rejects.toThrow(
      /durable store unavailable/
    );
    await expect(updateBoardPixel("b1", 0, "X", (p) => p)).rejects.toThrow(/durable store unavailable/);
    await expect(hijackBoardPixel("b1", 0, (p) => p)).rejects.toThrow(/durable store unavailable/);
    await expect(renameBoardFile("b1", "X", "n")).rejects.toThrow(/durable store unavailable/);
    await expect(createDocument({ id: "d1", name: "n", content: "c", owner: "X", purchasedAt: 1 })).rejects.toThrow(
      /durable store unavailable/
    );
    await expect(claimSignature("sig1")).rejects.toThrow(/durable store unavailable/);

    // No JSON file for ANY store was created as a side effect of these attempts.
    expect(await dataDirExists()).toBe(false);
  });

  it("dev/test mode is unaffected: the same write path still succeeds against the file store when NODE_ENV !== production", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("SUPABASE_URL", "");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    const { createPixels } = await import("../lib/server/pixel-db");
    const result = await createPixels([
      {
        index: 2,
        owner: "TestWallet1111111111111111111111111111111",
        destination: "",
        imageUrl: "",
        message: "",
        neon: "none",
        valuationSol: 0.2,
        purchasedAt: Date.now(),
        isRented: false,
      },
    ]);
    expect(result.ok).toBe(true);
    expect(await dataDirExists()).toBe(true);
  });
});
