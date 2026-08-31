import { promises as fs } from "fs";
import path from "path";
import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildAuthMessage } from "../lib/auth-message";
import { bytesToBase64 } from "../lib/bytes";

// End-to-end tests for app/api/boards/route.ts — the "Start Ads" second
// marketplace (board.exe files, each a 10x10 sub-board sold separately from
// the main pixel board but sharing the exact same wallet-authority security
// model: paid actions need a verified on-chain signature, free owner-only
// actions need a fresh wallet-signed auth proof re-checked against the
// STORED owner. See tests/pixels-route.test.ts for the mirrored main-board
// coverage; this file exists because boards/route.ts is a SEPARATE handler
// with its own copy of every check, so a bug fixed in one does not imply
// the other was ever fixed.

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
const verifyBurnMock = vi.fn();
const verifyTokenTransferMock = vi.fn();
const tokenAmountToRawMock = vi.fn();
const getBurnedFractionMock = vi.fn();

vi.mock("@/lib/server/verify-tx", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/server/verify-tx")>();
  return {
    ...actual,
    verifySolTransfer: (...args: unknown[]) => verifySolTransferMock(...args),
    verifyBurn: (...args: unknown[]) => verifyBurnMock(...args),
    verifyTokenTransfer: (...args: unknown[]) => verifyTokenTransferMock(...args),
    tokenAmountToRaw: (...args: unknown[]) => tokenAmountToRawMock(...args),
  };
});

vi.mock("@/lib/server/token-stats", () => ({
  getBurnedFraction: () => getBurnedFractionMock(),
}));

const TREASURY = Keypair.generate();

async function freshRoute(opts: { pixel98Mint?: string } = {}) {
  vi.resetModules();
  await rmForce(DATA_DIR);
  process.env.NEXT_PUBLIC_TREASURY_ADDRESS = TREASURY.publicKey.toBase58();
  if (opts.pixel98Mint) process.env.NEXT_PUBLIC_PIXEL98_MINT = opts.pixel98Mint;
  else delete process.env.NEXT_PUBLIC_PIXEL98_MINT;

  verifySolTransferMock.mockReset().mockResolvedValue({ ok: true });
  verifyBurnMock.mockReset().mockResolvedValue({ ok: true });
  verifyTokenTransferMock.mockReset().mockResolvedValue({ ok: true });
  tokenAmountToRawMock.mockReset().mockResolvedValue(1000n);
  getBurnedFractionMock.mockReset().mockResolvedValue(0);

  return import("../app/api/boards/route");
}

