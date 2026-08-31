import { promises as fs } from "fs";
import path from "path";
import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildAuthMessage } from "../lib/auth-message";
import { bytesToBase64 } from "../lib/bytes";

// End-to-end tests against the ACTUAL route handlers in app/api/pixels/route.ts
// (not just the pure helpers they call). This is what proves the "blockchain
// part" requirement from the audit brief: every ownership-changing action is
// (a) tied to the acting wallet's pubkey and (b) only accepted once a real
// verified proof of that wallet's authority exists — an on-chain payment
// signature for paid actions, or a fresh ed25519 signMessage proof for free
// owner-only actions. Nothing here trusts a bare `{index, owner}` POST.
//
// The RPC-touching verifiers (verify-tx.ts) and the burn-tier oracle
// (token-stats.ts) are mocked — they're already exhaustively unit-tested
// elsewhere (tests/verify-tx.test.ts, tests/token-stats.test.ts) against a
// faked Connection. Here we assert the ROUTE calls them correctly and reacts
// correctly to both outcomes.

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

const blankAd = { destination: "", imageUrl: "", message: "", neon: "none" };

beforeEach(async () => {
  await rmForce(DATA_DIR);
});

describe("POST /api/pixels — buy (treasury purchase, ownership tied to the paying wallet)", () => {
  it("rejects a request with no actor pubkey", async () => {
    const route = await freshRoute();
    const res = await route.POST(post({ action: "buy", index: 0 }));
    expect(res.status).toBe(400);
  });

  it("rejects when the payment signature doesn't verify", async () => {
    const route = await freshRoute();
    verifySolTransferMock.mockResolvedValue({ ok: false, error: "no matching transfer" });
    const buyer = Keypair.generate();
    const res = await route.POST(
      post({ action: "buy", actor: buyer.publicKey.toBase58(), index: 0, signature: "sig", ad: blankAd })
    );
    expect(res.status).toBe(402);
    const json = await res.json();
    expect(json.error).toMatch(/payment not verified/);
  });

  it("accepts a verified purchase and records the PAYING WALLET as the owner", async () => {
    const route = await freshRoute();
    const buyer = Keypair.generate();
    const res = await route.POST(
      post({ action: "buy", actor: buyer.publicKey.toBase58(), index: 0, signature: "sig-1", ad: blankAd })
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.pixel.owner).toBe(buyer.publicKey.toBase58());
    expect(json.pixel.index).toBe(0);

    // verifySolTransfer was asked to check a payment FROM the buyer TO the treasury.
    expect(verifySolTransferMock).toHaveBeenCalledWith(
      expect.objectContaining({ fromOwner: buyer.publicKey.toBase58(), toOwner: TREASURY.publicKey.toBase58() })
    );
  });

  it("rejects buying an already-owned spot", async () => {
    const route = await freshRoute();
    const buyer = Keypair.generate();
    await route.POST(post({ action: "buy", actor: buyer.publicKey.toBase58(), index: 5, signature: "sig-a", ad: blankAd }));
    const second = await route.POST(
      post({ action: "buy", actor: Keypair.generate().publicKey.toBase58(), index: 5, signature: "sig-b", ad: blankAd })
    );
    expect(second.status).toBe(409);
  });

  it("REPLAY PROTECTION: the same signature can't be claimed twice, even for a different index", async () => {
    const route = await freshRoute();
    const buyer = Keypair.generate();
    const first = await route.POST(
      post({ action: "buy", actor: buyer.publicKey.toBase58(), index: 1, signature: "sig-reused", ad: blankAd })
    );
    expect(first.status).toBe(200);
    const second = await route.POST(
      post({ action: "buy", actor: buyer.publicKey.toBase58(), index: 2, signature: "sig-reused", ad: blankAd })
    );
    expect(second.status).toBe(409);
    const json = await second.json();
    expect(json.error).toMatch(/already used/);
  });

  it("rejects an ad payload with an unsafe destination link", async () => {
    const route = await freshRoute();
    const buyer = Keypair.generate();
    const res = await route.POST(
      post({
        action: "buy",
        actor: buyer.publicKey.toBase58(),
        index: 0,
        signature: "sig",
        ad: { ...blankAd, destination: "javascript:alert(1)" },
      })
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /api/pixels — buy-area (banner geometry is derived server-side)", () => {
  it("rejects indices that don't form a gap-free rectangle", async () => {
    const route = await freshRoute();
    const buyer = Keypair.generate();
    // 0,1,2 and 100,101 — missing 102, not a full 2x3 rectangle.
    const res = await route.POST(
      post({ action: "buy-area", actor: buyer.publicKey.toBase58(), indices: [0, 1, 2, 100, 101], signature: "sig", ad: blankAd })
    );
    expect(res.status).toBe(400);
  });

  it("accepts a valid rectangle and derives consistent banner geometry for every block", async () => {
    const route = await freshRoute();
    const buyer = Keypair.generate();
    // A 2 (cols) x 2 (rows) rectangle at row 0-1, col 0-1 on a 100-wide board.
    const indices = [0, 1, 100, 101];
    const res = await route.POST(
      post({ action: "buy-area", actor: buyer.publicKey.toBase58(), indices, signature: "sig", ad: blankAd })
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.pixels).toHaveLength(4);
    const groupIds = new Set(json.pixels.map((p: { bannerGroupId: string }) => p.bannerGroupId));
    expect(groupIds.size).toBe(1); // all four blocks share one banner group
    expect(json.pixels.every((p: { owner: string }) => p.owner === buyer.publicKey.toBase58())).toBe(true);
    expect(json.pixels.every((p: { bannerCols: number; bannerRows: number }) => p.bannerCols === 2 && p.bannerRows === 2)).toBe(
      true
    );
  });

  it("if part of the area was just sold, the whole batch fails and the signature stays valid to retry", async () => {
    const route = await freshRoute();
    const buyer = Keypair.generate();
    await route.POST(post({ action: "buy", actor: buyer.publicKey.toBase58(), index: 1, signature: "sig-taken", ad: blankAd }));

    const res = await route.POST(
      post({ action: "buy-area", actor: buyer.publicKey.toBase58(), indices: [0, 1], signature: "sig-area", ad: blankAd })
    );
    expect(res.status).toBe(409);
    // the payment proof was released, so it can still be claimed by a fresh purchase
    const retry = await route.POST(post({ action: "buy", actor: buyer.publicKey.toBase58(), index: 50, signature: "sig-area", ad: blankAd }));
    expect(retry.status).toBe(200);
  });
});

describe("POST /api/pixels — hijack (pre-launch simulated vs post-launch real burn)", () => {
  it("pre-launch: requires a fresh wallet-signed auth proof, not a bare claim", async () => {
    const route = await freshRoute(); // no PIXEL98_MINT → pre-launch
    const owner = Keypair.generate();
    const hijacker = Keypair.generate();
    await route.POST(post({ action: "buy", actor: owner.publicKey.toBase58(), index: 7, signature: "sig-own", ad: blankAd }));

    const noAuth = await route.POST(post({ action: "hijack", actor: hijacker.publicKey.toBase58(), index: 7 }));
    expect(noAuth.status).toBe(401);
  });

  it("pre-launch: rejects an auth proof signed by a DIFFERENT wallet than the claimed actor (forged ownership)", async () => {
    const route = await freshRoute();
    const owner = Keypair.generate();
    const hijacker = Keypair.generate();
    const impostor = Keypair.generate();
    await route.POST(post({ action: "buy", actor: owner.publicKey.toBase58(), index: 8, signature: "sig-own2", ad: blankAd }));

    // `impostor` signs, but the request claims to be `hijacker`.
    const forgedAuth = signAuth(impostor, "hijack", 8);
    const res = await route.POST(post({ action: "hijack", actor: hijacker.publicKey.toBase58(), index: 8, ...forgedAuth }));
    expect(res.status).toBe(401);
  });

  it("pre-launch: a genuine wallet-signed proof performs a FREE simulated hijack and transfers ownership", async () => {
    const route = await freshRoute();
    const owner = Keypair.generate();
    const hijacker = Keypair.generate();
    await route.POST(post({ action: "buy", actor: owner.publicKey.toBase58(), index: 9, signature: "sig-own3", ad: blankAd }));

    const auth = signAuth(hijacker, "hijack", 9);
    const res = await route.POST(post({ action: "hijack", actor: hijacker.publicKey.toBase58(), index: 9, ...auth }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.simulated).toBe(true);
    expect(json.pixel.owner).toBe(hijacker.publicKey.toBase58());
    // no burn/transfer verification should ever have been consulted pre-launch
    expect(verifyBurnMock).not.toHaveBeenCalled();
  });

  it("post-launch: requires a verified on-chain burn, not just a signature claim", async () => {
    const route = await freshRoute({ pixel98Mint: Keypair.generate().publicKey.toBase58() });
    const owner = Keypair.generate();
    const hijacker = Keypair.generate();
    await route.POST(post({ action: "buy", actor: owner.publicKey.toBase58(), index: 10, signature: "sig-own4", ad: blankAd }));

    verifyBurnMock.mockResolvedValue({ ok: false, error: "no matching burn" });
    const res = await route.POST(
      post({ action: "hijack", actor: hijacker.publicKey.toBase58(), index: 10, signature: "burn-sig" })
    );
    expect(res.status).toBe(402);
    expect((await res.json()).error).toMatch(/burn not verified/);
  });

  it("post-launch: a verified burn + owner-compensation transfer succeeds and transfers ownership", async () => {
    const route = await freshRoute({ pixel98Mint: Keypair.generate().publicKey.toBase58() });
    const owner = Keypair.generate();
    const hijacker = Keypair.generate();
    await route.POST(post({ action: "buy", actor: owner.publicKey.toBase58(), index: 11, signature: "sig-own5", ad: blankAd }));

    const res = await route.POST(
      post({ action: "hijack", actor: hijacker.publicKey.toBase58(), index: 11, signature: "burn-sig-ok" })
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.simulated).toBe(false);
    expect(json.pixel.owner).toBe(hijacker.publicKey.toBase58());
    // the owner-compensation half must be verified as going to the ORIGINAL owner
    expect(verifyTokenTransferMock).toHaveBeenCalledWith(
      expect.objectContaining({ fromOwner: hijacker.publicKey.toBase58(), toOwner: owner.publicKey.toBase58() })
    );
  });
});

describe("POST /api/pixels — edit / list / unlist (free, owner-only, signature-gated)", () => {
  it("rejects an edit from a wallet that isn't the stored owner, even with a VALID signature of its own", async () => {
    const route = await freshRoute();
    const alice = Keypair.generate();
    const bob = Keypair.generate();
    await route.POST(post({ action: "buy", actor: alice.publicKey.toBase58(), index: 20, signature: "sig-alice", ad: blankAd }));

    // Bob genuinely signs as himself — the signature is valid — but he doesn't own spot 20.
    const bobAuth = signAuth(bob, "edit", 20);
    const res = await route.POST(
      post({ action: "edit", actor: bob.publicKey.toBase58(), index: 20, ad: { ...blankAd, message: "pwned" }, ...bobAuth })
    );
    expect(res.status).toBe(403);
  });

  it("lets the real owner edit their own pixel with a fresh signed proof", async () => {
    const route = await freshRoute();
    const alice = Keypair.generate();
    await route.POST(post({ action: "buy", actor: alice.publicKey.toBase58(), index: 21, signature: "sig-alice2", ad: blankAd }));

    const auth = signAuth(alice, "edit", 21);
    const res = await route.POST(
      post({ action: "edit", actor: alice.publicKey.toBase58(), index: 21, ad: { ...blankAd, message: "gm" }, ...auth })
    );
    expect(res.status).toBe(200);
    expect((await res.json()).pixel.message).toBe("gm");
  });

  it("rejects a stale (expired) auth proof — replay window is bounded", async () => {
    const route = await freshRoute();
    const alice = Keypair.generate();
    await route.POST(post({ action: "buy", actor: alice.publicKey.toBase58(), index: 22, signature: "sig-alice3", ad: blankAd }));

    const staleTimestamp = Date.now() - 10 * 60_000; // 10 minutes ago, past the 5-minute window
    const auth = signAuth(alice, "edit", 22, staleTimestamp);
    const res = await route.POST(
      post({ action: "edit", actor: alice.publicKey.toBase58(), index: 22, ad: blankAd, ...auth })
    );
    expect(res.status).toBe(401);
  });

  it("list-sale then unlist round-trips and requires the owner's signature both times", async () => {
    const route = await freshRoute();
    const alice = Keypair.generate();
    await route.POST(post({ action: "buy", actor: alice.publicKey.toBase58(), index: 23, signature: "sig-alice4", ad: blankAd }));

    const listAuth = signAuth(alice, "list-sale", 23);
    const listRes = await route.POST(
      post({ action: "list-sale", actor: alice.publicKey.toBase58(), index: 23, price: 1.5, currency: "SOL", ...listAuth })
    );
    expect(listRes.status).toBe(200);
    expect((await listRes.json()).pixel.listingPriceSol).toBe(1.5);

    const unlistAuth = signAuth(alice, "unlist", 23);
    const unlistRes = await route.POST(post({ action: "unlist", actor: alice.publicKey.toBase58(), index: 23, ...unlistAuth }));
    expect(unlistRes.status).toBe(200);
    expect((await unlistRes.json()).pixel.listingPriceSol).toBeUndefined();
  });
});

describe("POST /api/pixels — buy-listing / rent (peer-to-peer, pays the CURRENT OWNER, never the treasury)", () => {
  it("buy-listing pays the SELLER directly, and ownership transfers to the buyer", async () => {
    const route = await freshRoute();
    const alice = Keypair.generate();
    const bob = Keypair.generate();
    await route.POST(post({ action: "buy", actor: alice.publicKey.toBase58(), index: 30, signature: "sig-alice5", ad: blankAd }));
    const listAuth = signAuth(alice, "list-sale", 30);
    await route.POST(post({ action: "list-sale", actor: alice.publicKey.toBase58(), index: 30, price: 2, currency: "SOL", ...listAuth }));

    const res = await route.POST(
      post({ action: "buy-listing", actor: bob.publicKey.toBase58(), index: 30, signature: "sig-p2p" })
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.pixel.owner).toBe(bob.publicKey.toBase58());
    expect(verifySolTransferMock).toHaveBeenCalledWith(
      expect.objectContaining({ fromOwner: bob.publicKey.toBase58(), toOwner: alice.publicKey.toBase58() })
    );
  });

  it("rejects buying your own listing", async () => {
    const route = await freshRoute();
    const alice = Keypair.generate();
    await route.POST(post({ action: "buy", actor: alice.publicKey.toBase58(), index: 31, signature: "sig-a6", ad: blankAd }));
    const listAuth = signAuth(alice, "list-sale", 31);
    await route.POST(post({ action: "list-sale", actor: alice.publicKey.toBase58(), index: 31, price: 2, currency: "SOL", ...listAuth }));

    const res = await route.POST(post({ action: "buy-listing", actor: alice.publicKey.toBase58(), index: 31, signature: "sig-self" }));
    expect(res.status).toBe(400);
  });

  it("a $PIXEL98-priced listing can't be bought before the token is live", async () => {
    const route = await freshRoute(); // pre-launch
    const alice = Keypair.generate();
    const bob = Keypair.generate();
    await route.POST(post({ action: "buy", actor: alice.publicKey.toBase58(), index: 32, signature: "sig-a7", ad: blankAd }));
    const listAuth = signAuth(alice, "list-sale", 32);
    await route.POST(
      post({ action: "list-sale", actor: alice.publicKey.toBase58(), index: 32, price: 5000, currency: "PIXEL98", ...listAuth })
    );

    const res = await route.POST(post({ action: "buy-listing", actor: bob.publicKey.toBase58(), index: 32, signature: "sig-tok" }));
    expect(res.status).toBe(503);
  });

  it("rent pays the owner for price*days and marks the spot rented to the renter", async () => {
    const route = await freshRoute();
    const alice = Keypair.generate();
    const bob = Keypair.generate();
    await route.POST(post({ action: "buy", actor: alice.publicKey.toBase58(), index: 33, signature: "sig-a8", ad: blankAd }));
    const rentAuth = signAuth(alice, "list-rent", 33);
    await route.POST(
      post({ action: "list-rent", actor: alice.publicKey.toBase58(), index: 33, pricePerDay: 0.05, currency: "SOL", ...rentAuth })
    );

    const res = await route.POST(post({ action: "rent", actor: bob.publicKey.toBase58(), index: 33, days: 30, signature: "sig-rent" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.pixel.isRented).toBe(true);
    expect(json.pixel.rentedTo).toBe(bob.publicKey.toBase58());
    expect(json.pixel.owner).toBe(alice.publicKey.toBase58()); // renting never changes ownership
    expect(verifySolTransferMock).toHaveBeenCalledWith(
      expect.objectContaining({ fromOwner: bob.publicKey.toBase58(), toOwner: alice.publicKey.toBase58() })
    );
  });
});

describe("GET /api/pixels", () => {
  it("returns the whole board and the current burned fraction", async () => {
    const route = await freshRoute();
    const buyer = Keypair.generate();
    await route.POST(post({ action: "buy", actor: buyer.publicKey.toBase58(), index: 0, signature: "sig", ad: blankAd }));

    const res = await route.GET();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.pixels["0"].owner).toBe(buyer.publicKey.toBase58());
    expect(json.burnedFraction).toBe(0);
  });
});
