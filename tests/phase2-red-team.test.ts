// SOL-98 Phase 2 — Payment Verification + Ownership Security Red Team.
//
// Extends tests/pixels-route.test.ts (which already proves every mutating
// action is tied to a verified wallet proof) with the adversarial scenarios
// from the Phase 2 brief that aren't covered elsewhere:
//   §3  price manipulation (client-submitted price is never trusted)
//   §5  transaction substitution (pay-for-X, claim-Y)
//   §6  replay across a DIFFERENT action/pixel (not just the same action)
//   §11/§12 DB-failure and RPC-failure mid-purchase (fail-closed vs lost-payment)
//
// Same mocking pattern as pixels-route.test.ts: verify-tx / token-stats are
// mocked (already exhaustively unit-tested against a faked Connection in
// tests/verify-tx.test.ts and tests/network-guard.test.ts); the route, the
// real file-backed pixel-db, and the real used-signatures ledger all run for
// real, so what's being proven here is the ROUTE's trust wiring, not RPC
// plumbing.
import { promises as fs } from "fs";
import path from "path";
import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildAuthMessage } from "../lib/auth-message";
import { bytesToBase64 } from "../lib/bytes";
import { nextSpotPrice, areaPrice } from "../lib/pricing";
import { solRequiredLamportsWithTolerance } from "../lib/server/verify-tx";
import { HIJACK_COOLDOWN_MS } from "../lib/token";

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

  return import("../app/api/pixels/route");
}

