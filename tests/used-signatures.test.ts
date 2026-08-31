import { promises as fs } from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const DATA_DIR = path.join(process.cwd(), "data");

async function freshStore() {
  vi.resetModules();
  await fs.rm(DATA_DIR, { recursive: true, force: true });
  return import("../lib/server/used-signatures");
}

describe("used-signatures — replay protection", () => {
  beforeEach(async () => {
    await fs.rm(DATA_DIR, { recursive: true, force: true });
  });
  afterEach(async () => {
    await fs.rm(DATA_DIR, { recursive: true, force: true });
  });

  it("claims a signature once, then refuses every later reuse", async () => {
    const store = await freshStore();
    expect(await store.claimSignature("sig-abc")).toBe(true);
    expect(await store.claimSignature("sig-abc")).toBe(false);
    expect(await store.claimSignature("sig-abc")).toBe(false);
  });

  it("only one of two concurrent claims for the same signature wins", async () => {
    const store = await freshStore();
    const [a, b] = await Promise.all([store.claimSignature("sig-race"), store.claimSignature("sig-race")]);
    expect([a, b].filter(Boolean).length).toBe(1);
  });

  it("releaseSignature lets a signature be claimed again (rare rollback path)", async () => {
    const store = await freshStore();
    expect(await store.claimSignature("sig-release-me")).toBe(true);
    await store.releaseSignature("sig-release-me");
    expect(await store.claimSignature("sig-release-me")).toBe(true);
  });

  it("different signatures don't interfere with each other", async () => {
    const store = await freshStore();
    expect(await store.claimSignature("sig-1")).toBe(true);
    expect(await store.claimSignature("sig-2")).toBe(true);
  });
});
