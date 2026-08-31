import { promises as fs } from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DocumentData } from "../lib/document-types";

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
  return import("../lib/server/document-db");
}

function makeDoc(id: string, owner: string): DocumentData {
  return { id, name: `Doc ${id}`, content: "hello", owner, purchasedAt: Date.now() };
}

describe("document-db — Board.exe purchased documents (file backend)", () => {
  beforeEach(async () => {
    await rmForce(DATA_DIR);
  });
  afterEach(async () => {
    await rmForce(DATA_DIR);
  });

  it("starts empty", async () => {
    const store = await freshStore();
    expect(await store.readAllDocuments()).toEqual([]);
  });

  it("createDocument appends and persists — visible on the next read", async () => {
    const store = await freshStore();
    const doc = makeDoc("d1", "Alice");
    const created = await store.createDocument(doc);
    expect(created).toEqual(doc);
    expect(await store.readAllDocuments()).toEqual([doc]);
  });

  it("documents accumulate in purchase order and are shared (server-persisted, not per-browser)", async () => {
    const store = await freshStore();
    await store.createDocument(makeDoc("d1", "Alice"));
    await store.createDocument(makeDoc("d2", "Bob"));
    const all = await store.readAllDocuments();
    expect(all.map((d) => d.id)).toEqual(["d1", "d2"]);
  });

  it("survives a fresh module load (durable across a simulated process restart)", async () => {
    const store1 = await freshStore();
    await store1.createDocument(makeDoc("d1", "Alice"));

    vi.resetModules();
    const store2 = await import("../lib/server/document-db");
    expect(await store2.readAllDocuments()).toHaveLength(1);
  });
});