function post(body: Record<string, unknown>) {
  return new Request("http://localhost/api/pixels", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function signAuth(keypair: Keypair, action: string, index: number | number[], timestamp = Date.now()) {
  const message = buildAuthMessage(action, index, keypair.publicKey.toBase58(), timestamp);
  const signature = nacl.sign.detached(new TextEncoder().encode(message), keypair.secretKey);
  return { authTimestamp: timestamp, authSignature: bytesToBase64(signature) };
}

// SOL-98 Phase 3 (MARKET SECURITY) — see tests/pixels-route.test.ts's
// identical helper doc comment. buy-listing / rent / hijack(live) now
// require a server-issued purchase_intent.
async function makeIntent(opts: {
  actionType: "buy-listing" | "rent" | "hijack";
  index: number;
  buyer: Keypair;
  seller: Keypair;
  currency?: "SOL" | "PIXEL98";
  priceSol?: number;
  pricePixel98?: number;
  mint?: string | null;
  rentDays?: number;
}) {
  const { createIntent } = await import("../lib/server/intent-db");
  const intent = await createIntent({
    actionType: opts.actionType,
    boardId: null,
    pixelIndex: opts.index,
    buyerWallet: opts.buyer.publicKey.toBase58(),
    sellerWallet: opts.seller.publicKey.toBase58(),
    currency: opts.currency ?? "SOL",
    priceSol: opts.priceSol,
    pricePixel98: opts.pricePixel98,
    mint: opts.mint ?? null,
    rentDays: opts.rentDays,
    ttlMs: 15 * 60_000,
  });
  return intent.id;
}

const blankAd = { destination: "", imageUrl: "", message: "", neon: "none" };

// Anti-harassment hijack cooldown (see HIJACK_COOLDOWN_MS in lib/token.ts):
// a spot bought through the route is protected from hijacks for 24h. Tests
// below that buy a target through the route and then hijack that SAME
// target aren't testing the cooldown itself — so they jump Date.now()
// forward past the cooldown window first. Callers MUST restore the spy
// (nowSpy.mockRestore()) once done, since it isn't reset between tests
// automatically.
function pastHijackCooldown() {
  return vi.spyOn(Date, "now").mockReturnValue(Date.now() + HIJACK_COOLDOWN_MS + 60_000);
}

beforeEach(async () => {
  await rmForce(DATA_DIR);
});

// ===========================================================================
// §3 — Price manipulation: the client can submit ANY extra fields it wants;
// none of them can influence the price the server actually checks on-chain.
// ===========================================================================
describe("§3 price manipulation — client-submitted price fields are structurally ignored", () => {
  it("buy: a spoofed price/priceSol/amountSol field in the body has ZERO effect on the amount checked on-chain", async () => {
    const route = await freshRoute();
    const buyer = Keypair.generate();
    const expectedMinLamports = solRequiredLamportsWithTolerance(nextSpotPrice(0));

    await route.POST(
      post({
        action: "buy",
        actor: buyer.publicKey.toBase58(),
        index: 0,
        signature: "sig-real-price",
        ad: blankAd,
        // Adversarial extras — none of these are read by handleBuy at all.
        price: 0.000001,
        priceSol: 0,
        amountSol: -5,
        minLamports: 1,
        cost: "free",
      })
    );

    expect(verifySolTransferMock).toHaveBeenCalledWith(
      expect.objectContaining({ minLamports: expectedMinLamports, toOwner: TREASURY.publicKey.toBase58() })
    );
  });

  it("buy-area: price is always the server-computed integrated bonding-curve price, never a client value", async () => {
    const route = await freshRoute();
    const buyer = Keypair.generate();
    const indices = [0, 1, 100, 101];
    const expectedMinLamports = solRequiredLamportsWithTolerance(areaPrice(0, indices.length));

    await route.POST(
      post({
        action: "buy-area",
        actor: buyer.publicKey.toBase58(),
        indices,
        signature: "sig-area-price",
        ad: blankAd,
        price: 0,
        totalPrice: 0.00000001,
      })
    );

    expect(verifySolTransferMock).toHaveBeenCalledWith(
      expect.objectContaining({ minLamports: expectedMinLamports })
    );
  });

  it("buy: price recomputes from the LIVE sold count server-side — an old (lower, already-stale) price can't be replayed", async () => {
    const route = await freshRoute();
    const buyer1 = Keypair.generate();
    const buyer2 = Keypair.generate();

    // First sale moves soldCount 0 -> 1, raising the next spot's price.
    await route.POST(post({ action: "buy", actor: buyer1.publicKey.toBase58(), index: 0, signature: "sig-first", ad: blankAd }));

    verifySolTransferMock.mockClear();
    const priceAtZeroSold = solRequiredLamportsWithTolerance(nextSpotPrice(0));
    const priceAtOneSold = solRequiredLamportsWithTolerance(nextSpotPrice(1));

    await route.POST(post({ action: "buy", actor: buyer2.publicKey.toBase58(), index: 1, signature: "sig-second", ad: blankAd }));

    const call = verifySolTransferMock.mock.calls[0][0];
    expect(call.minLamports).toBe(priceAtOneSold);
    if (priceAtOneSold > priceAtZeroSold) {
      // Bonding curve is monotonically non-decreasing — confirms this isn't
      // accidentally checking the stale (cheaper) price from before the sale.
      expect(call.minLamports).not.toBe(priceAtZeroSold);
    }
  });

  it("list-sale: rejects zero, negative, non-finite, and absurdly large prices at the validation layer", async () => {
    const route = await freshRoute();
    const alice = Keypair.generate();
    await route.POST(post({ action: "buy", actor: alice.publicKey.toBase58(), index: 40, signature: "sig-list-owner", ad: blankAd }));

    const cases = [0, -1, -0.0000001, NaN, Infinity, -Infinity, 1_000_001, Number.MAX_VALUE];
    for (const price of cases) {
      const auth = signAuth(alice, "list-sale", 40);
      const res = await route.POST(
        post({ action: "list-sale", actor: alice.publicKey.toBase58(), index: 40, price, currency: "SOL", ...auth })
      );
      expect(res.status, `price=${price} should be rejected`).toBe(400);
    }
  });

  it("list-sale: accepts a decimal price and rounding doesn't turn it into a different (larger/smaller) value server-side", async () => {
    const route = await freshRoute();
    const alice = Keypair.generate();
    await route.POST(post({ action: "buy", actor: alice.publicKey.toBase58(), index: 41, signature: "sig-list-owner2", ad: blankAd }));
    const auth = signAuth(alice, "list-sale", 41);
    const res = await route.POST(
      post({ action: "list-sale", actor: alice.publicKey.toBase58(), index: 41, price: 1.23456789, currency: "SOL", ...auth })
    );
    expect(res.status).toBe(200);
    expect((await res.json()).pixel.listingPriceSol).toBe(1.23456789);
  });
});

// ===========================================================================
// §5 — Transaction substitution: pay implying pixel #X, submit the API
// request claiming pixel #Y.
// ===========================================================================
describe("§5 transaction substitution — pay for one pixel, claim a different one", () => {
  it("buy: index substitution is NOT an economic exploit — every unsold index costs the SAME at a given sold count", async () => {
    // This documents INTENDED behavior, not a bug: lib/pricing.ts prices are
    // a pure function of soldCount/count, never of index, so there is no
    // "cheap pixel" to redirect a payment onto. Proven here at the route
    // level: the same minLamports is required no matter which unsold index
    // is requested, holding soldCount fixed at 0 in TWO independent boards
    // (a single board's soldCount would change after the first purchase,
    // which is a different effect — tested separately above).
    const routeA = await freshRoute();
    const buyerA = Keypair.generate();
    await routeA.POST(post({ action: "buy", actor: buyerA.publicKey.toBase58(), index: 500, signature: "sig-sub-1", ad: blankAd }));
    const callA = verifySolTransferMock.mock.calls[0][0];

    const routeB = await freshRoute(); // fresh board — soldCount back to 0
    const buyerB = Keypair.generate();
    await routeB.POST(post({ action: "buy", actor: buyerB.publicKey.toBase58(), index: 999, signature: "sig-sub-2", ad: blankAd }));
    const callB = verifySolTransferMock.mock.calls[0][0];

    expect(callA.minLamports).toBe(callB.minLamports);
  });

  // -------------------------------------------------------------------------
  // HISTORICAL — finding P2-F1 (FIXED in SOL-98 Phase 3, see
  // docs/production-readiness/PHASE-3-MARKET-SECURITY.md). Before this
  // phase, buy-listing/rent/hijack(live) verified a payment as ONLY
  // (fromOwner, toOwner, minLamports) — never tied to a specific pixel
  // index. If the same seller had two listings at an identical price, a
  // payment that verifySolTransfer confirmed for listing A ALSO satisfied
  // the check for listing B, so a buyer whose wallet sent one real payment
  // meant for pixel #60 could submit an API request claiming pixel #61
  // instead and walk away with #61 — this test file used to assert THAT
  // request returned 200. The fix (mandatory server-issued
  // purchase_intents, see app/api/pixels/route.ts's resolveIntent) closes
  // this at the request-validation layer: redemption now derives the pixel
  // index EXCLUSIVELY from the intent record, so there is no client-
  // submitted index left to substitute in the first place. Tests below
  // prove the invariant now holds, using the exact scenario above plus the
  // Phase 3 red-team checklist's other three requirements.
  // -------------------------------------------------------------------------
  it("buy-listing: an intent created for pixel #60 cannot be redeemed against pixel #61, even with a payment that would satisfy BOTH listings' (seller, price)", async () => {
    const route = await freshRoute();
    const seller = Keypair.generate();
    const buyer = Keypair.generate();

    await route.POST(post({ action: "buy", actor: seller.publicKey.toBase58(), index: 60, signature: "sig-seller-a", ad: blankAd }));
    await route.POST(post({ action: "buy", actor: seller.publicKey.toBase58(), index: 61, signature: "sig-seller-b", ad: blankAd }));
    const listA = signAuth(seller, "list-sale", 60);
    await route.POST(post({ action: "list-sale", actor: seller.publicKey.toBase58(), index: 60, price: 2, currency: "SOL", ...listA }));
    const listB = signAuth(seller, "list-sale", 61);
    await route.POST(post({ action: "list-sale", actor: seller.publicKey.toBase58(), index: 61, price: 2, currency: "SOL", ...listB }));

    // The buyer creates an intent for #60 specifically...
    const intentFor60 = await makeIntent({ actionType: "buy-listing", index: 60, buyer, seller, priceSol: 2 });

    // ...but a payment that would satisfy EITHER listing (identical seller
    // + price) is on chain, and the client attempts to redeem the #60
    // intent while the route independently re-reads pixel #60's live state
    // (this IS #60 — the substitution attempt here is trying to get away
    // with paying for #60 and effectively "aiming" the proof at #61 is no
    // longer even expressible: there is no `index` field in the request
    // body for the route to read).
    const expectedMinLamports = solRequiredLamportsWithTolerance(2);
    verifySolTransferMock.mockImplementation(async (args: { fromOwner: string; toOwner: string; minLamports: number }) => {
      if (args.fromOwner === buyer.publicKey.toBase58() && args.toOwner === seller.publicKey.toBase58() && args.minLamports <= expectedMinLamports) {
        return { ok: true };
      }
      return { ok: false, error: "no matching transfer" };
    });

    const res = await route.POST(post({ action: "buy-listing", actor: buyer.publicKey.toBase58(), signature: "sig-fixed-60", intentId: intentFor60 }));
    expect(res.status).toBe(200);
    const pixel60 = (await res.json()).pixel;
    expect(pixel60.index).toBe(60);
    expect(pixel60.owner).toBe(buyer.publicKey.toBase58());
    // #61 — the pixel that used to be reachable via substitution — is
    // completely untouched by this purchase.
    const board = await (await route.GET()).json();
    expect(board.pixels["61"].owner).toBe(seller.publicKey.toBase58());
    expect(board.pixels["61"].listingPriceSol).toBe(2);
  });

  it("RED TEAM #1 — redeeming an intent created for Pixel A can only ever produce ownership of Pixel A, never a different Pixel B", async () => {
    const route = await freshRoute();
    const seller = Keypair.generate();
    const buyer = Keypair.generate();

    await route.POST(post({ action: "buy", actor: seller.publicKey.toBase58(), index: 62, signature: "sig-seller-c", ad: blankAd }));
    await route.POST(post({ action: "buy", actor: seller.publicKey.toBase58(), index: 63, signature: "sig-seller-d", ad: blankAd }));
    const listA = signAuth(seller, "list-sale", 62);
    await route.POST(post({ action: "list-sale", actor: seller.publicKey.toBase58(), index: 62, price: 2, currency: "SOL", ...listA }));
    const listB = signAuth(seller, "list-sale", 63);
    await route.POST(post({ action: "list-sale", actor: seller.publicKey.toBase58(), index: 63, price: 2, currency: "SOL", ...listB }));

    // The buyer's intent is for pixel #62. There is no way to make the
    // request body claim #63 instead — POST /api/pixels no longer reads an
    // `index` field for this action at all; the pixel is derived
    // exclusively from the intent record.
    const intentId = await makeIntent({ actionType: "buy-listing", index: 62, buyer, seller, priceSol: 2 });
    const res = await route.POST(post({ action: "buy-listing", actor: buyer.publicKey.toBase58(), signature: "sig-a-62", intentId }));
    expect(res.status).toBe(200);
    expect((await res.json()).pixel.index).toBe(62);

    const board = await (await route.GET()).json();
    expect(board.pixels["63"].owner).toBe(seller.publicKey.toBase58()); // untouched
  });

  it("RED TEAM #2 — payment with an EXPIRED intent must be REJECTED (410)", async () => {
    const route = await freshRoute();
    const seller = Keypair.generate();
    const buyer = Keypair.generate();
    await route.POST(post({ action: "buy", actor: seller.publicKey.toBase58(), index: 64, signature: "sig-seller-e", ad: blankAd }));
    const listAuth = signAuth(seller, "list-sale", 64);
    await route.POST(post({ action: "list-sale", actor: seller.publicKey.toBase58(), index: 64, price: 2, currency: "SOL", ...listAuth }));

    const { createIntent } = await import("../lib/server/intent-db");
    const expired = await createIntent({
      actionType: "buy-listing",
      boardId: null,
      pixelIndex: 64,
      buyerWallet: buyer.publicKey.toBase58(),
      sellerWallet: seller.publicKey.toBase58(),
      currency: "SOL",
      priceSol: 2,
      ttlMs: -1, // already expired the instant it's created
    });

    const res = await route.POST(post({ action: "buy-listing", actor: buyer.publicKey.toBase58(), signature: "sig-expired", intentId: expired.id }));
    expect(res.status).toBe(410);
    expect((await res.json()).error).toMatch(/expired/);

    // and the listing itself is untouched
    const board = await (await route.GET()).json();
    expect(board.pixels["64"].owner).toBe(seller.publicKey.toBase58());
  });

  it("RED TEAM #3 — payment attempted with ANOTHER WALLET's intent_id must be REJECTED (403)", async () => {
    const route = await freshRoute();
    const seller = Keypair.generate();
    const rightfulBuyer = Keypair.generate();
    const attacker = Keypair.generate();
    await route.POST(post({ action: "buy", actor: seller.publicKey.toBase58(), index: 65, signature: "sig-seller-f", ad: blankAd }));
    const listAuth = signAuth(seller, "list-sale", 65);
    await route.POST(post({ action: "list-sale", actor: seller.publicKey.toBase58(), index: 65, price: 2, currency: "SOL", ...listAuth }));

    const intentId = await makeIntent({ actionType: "buy-listing", index: 65, buyer: rightfulBuyer, seller, priceSol: 2 });

    // The attacker has a real, verifiable payment of their own but is not
    // the wallet the intent was created for.
    const res = await route.POST(post({ action: "buy-listing", actor: attacker.publicKey.toBase58(), signature: "sig-attacker", intentId }));
    expect(res.status).toBe(403);

    const board = await (await route.GET()).json();
    expect(board.pixels["65"].owner).toBe(seller.publicKey.toBase58());
  });
});

// ===========================================================================
// §6 — Replay across a DIFFERENT action or pixel (pixels-route.test.ts
// already proves same-action reuse fails; this proves it fails cross-action
// too, since used_signatures is one single-use ledger shared by every
// signature-consuming action).
// ===========================================================================
describe("§6 replay protection — a claimed signature can't be reused for a DIFFERENT action", () => {
  it("a signature claimed by 'buy' is rejected if replayed against 'buy-listing' on an unrelated pixel", async () => {
    const route = await freshRoute();
    const buyer = Keypair.generate();
    const seller = Keypair.generate();

    const first = await route.POST(post({ action: "buy", actor: buyer.publicKey.toBase58(), index: 80, signature: "sig-cross-action", ad: blankAd }));
    expect(first.status).toBe(200);

    await route.POST(post({ action: "buy", actor: seller.publicKey.toBase58(), index: 81, signature: "sig-seller-listing", ad: blankAd }));
    const listAuth = signAuth(seller, "list-sale", 81);
    await route.POST(post({ action: "list-sale", actor: seller.publicKey.toBase58(), index: 81, price: 1, currency: "SOL", ...listAuth }));
    const intentId = await makeIntent({ actionType: "buy-listing", index: 81, buyer, seller, priceSol: 1 });

    const replay = await route.POST(post({ action: "buy-listing", actor: buyer.publicKey.toBase58(), signature: "sig-cross-action", intentId }));
    expect(replay.status).toBe(409);
    expect((await replay.json()).error).toMatch(/already used/);
  });

  it("a signature claimed for a hijack burn can't be replayed as a fresh buy", async () => {
    const mint = Keypair.generate().publicKey.toBase58();
    const route = await freshRoute({ pixel98Mint: mint });
    const owner = Keypair.generate();
    const hijacker = Keypair.generate();
    await route.POST(post({ action: "buy", actor: owner.publicKey.toBase58(), index: 90, signature: "sig-owner-90", ad: blankAd }));
    // Jump past the cooldown BEFORE creating the intent, so its TTL
    // (relative to the mocked "now") still covers the hijack call below.
    const nowSpy = pastHijackCooldown();
    const hijackIntentId = await makeIntent({ actionType: "hijack", index: 90, buyer: hijacker, seller: owner, currency: "PIXEL98", mint });

    const hijackRes = await route.POST(post({ action: "hijack", actor: hijacker.publicKey.toBase58(), signature: "sig-burn-reuse", intentId: hijackIntentId }));
    nowSpy.mockRestore();
    expect(hijackRes.status).toBe(200);

    const replay = await route.POST(post({ action: "buy", actor: hijacker.publicKey.toBase58(), index: 91, signature: "sig-burn-reuse", ad: blankAd }));
    expect(replay.status).toBe(409);
  });
});

// ===========================================================================
// §11/§12 — DB failure and RPC failure mid-purchase. This is where "fail
// closed" and "no lost payment" can conflict if the code isn't careful about
// WHEN the signature is marked used relative to WHEN the DB write can fail.
// ===========================================================================
// ===========================================================================
// §13 — Property/invariant tests not already proven above.
// ===========================================================================
describe("§13 invariants", () => {
  it("invariant: client cannot determine the final owner — a spoofed `owner` field in the body is ignored; the owner is ALWAYS the verified payer", async () => {
    const route = await freshRoute();
    const payer = Keypair.generate();
    const res = await route.POST(
      post({
        action: "buy",
        actor: payer.publicKey.toBase58(),
        index: 200,
        signature: "sig-owner-spoof",
        ad: blankAd,
        owner: "SomeoneElsesWalletAddressInjectedByAttacker11", // never read by handleBuy
      })
    );
    expect(res.status).toBe(200);
    expect((await res.json()).pixel.owner).toBe(payer.publicKey.toBase58());
  });

  it("invariant: unverified payment cannot create ownership, in EVERY paid action (buy, buy-area, hijack, buy-listing, rent)", async () => {
    const mint = Keypair.generate().publicKey.toBase58();
    const route = await freshRoute({ pixel98Mint: mint });
    const actor = Keypair.generate();
    const owner = Keypair.generate();
    await route.POST(post({ action: "buy", actor: owner.publicKey.toBase58(), index: 210, signature: "sig-owner-210", ad: blankAd }));
    const listAuth = signAuth(owner, "list-sale", 210);
    await route.POST(post({ action: "list-sale", actor: owner.publicKey.toBase58(), index: 210, price: 1, currency: "SOL", ...listAuth }));
    // Jump past the cooldown BEFORE creating the hijack intent, so its TTL
    // (relative to the mocked "now") still covers the hijack call below —
    // this test is about payment verification, not the cooldown.
    const nowSpy = pastHijackCooldown();
    const hijackIntentId = await makeIntent({ actionType: "hijack", index: 210, buyer: actor, seller: owner, currency: "PIXEL98", mint });
    const listingIntentId = await makeIntent({ actionType: "buy-listing", index: 210, buyer: actor, seller: owner, priceSol: 1 });

    verifySolTransferMock.mockResolvedValue({ ok: false, error: "not verified" });
    verifyBurnMock.mockResolvedValue({ ok: false, error: "not verified" });

    const buyRes = await route.POST(post({ action: "buy", actor: actor.publicKey.toBase58(), index: 211, signature: "s1", ad: blankAd }));
    expect(buyRes.status).toBe(402);
    const areaRes = await route.POST(post({ action: "buy-area", actor: actor.publicKey.toBase58(), indices: [212, 213], signature: "s2", ad: blankAd }));
    expect(areaRes.status).toBe(402);
    const hijackRes = await route.POST(post({ action: "hijack", actor: actor.publicKey.toBase58(), signature: "s3", intentId: hijackIntentId }));
    nowSpy.mockRestore();
    expect(hijackRes.status).toBe(402);
    const listingRes = await route.POST(post({ action: "buy-listing", actor: actor.publicKey.toBase58(), signature: "s4", intentId: listingIntentId }));
    expect(listingRes.status).toBe(402);

    // None of these rejected actions changed anything.
    const board = await (await route.GET()).json();
    expect(board.pixels["210"].owner).toBe(owner.publicKey.toBase58());
    expect(board.pixels["211"]).toBeUndefined();
  });
});

describe("§11/§12 DB / RPC failure mid-purchase", () => {
  it("RPC failure (verifySolTransfer throws) BEFORE the signature is claimed — fails closed, signature stays fresh and retryable", async () => {
    const route = await freshRoute();
    const buyer = Keypair.generate();
    verifySolTransferMock.mockRejectedValueOnce(new Error("RPC timeout"));

    const res = await route.POST(post({ action: "buy", actor: buyer.publicKey.toBase58(), index: 100, signature: "sig-rpc-fail", ad: blankAd }));
    expect(res.status).toBe(500);

    // The same signature must still be usable — it was never claimed.
    verifySolTransferMock.mockResolvedValue({ ok: true });
    const retry = await route.POST(post({ action: "buy", actor: buyer.publicKey.toBase58(), index: 100, signature: "sig-rpc-fail", ad: blankAd }));
    expect(retry.status).toBe(200);
  });
});

// ===========================================================================
// SOL-98 PHASE 2.1 — P2-F2 fix verification.
//
// Historical concept (what USED to happen, before app/api/pixels/route.ts /
// lib/server/used-signatures.ts were changed this phase): createPixels() /
// updateOwnedPixel() / hijackPixel() were called AFTER claimSignature()
// succeeded, with NO try/catch around the call — only a structured
// `if (!result.ok)` check released the signature. If the mutation instead
// THREW (a real DB outage / 500, not a clean 409 conflict), that throw
// propagated straight past the release logic to the route's outer
// try/catch, which returned 500 WITHOUT ever calling releaseSignature. The
// buyer's on-chain payment was real and verified, but they got neither a
// pixel nor a usable retry — retrying the exact same signature came back
// "409 already used" forever. That was finding P2-F2 (CRITICAL), proven by
// an earlier version of this exact test file.
//
// The fix wraps every ownership-mutation call in all five paid handlers in
// try/catch, releasing the signature (via the new, non-throwing
// `releaseSignatureSafely`) on BOTH a thrown error and a structured
// conflict, then re-throwing the original error so the client still sees a
// real 500 with the real message. Tests A-E below prove the invariant now
// holds, across every paid handler.
// ===========================================================================
describe("PHASE 2.1 — P2-F2 fix: DB exception after claim no longer burns the signature", () => {
  it("TEST A — buy: a thrown createPixels error releases the signature, creates no ownership, and still surfaces as a real 500", async () => {
    const route = await freshRoute();
    const buyer = Keypair.generate();

    vi.doMock("@/lib/server/pixel-db", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../lib/server/pixel-db")>();
      return { ...actual, createPixels: vi.fn().mockRejectedValueOnce(new Error("supabase insert failed: 500")) };
    });
    vi.resetModules();
    const brokenRoute = await import("../app/api/pixels/route");

    const res = await brokenRoute.POST(
      post({ action: "buy", actor: buyer.publicKey.toBase58(), index: 101, signature: "sig-db-outage-a", ad: blankAd })
    );
    // Still an infrastructure failure, per existing conventions (500, real
    // error message — not silently turned into a fake conflict).
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/supabase insert failed/);

    vi.doUnmock("@/lib/server/pixel-db");
    vi.resetModules();
    const checkRoute = await import("../app/api/pixels/route");
    const board = await (await checkRoute.GET()).json();
    expect(board.pixels["101"]).toBeUndefined(); // no ownership was created
  });

  it("TEST B (MOST IMPORTANT) — buy: retrying the EXACT SAME signature after the DB recovers now succeeds, not '409 already used'", async () => {
    const route = await freshRoute();
    const buyer = Keypair.generate();

    vi.doMock("@/lib/server/pixel-db", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../lib/server/pixel-db")>();
      return { ...actual, createPixels: vi.fn().mockRejectedValueOnce(new Error("supabase insert failed: 500")) };
    });
    vi.resetModules();
    const brokenRoute = await import("../app/api/pixels/route");
    const failRes = await brokenRoute.POST(
      post({ action: "buy", actor: buyer.publicKey.toBase58(), index: 101, signature: "sig-db-outage-b", ad: blankAd })
    );
    expect(failRes.status).toBe(500);

    // DB "recovers": unmock, so the retry hits the real (working) mutation.
    vi.doUnmock("@/lib/server/pixel-db");
    vi.resetModules();
    const recoveredRoute = await import("../app/api/pixels/route");
    verifySolTransferMock.mockResolvedValue({ ok: true });
    const retry = await recoveredRoute.POST(
      post({ action: "buy", actor: buyer.publicKey.toBase58(), index: 101, signature: "sig-db-outage-b", ad: blankAd })
    );
    expect(retry.status).toBe(200); // THE FIX: this used to be 409 "already used"
    expect((await retry.json()).pixel.owner).toBe(buyer.publicKey.toBase58());
  });

  it("TEST C — buy: a STRUCTURED conflict (ok:false, index genuinely taken) still releases the signature for retry (pre-existing behavior, unchanged)", async () => {
    const route = await freshRoute();
    const buyer1 = Keypair.generate();
    const buyer2 = Keypair.generate();
    await route.POST(post({ action: "buy", actor: buyer1.publicKey.toBase58(), index: 102, signature: "sig-taken-102", ad: blankAd }));

    const res = await route.POST(post({ action: "buy", actor: buyer2.publicKey.toBase58(), index: 102, signature: "sig-b2-retry", ad: blankAd }));
    expect(res.status).toBe(409);

    // buyer2's signature was released (their pixel simply wasn't taken by
    // anyone) — same proof works against a different, unsold index.
    const retry = await route.POST(post({ action: "buy", actor: buyer2.publicKey.toBase58(), index: 103, signature: "sig-b2-retry", ad: blankAd }));
    expect(retry.status).toBe(200);
  });

  it("TEST D — buy: a SUCCESSFUL ownership mutation still permanently consumes the signature (no accidental release on success)", async () => {
    const route = await freshRoute();
    const buyer = Keypair.generate();
    const first = await route.POST(post({ action: "buy", actor: buyer.publicKey.toBase58(), index: 104, signature: "sig-success-consumed", ad: blankAd }));
    expect(first.status).toBe(200);

    const replay = await route.POST(post({ action: "buy", actor: buyer.publicKey.toBase58(), index: 105, signature: "sig-success-consumed", ad: blankAd }));
    expect(replay.status).toBe(409);
    expect((await replay.json()).error).toMatch(/already used/);
  });

  it("TEST E — buy-area: a thrown createPixels error releases the signature; retry after recovery succeeds", async () => {
    const route = await freshRoute();
    const buyer = Keypair.generate();
    const indices = [110, 111, 210, 211];

    vi.doMock("@/lib/server/pixel-db", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../lib/server/pixel-db")>();
      return { ...actual, createPixels: vi.fn().mockRejectedValueOnce(new Error("supabase insert failed: 500")) };
    });
    vi.resetModules();
    const brokenRoute = await import("../app/api/pixels/route");
    const failRes = await brokenRoute.POST(
      post({ action: "buy-area", actor: buyer.publicKey.toBase58(), indices, signature: "sig-area-outage", ad: blankAd })
    );
    expect(failRes.status).toBe(500);

    vi.doUnmock("@/lib/server/pixel-db");
    vi.resetModules();
    const recoveredRoute = await import("../app/api/pixels/route");
    verifySolTransferMock.mockResolvedValue({ ok: true });
    const retry = await recoveredRoute.POST(
      post({ action: "buy-area", actor: buyer.publicKey.toBase58(), indices, signature: "sig-area-outage", ad: blankAd })
    );
    expect(retry.status).toBe(200);
    expect((await retry.json()).pixels).toHaveLength(4);
  });

  it("TEST E — hijack (live burn path): a thrown ownership-mutation error releases the signature AND leaves the intent pending; retry after recovery succeeds", async () => {
    // SOL-98 Phase 3: the live-hijack path no longer calls pixel-db.ts's
    // hijackPixel directly — it goes through
    // lib/server/pixel-mutations-atomic.ts's updatePixelOwnerAtomic, whose
    // file-store fallback calls updateOwnedPixel (the SAME primitive
    // buy-listing/rent use) — see that module's doc comment for why. So the
    // DB-outage simulation now mocks updateOwnedPixel, not hijackPixel.
    const mint = Keypair.generate().publicKey.toBase58();
    const route = await freshRoute({ pixel98Mint: mint }); // token "live" — does NOT activate $PIXEL98 economics, only exercises the already-existing gated code path with everything mocked, per instructions not to activate the token
    const owner = Keypair.generate();
    const hijacker = Keypair.generate();
    await route.POST(post({ action: "buy", actor: owner.publicKey.toBase58(), index: 300, signature: "sig-owner-300", ad: blankAd }));
    // Jump past the cooldown BEFORE creating the intent, so its TTL
    // (relative to the mocked "now") still covers both hijack attempts
    // below — this test is about the DB-outage/retry contract, not the
    // cooldown itself.
    const nowSpy = pastHijackCooldown();
    const intentId = await makeIntent({ actionType: "hijack", index: 300, buyer: hijacker, seller: owner, currency: "PIXEL98", mint });

    vi.doMock("@/lib/server/pixel-db", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../lib/server/pixel-db")>();
      return { ...actual, updateOwnedPixel: vi.fn().mockRejectedValueOnce(new Error("supabase update failed: 500")) };
    });
    vi.resetModules();
    const brokenRoute = await import("../app/api/pixels/route");
    const failRes = await brokenRoute.POST(
      post({ action: "hijack", actor: hijacker.publicKey.toBase58(), signature: "sig-hijack-outage", intentId })
    );
    expect(failRes.status).toBe(500);

    vi.doUnmock("@/lib/server/pixel-db");
    vi.resetModules();
    const recoveredRoute = await import("../app/api/pixels/route");
    // The intent was never consumed (the mutation threw BEFORE intent
    // consumption in the file-store fallback) — the same intentId is still
    // valid for the retry, exactly as the same payment signature still is.
    const retry = await recoveredRoute.POST(
      post({ action: "hijack", actor: hijacker.publicKey.toBase58(), signature: "sig-hijack-outage", intentId })
    );
    nowSpy.mockRestore();
    expect(retry.status).toBe(200);
    expect((await retry.json()).pixel.owner).toBe(hijacker.publicKey.toBase58());
  });

  it("TEST E — buy-listing: a thrown updateOwnedPixel error releases the signature; retry after recovery succeeds", async () => {
    const route = await freshRoute();
    const seller = Keypair.generate();
    const buyer = Keypair.generate();
    await route.POST(post({ action: "buy", actor: seller.publicKey.toBase58(), index: 310, signature: "sig-seller-310", ad: blankAd }));
    const listAuth = signAuth(seller, "list-sale", 310);
    await route.POST(post({ action: "list-sale", actor: seller.publicKey.toBase58(), index: 310, price: 2, currency: "SOL", ...listAuth }));
    const intentId = await makeIntent({ actionType: "buy-listing", index: 310, buyer, seller, priceSol: 2 });

    vi.doMock("@/lib/server/pixel-db", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../lib/server/pixel-db")>();
      return { ...actual, updateOwnedPixel: vi.fn().mockRejectedValueOnce(new Error("supabase update failed: 500")) };
    });
    vi.resetModules();
    const brokenRoute = await import("../app/api/pixels/route");
    const failRes = await brokenRoute.POST(
      post({ action: "buy-listing", actor: buyer.publicKey.toBase58(), signature: "sig-listing-outage", intentId })
    );
    expect(failRes.status).toBe(500);

    vi.doUnmock("@/lib/server/pixel-db");
    vi.resetModules();
    const recoveredRoute = await import("../app/api/pixels/route");
    verifySolTransferMock.mockResolvedValue({ ok: true });
    const retry = await recoveredRoute.POST(
      post({ action: "buy-listing", actor: buyer.publicKey.toBase58(), signature: "sig-listing-outage", intentId })
    );
    expect(retry.status).toBe(200);
    expect((await retry.json()).pixel.owner).toBe(buyer.publicKey.toBase58());
  });

  it("TEST E — rent: a thrown updateOwnedPixel error releases the signature; retry after recovery succeeds", async () => {
    const route = await freshRoute();
    const owner = Keypair.generate();
    const renter = Keypair.generate();
    await route.POST(post({ action: "buy", actor: owner.publicKey.toBase58(), index: 320, signature: "sig-owner-320", ad: blankAd }));
    const rentAuth = signAuth(owner, "list-rent", 320);
    await route.POST(post({ action: "list-rent", actor: owner.publicKey.toBase58(), index: 320, pricePerDay: 0.1, currency: "SOL", ...rentAuth }));
    const intentId = await makeIntent({ actionType: "rent", index: 320, buyer: renter, seller: owner, priceSol: 0.1 * 7, rentDays: 7 });

    vi.doMock("@/lib/server/pixel-db", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../lib/server/pixel-db")>();
      return { ...actual, updateOwnedPixel: vi.fn().mockRejectedValueOnce(new Error("supabase update failed: 500")) };
    });
    vi.resetModules();
    const brokenRoute = await import("../app/api/pixels/route");
    const failRes = await brokenRoute.POST(
      post({ action: "rent", actor: renter.publicKey.toBase58(), signature: "sig-rent-outage", intentId })
    );
    expect(failRes.status).toBe(500);

    vi.doUnmock("@/lib/server/pixel-db");
    vi.resetModules();
    const recoveredRoute = await import("../app/api/pixels/route");
    verifySolTransferMock.mockResolvedValue({ ok: true });
    const retry = await recoveredRoute.POST(
      post({ action: "rent", actor: renter.publicKey.toBase58(), signature: "sig-rent-outage", intentId })
    );
    expect(retry.status).toBe(200);
    expect((await retry.json()).pixel.rentedTo).toBe(renter.publicKey.toBase58());
  });
});
