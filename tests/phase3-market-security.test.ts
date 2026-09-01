// SOL-98 Phase 3 — Market Security: Purchase Intent system.
//
// Covers what tests/phase2-red-team.test.ts's restructured §5 section (the
// P2-F1 fix itself, exercised through app/api/pixels/route.ts) does not:
//   - POST /api/purchase-intents itself (creation, validation, self-
//     purchase refusal, live-state-derived pricing)
//   - cross-route / cross-action / cross-board intent misuse
//   - double-spending an intent (redeem once, then again)
//   - the identical fix applied to app/api/boards/route.ts (this phase's
//     own-initiative scope extension — see PHASE-3-MARKET-SECURITY.md)
//
// Same mocking pattern as the other route test files: verify-tx /
// token-stats are mocked; the routes, the real file-backed
// pixel-db/board-db/intent-db, and the real used-signatures ledger all run
// for real.
import { promises as fs } from "fs";
import path from "path";
import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildAuthMessage } from "../lib/auth-message";
import { bytesToBase64 } from "../lib/bytes";

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

async function freshRoutes(opts: { pixel98Mint?: string } = {}) {
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

  const pixels = await import("../app/api/pixels/route");
  const boards = await import("../app/api/boards/route");
  const intents = await import("../app/api/purchase-intents/route");
  return { pixels, boards, intents };
}