function post(body: Record<string, unknown>) {
  return new Request("http://localhost/api/boards", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function signAuth(keypair: Keypair, action: string, index: number, timestamp = Date.now()) {
  const message = buildAuthMessage(action, index, keypair.publicKey.toBase58(), timestamp);
  const signature = nacl.sign.detached(new TextEncoder().encode(message), keypair.secretKey);
  return { authTimestamp: timestamp, authSignature: bytesToBase64(signature) };
}

async function buyBoard(route: Awaited<ReturnType<typeof freshRoute>>, owner: Keypair, signature: string) {
  const res = await route.POST(post({ action: "buy-board", actor: owner.publicKey.toBase58(), name: "My Board", signature }));
  expect(res.status).toBe(200);
  return (await res.json()).file as { id: string };
}

beforeEach(async () => {
  await rmForce(DATA_DIR);
});

describe("POST /api/boards — buy-board (ownership tied to the paying wallet)", () => {
  it("creates a board.exe file with 100 sub-blocks owned by the buyer", async () => {
    const route = await freshRoute();
    const buyer = Keypair.generate();
    const file = await buyBoard(route, buyer, "sig-board-1");

    const getRes = await route.GET();
    const json = await getRes.json();
    expect(json.files).toHaveLength(1);
    const subBlocks = Object.values(json.pixels) as { boardId: string; owner: string }[];
    expect(subBlocks.filter((p) => p.boardId === file.id)).toHaveLength(100);
    expect(subBlocks.every((p) => p.owner === buyer.publicKey.toBase58())).toBe(true);
  });

  it("rejects when the payment doesn't verify", async () => {
    const route = await freshRoute();
    verifySolTransferMock.mockResolvedValue({ ok: false, error: "nope" });
    const res = await route.POST(post({ action: "buy-board", actor: Keypair.generate().publicKey.toBase58(), signature: "bad" }));
    expect(res.status).toBe(402);
  });
});

describe("POST /api/boards — rename-board (owner-only)", () => {
  it("rejects a rename from a non-owner and accepts one from the owner", async () => {
    const route = await freshRoute();
    const alice = Keypair.generate();
    const mallory = Keypair.generate();
    const file = await buyBoard(route, alice, "sig-board-2");

    const malloryAuth = signAuth(mallory, "board-rename", -1);
    const denied = await route.POST(
      post({ action: "rename-board", actor: mallory.publicKey.toBase58(), boardId: file.id, name: "Stolen", ...malloryAuth })
    );
    expect(denied.status).toBe(403);

    const aliceAuth = signAuth(alice, "board-rename", -1);
    const allowed = await route.POST(
      post({ action: "rename-board", actor: alice.publicKey.toBase58(), boardId: file.id, name: "Alice's Board", ...aliceAuth })
    );
    expect(allowed.status).toBe(200);
    expect((await allowed.json()).file.name).toBe("Alice's Board");
  });
});

describe("POST /api/boards — edit-pixel (free, signed, owner-checked against the STORED sub-block)", () => {
  it("rejects an edit from someone who didn't buy this board's block", async () => {
    const route = await freshRoute();
    const alice = Keypair.generate();
    const bob = Keypair.generate();
    const file = await buyBoard(route, alice, "sig-board-3");

    const bobAuth = signAuth(bob, "board-edit", 0);
    const res = await route.POST(
      post({ action: "edit-pixel", actor: bob.publicKey.toBase58(), boardId: file.id, index: 0, ad: { destination: "", imageUrl: "", message: "pwned", neon: "none" }, ...bobAuth })
    );
    expect(res.status).toBe(403);
  });

  it("lets the owner place an ad on their own sub-block", async () => {
    const route = await freshRoute();
    const alice = Keypair.generate();
    const file = await buyBoard(route, alice, "sig-board-4");

    const auth = signAuth(alice, "board-edit", 5);
    const res = await route.POST(
      post({ action: "edit-pixel", actor: alice.publicKey.toBase58(), boardId: file.id, index: 5, ad: { destination: "https://x.com", imageUrl: "", message: "gm", neon: "none" }, ...auth })
    );
    expect(res.status).toBe(200);
    expect((await res.json()).pixel.message).toBe("gm");
  });
});

describe("POST /api/boards — hijack (pre-launch simulated vs post-launch real burn)", () => {
  it("pre-launch: a genuine wallet-signed proof performs a free simulated hijack", async () => {
    const route = await freshRoute();
    const alice = Keypair.generate();
    const hijacker = Keypair.generate();
    const file = await buyBoard(route, alice, "sig-board-5");

    const auth = signAuth(hijacker, "board-hijack", 2);
    const res = await route.POST(post({ action: "hijack", actor: hijacker.publicKey.toBase58(), boardId: file.id, index: 2, ...auth }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.simulated).toBe(true);
    expect(json.pixel.owner).toBe(hijacker.publicKey.toBase58());
  });

  it("post-launch: requires a verified burn signature", async () => {
    const route = await freshRoute({ pixel98Mint: Keypair.generate().publicKey.toBase58() });
    const alice = Keypair.generate();
    const hijacker = Keypair.generate();
    const file = await buyBoard(route, alice, "sig-board-6");

    verifyBurnMock.mockResolvedValue({ ok: false, error: "no burn" });
    const res = await route.POST(post({ action: "hijack", actor: hijacker.publicKey.toBase58(), boardId: file.id, index: 3, signature: "burn-sig" }));
    expect(res.status).toBe(402);

    verifyBurnMock.mockResolvedValue({ ok: true });
    const ok = await route.POST(post({ action: "hijack", actor: hijacker.publicKey.toBase58(), boardId: file.id, index: 3, signature: "burn-sig-2" }));
    expect(ok.status).toBe(200);
    expect((await ok.json()).pixel.owner).toBe(hijacker.publicKey.toBase58());
  });
});

describe("POST /api/boards — buy-listing / rent (peer-to-peer)", () => {
  it("buy-listing pays the seller directly and transfers ownership of that sub-block only", async () => {
    const route = await freshRoute();
    const alice = Keypair.generate();
    const bob = Keypair.generate();
    const file = await buyBoard(route, alice, "sig-board-7");

    const listAuth = signAuth(alice, "board-list-sale", 10);
    await route.POST(post({ action: "list-sale", actor: alice.publicKey.toBase58(), boardId: file.id, index: 10, price: 1, currency: "SOL", ...listAuth }));

    const res = await route.POST(post({ action: "buy-listing", actor: bob.publicKey.toBase58(), boardId: file.id, index: 10, signature: "sig-p2p" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.pixel.owner).toBe(bob.publicKey.toBase58());
    expect(verifySolTransferMock).toHaveBeenCalledWith(
      expect.objectContaining({ fromOwner: bob.publicKey.toBase58(), toOwner: alice.publicKey.toBase58() })
    );

    // the OTHER 99 sub-blocks must still belong to Alice — this action must not
    // accidentally transfer the whole board.exe file.
    const getRes = await route.GET();
    const allPixels = (await getRes.json()).pixels as Record<string, { owner: string }>;
    expect(allPixels[`${file.id}:11`].owner).toBe(alice.publicKey.toBase58());
  });

  it("rent marks only that sub-block as rented, without changing its owner", async () => {
    const route = await freshRoute();
    const alice = Keypair.generate();
    const bob = Keypair.generate();
    const file = await buyBoard(route, alice, "sig-board-8");

    const rentAuth = signAuth(alice, "board-list-rent", 20);
    await route.POST(post({ action: "list-rent", actor: alice.publicKey.toBase58(), boardId: file.id, index: 20, pricePerDay: 0.1, currency: "SOL", ...rentAuth }));

    const res = await route.POST(post({ action: "rent", actor: bob.publicKey.toBase58(), boardId: file.id, index: 20, days: 7, signature: "sig-rent" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.pixel.isRented).toBe(true);
    expect(json.pixel.rentedTo).toBe(bob.publicKey.toBase58());
    expect(json.pixel.owner).toBe(alice.publicKey.toBase58());
  });
});
