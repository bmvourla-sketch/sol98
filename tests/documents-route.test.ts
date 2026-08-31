import { promises as fs } from "fs";
import path from "path";
import { Keypair } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

// End-to-end tests for app/api/documents/route.ts — Board.exe's simpler
// "document sale" ad product. Paid-only (fixed price to the treasury), no
// free/signed actions, and documents are append-only (no owner-gated edits),
// so its surface is smaller than the two pixel marketplaces — but it shares
// the same payment-verification + replay-protection spine, which is what
// these tests actually exercise.

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

const verifySolTransferMock = vi.fn();

vi.mock("@/lib/server/verify-tx", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/server/verify-tx")>();
  return { ...actual, verifySolTransfer: (...args: unknown[]) => verifySolTransferMock(...args) };
});

const TREASURY = Keypair.generate();

async function freshRoute() {
  vi.resetModules();
  await rmForce(DATA_DIR);
  process.env.NEXT_PUBLIC_TREASURY_ADDRESS = TREASURY.publicKey.toBase58();
  verifySolTransferMock.mockReset().mockResolvedValue({ ok: true });
  return import("../app/api/documents/route");
}

function post(body: Record<string, unknown>) {
  return new Request("http://localhost/api/documents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  await rmForce(DATA_DIR);
});

describe("POST /api/documents", () => {
  it("rejects an invalid actor pubkey", async () => {
    const route = await freshRoute();
    const res = await route.POST(post({ actor: "not-a-pubkey", signature: "sig", name: "x", content: "y" }));
    expect(res.status).toBe(400);
  });

  it("rejects when the payment doesn't verify", async () => {
    const route = await freshRoute();
    verifySolTransferMock.mockResolvedValue({ ok: false, error: "no matching transfer" });
    const buyer = Keypair.generate();
    const res = await route.POST(post({ actor: buyer.publicKey.toBase58(), signature: "sig", name: "My Doc", content: "hi" }));
    expect(res.status).toBe(402);
  });

  it("accepts a verified purchase and records the paying wallet as the document's owner", async () => {
    const route = await freshRoute();
    const buyer = Keypair.generate();
    const res = await route.POST(post({ actor: buyer.publicKey.toBase58(), signature: "sig-1", name: "My Doc", content: "hello world" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.document.owner).toBe(buyer.publicKey.toBase58());
    expect(json.document.name).toBe("My Doc");

    expect(verifySolTransferMock).toHaveBeenCalledWith(
      expect.objectContaining({ fromOwner: buyer.publicKey.toBase58(), toOwner: TREASURY.publicKey.toBase58() })
    );
  });

  it("replay protection: the same payment signature can't buy two documents", async () => {
    const route = await freshRoute();
    const buyer = Keypair.generate();
    const first = await route.POST(post({ actor: buyer.publicKey.toBase58(), signature: "sig-reuse", name: "One", content: "a" }));
    expect(first.status).toBe(200);
    const second = await route.POST(post({ actor: buyer.publicKey.toBase58(), signature: "sig-reuse", name: "Two", content: "b" }));
    expect(second.status).toBe(409);
  });

  it("rejects an over-long document name/content", async () => {
    const route = await freshRoute();
    const buyer = Keypair.generate();
    const res = await route.POST(
      post({ actor: buyer.publicKey.toBase58(), signature: "sig-x", name: "x".repeat(200), content: "y" })
    );
    expect(res.status).toBe(400);
  });

  it("documents purchased by different wallets are all visible via GET (shared, not per-browser)", async () => {
    const route = await freshRoute();
    const alice = Keypair.generate();
    const bob = Keypair.generate();
    await route.POST(post({ actor: alice.publicKey.toBase58(), signature: "sig-alice", name: "Alice's Doc", content: "a" }));
    await route.POST(post({ actor: bob.publicKey.toBase58(), signature: "sig-bob", name: "Bob's Doc", content: "b" }));

    const res = await route.GET();
    const json = await res.json();
    expect(json.documents).toHaveLength(2);
    expect(json.documents.map((d: { owner: string }) => d.owner).sort()).toEqual(
      [alice.publicKey.toBase58(), bob.publicKey.toBase58()].sort()
    );
  });
});