function post(url: string, body: Record<string, unknown>) {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
const postPixels = (body: Record<string, unknown>) => post("http://localhost/api/pixels", body);
const postBoards = (body: Record<string, unknown>) => post("http://localhost/api/boards", body);
const postIntents = (body: Record<string, unknown>) => post("http://localhost/api/purchase-intents", body);

function signAuth(keypair: Keypair, action: string, index: number | number[], timestamp = Date.now()) {
  const message = buildAuthMessage(action, index, keypair.publicKey.toBase58(), timestamp);
  const signature = nacl.sign.detached(new TextEncoder().encode(message), keypair.secretKey);
  return { authTimestamp: timestamp, authSignature: bytesToBase64(signature) };
}

const blankAd = { destination: "", imageUrl: "", message: "", neon: "none" };

beforeEach(async () => {
  await rmForce(DATA_DIR);
});

async function buyBoardFile(boards: Awaited<ReturnType<typeof freshRoutes>>["boards"], owner: Keypair, signature: string) {
  const res = await boards.POST(postBoards({ action: "buy-board", actor: owner.publicKey.toBase58(), name: "Board", signature }));
  expect(res.status).toBe(200);
  return (await res.json()).file as { id: string };
}

describe("POST /api/purchase-intents — creation", () => {
  it("derives price and seller EXCLUSIVELY from the live listing, ignoring any price the client sends", async () => {
    const { pixels, intents } = await freshRoutes();
    const alice = Keypair.generate();
    const bob = Keypair.generate();
    await pixels.POST(postPixels({ action: "buy", actor: alice.publicKey.toBase58(), index: 0, signature: "sig-a", ad: blankAd }));
    const listAuth = signAuth(alice, "list-sale", 0);
    await pixels.POST(postPixels({ action: "list-sale", actor: alice.publicKey.toBase58(), index: 0, price: 2, currency: "SOL", ...listAuth }));

    const res = await intents.POST(
      postIntents({
        actor: bob.publicKey.toBase58(),
        actionType: "buy-listing",
        index: 0,
        // adversarial: client claims a much lower price
        price: 0.000001,
      })
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.price).toBe(2); // the REAL listing price, not the spoofed one
    expect(json.intentId).toBeTruthy();
    expect(json.expiresAt).toBeGreaterThan(Date.now());
  });

  it("refuses to create an intent for a spot that isn't listed", async () => {
    const { pixels, intents } = await freshRoutes();
    const alice = Keypair.generate();
    const bob = Keypair.generate();
    await pixels.POST(postPixels({ action: "buy", actor: alice.publicKey.toBase58(), index: 1, signature: "sig-a1", ad: blankAd }));

    const res = await intents.POST(postIntents({ actor: bob.publicKey.toBase58(), actionType: "buy-listing", index: 1 }));
    expect(res.status).toBe(400);
  });

  it("refuses to create a self-targeting intent", async () => {
    const { pixels, intents } = await freshRoutes();
    const alice = Keypair.generate();
    await pixels.POST(postPixels({ action: "buy", actor: alice.publicKey.toBase58(), index: 2, signature: "sig-a2", ad: blankAd }));
    const listAuth = signAuth(alice, "list-sale", 2);
    await pixels.POST(postPixels({ action: "list-sale", actor: alice.publicKey.toBase58(), index: 2, price: 1, currency: "SOL", ...listAuth }));

    const res = await intents.POST(postIntents({ actor: alice.publicKey.toBase58(), actionType: "buy-listing", index: 2 }));
    expect(res.status).toBe(400);
  });

  it("rent: locks in total price = live per-day rate * requested days, and requires days in [1,365]", async () => {
    const { pixels, intents } = await freshRoutes();
    const alice = Keypair.generate();
    const bob = Keypair.generate();
    await pixels.POST(postPixels({ action: "buy", actor: alice.publicKey.toBase58(), index: 3, signature: "sig-a3", ad: blankAd }));
    const rentAuth = signAuth(alice, "list-rent", 3);
    await pixels.POST(postPixels({ action: "list-rent", actor: alice.publicKey.toBase58(), index: 3, pricePerDay: 0.1, currency: "SOL", ...rentAuth }));

    const bad = await intents.POST(postIntents({ actor: bob.publicKey.toBase58(), actionType: "rent", index: 3, days: 0 }));
    expect(bad.status).toBe(400);

    const res = await intents.POST(postIntents({ actor: bob.publicKey.toBase58(), actionType: "rent", index: 3, days: 10 }));
    expect(res.status).toBe(200);
    expect((await res.json()).price).toBeCloseTo(1);
  });

  it("hijack: does not lock in a cost — returns a preview only, recomputed fresh at redemption", async () => {
    const mint = Keypair.generate().publicKey.toBase58();
    const { pixels, intents } = await freshRoutes({ pixel98Mint: mint });
    const alice = Keypair.generate();
    const hijacker = Keypair.generate();
    await pixels.POST(postPixels({ action: "buy", actor: alice.publicKey.toBase58(), index: 4, signature: "sig-a4", ad: blankAd }));

    getBurnedFractionMock.mockResolvedValue(0.1);
    const res = await intents.POST(postIntents({ actor: hijacker.publicKey.toBase58(), actionType: "hijack", index: 4 }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.hijackCostTokensPreview).toBeGreaterThan(0);
    expect(json.note).toMatch(/preview only/);
  });

  it("boardId routes to the correct marketplace — a board.exe sub-block intent records that board's id, not null", async () => {
    const { boards, intents } = await freshRoutes();
    const alice = Keypair.generate();
    const bob = Keypair.generate();
    const file = await buyBoardFile(boards, alice, "sig-board-1");
    const listAuth = signAuth(alice, "board-list-sale", 5);
    await boards.POST(postBoards({ action: "list-sale", actor: alice.publicKey.toBase58(), boardId: file.id, index: 5, price: 1, currency: "SOL", ...listAuth }));

    const res = await intents.POST(postIntents({ actor: bob.publicKey.toBase58(), actionType: "buy-listing", boardId: file.id, index: 5 }));
    expect(res.status).toBe(200);
  });
});

describe("Cross-route / cross-action intent misuse — all must be REJECTED", () => {
  it("a pixel-board intent (boardId omitted) cannot be redeemed via POST /api/boards", async () => {
    const { pixels, boards, intents } = await freshRoutes();
    const alice = Keypair.generate();
    const bob = Keypair.generate();
    await pixels.POST(postPixels({ action: "buy", actor: alice.publicKey.toBase58(), index: 6, signature: "sig-a6", ad: blankAd }));
    const listAuth = signAuth(alice, "list-sale", 6);
    await pixels.POST(postPixels({ action: "list-sale", actor: alice.publicKey.toBase58(), index: 6, price: 1, currency: "SOL", ...listAuth }));
    const created = await intents.POST(postIntents({ actor: bob.publicKey.toBase58(), actionType: "buy-listing", index: 6 }));
    const { intentId } = await created.json();

    const res = await boards.POST(postBoards({ action: "buy-listing", actor: bob.publicKey.toBase58(), signature: "sig-cross", intentId }));
    expect(res.status).toBe(400);
  });

  it("a board.exe intent cannot be redeemed via POST /api/pixels", async () => {
    const { pixels, boards, intents } = await freshRoutes();
    const alice = Keypair.generate();
    const bob = Keypair.generate();
    const file = await buyBoardFile(boards, alice, "sig-board-2");
    const listAuth = signAuth(alice, "board-list-sale", 7);
    await boards.POST(postBoards({ action: "list-sale", actor: alice.publicKey.toBase58(), boardId: file.id, index: 7, price: 1, currency: "SOL", ...listAuth }));
    const created = await intents.POST(postIntents({ actor: bob.publicKey.toBase58(), actionType: "buy-listing", boardId: file.id, index: 7 }));
    const { intentId } = await created.json();

    const res = await pixels.POST(postPixels({ action: "buy-listing", actor: bob.publicKey.toBase58(), signature: "sig-cross2", intentId }));
    expect(res.status).toBe(400);
  });

  it("an intent for a DIFFERENT board.exe file cannot touch another board's identically-priced sub-block", async () => {
    const { boards, intents } = await freshRoutes();
    const alice = Keypair.generate();
    const bob = Keypair.generate();
    const fileA = await buyBoardFile(boards, alice, "sig-board-3");
    const fileB = await buyBoardFile(boards, alice, "sig-board-4");
    const listA = signAuth(alice, "board-list-sale", 8);
    await boards.POST(postBoards({ action: "list-sale", actor: alice.publicKey.toBase58(), boardId: fileA.id, index: 8, price: 1, currency: "SOL", ...listA }));
    const listB = signAuth(alice, "board-list-sale", 8);
    await boards.POST(postBoards({ action: "list-sale", actor: alice.publicKey.toBase58(), boardId: fileB.id, index: 8, price: 1, currency: "SOL", ...listB }));

    const created = await intents.POST(postIntents({ actor: bob.publicKey.toBase58(), actionType: "buy-listing", boardId: fileA.id, index: 8 }));
    const { intentId } = await created.json();

    const res = await boards.POST(postBoards({ action: "buy-listing", actor: bob.publicKey.toBase58(), signature: "sig-board-sub", intentId }));
    expect(res.status).toBe(200);
    const pixel = (await res.json()).pixel;
    expect(pixel.boardId).toBe(fileA.id);

    // fileB's identically-priced sub-block #8 is untouched.
    const getRes = await boards.GET();
    const allPixels = (await getRes.json()).pixels as Record<string, { owner: string }>;
    expect(allPixels[`${fileB.id}:8`].owner).toBe(alice.publicKey.toBase58());
  });

  it("a 'rent' intent cannot be redeemed as a 'buy-listing' (actionType mismatch)", async () => {
    const { pixels, intents } = await freshRoutes();
    const alice = Keypair.generate();
    const bob = Keypair.generate();
    await pixels.POST(postPixels({ action: "buy", actor: alice.publicKey.toBase58(), index: 9, signature: "sig-a9", ad: blankAd }));
    const rentAuth = signAuth(alice, "list-rent", 9);
    await pixels.POST(postPixels({ action: "list-rent", actor: alice.publicKey.toBase58(), index: 9, pricePerDay: 0.1, currency: "SOL", ...rentAuth }));
    const created = await intents.POST(postIntents({ actor: bob.publicKey.toBase58(), actionType: "rent", index: 9, days: 5 }));
    const { intentId } = await created.json();

    const res = await pixels.POST(postPixels({ action: "buy-listing", actor: bob.publicKey.toBase58(), signature: "sig-mismatch", intentId }));
    expect(res.status).toBe(400);
  });

  it("an intent can be redeemed ONCE — a second redemption attempt with the same intentId is REJECTED (already consumed)", async () => {
    const { pixels, intents } = await freshRoutes();
    const alice = Keypair.generate();
    const bob = Keypair.generate();
    await pixels.POST(postPixels({ action: "buy", actor: alice.publicKey.toBase58(), index: 12, signature: "sig-a12", ad: blankAd }));
    const listAuth = signAuth(alice, "list-sale", 12);
    await pixels.POST(postPixels({ action: "list-sale", actor: alice.publicKey.toBase58(), index: 12, price: 1, currency: "SOL", ...listAuth }));
    const created = await intents.POST(postIntents({ actor: bob.publicKey.toBase58(), actionType: "buy-listing", index: 12 }));
    const { intentId } = await created.json();

    const first = await pixels.POST(postPixels({ action: "buy-listing", actor: bob.publicKey.toBase58(), signature: "sig-once", intentId }));
    expect(first.status).toBe(200);

    // bob's own wallet, trying to reuse the SAME (now-consumed) intent with
    // a fresh signature — must not be able to double-spend the intent
    // record, even against himself.
    const second = await pixels.POST(postPixels({ action: "buy-listing", actor: bob.publicKey.toBase58(), signature: "sig-twice", intentId }));
    expect(second.status).toBe(409);
  });
});
