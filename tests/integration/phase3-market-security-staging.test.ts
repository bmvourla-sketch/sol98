// SOL-98 Phase 3 (MARKET SECURITY) — the four red-team checklist items,
// coded AND run against the REAL staging Supabase project (never
// production, red rule #10). NOT part of `npm test` — run explicitly:
//
//   SUPABASE_URL=https://<staging-ref>.supabase.co \
//   SUPABASE_SERVICE_ROLE_KEY=<staging-service-role-or-secret-key> \
//   NODE_ENV=production \
//     npx vitest run --config vitest.integration.config.mts tests/integration/phase3-market-security-staging.test.ts
//
// Checklist (verbatim from the Phase 3 brief):
//   [ ] User creates an intent for Pixel A, attempts to buy Pixel B — REJECTED.
//   [ ] Payment with an EXPIRED intent — REJECTED.
//   [ ] Payment attempted with another wallet's intent_id — REJECTED.
//   [ ] DB RPC: Ownership + Ledger atomicity (a ledger constraint violation
//       must roll back the ownership mutation too).
//
// Items 1-3 go through the REAL app/api/pixels/route.ts + POST-derived
// purchase_intents flow against real Postgres (only verify-tx / token-stats
// are mocked — same rationale as every other route test file: those are
// already exhaustively unit-tested against a faked Connection elsewhere).
// Item 4 calls the update_pixel_owner_atomic RPC directly via PostgREST, to
// prove the Postgres transaction boundary itself, independent of any
// application-layer code.
import { Keypair } from "@solana/web3.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const HAVE_STAGING = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
const d = HAVE_STAGING ? describe : describe.skip;

// SOL-98's isValidIndex caps the main board at TOTAL_SPOTS (10,000, see
// lib/pricing.ts) and POST /api/purchase-intents enforces that same range —
// unlike phase1-staging.test.ts / phase2-concurrency.test.ts (which call
// lib/server/pixel-db.ts directly and so can use an arbitrary
// out-of-board-range index block like 8_000_000+ to guarantee no
// collision), this file exercises the REAL HTTP routes end to end and so
// must stay in-range. 9990-9999 is reserved here as a small, dedicated,
// unlikely-to-collide block at the very top of the board.
const TEST_INDEX_BASE = 9990;
let nextIndex = TEST_INDEX_BASE;
function freshIndex() {
  if (nextIndex > 9999) throw new Error("phase3 staging test index block (9990-9999) exhausted");
  return nextIndex++;
}
// Unlike phase1-staging.test.ts / phase2-concurrency.test.ts's freshWallet
// (an arbitrary "Phase1TestXxxx111..." string), THIS file's wallets go
// through the real HTTP routes' parsePubkey(), which requires an actual
// base58-encoded ed25519 public key — a plain tagged string fails with
// "missing or invalid actor pubkey" before any of this phase's logic even
// runs. Real (unfunded, throwaway) keypairs cost nothing to generate.
function freshWallet(_tag: string): string {
  return Keypair.generate().publicKey.toBase58();
}
function freshSignature(tag: string) {
  return `phase3test-sig-${tag}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function headers() {
  return {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  };
}

async function cleanup() {
  const base = process.env.SUPABASE_URL!;
  await fetch(`${base}/rest/v1/pixels?index=gte.${TEST_INDEX_BASE}`, { method: "DELETE", headers: headers() });
  await fetch(`${base}/rest/v1/used_signatures?signature=like.phase3test-*`, { method: "DELETE", headers: headers() });
  await fetch(`${base}/rest/v1/payment_transactions?signature=like.phase3test-*`, { method: "DELETE", headers: headers() });
  await fetch(`${base}/rest/v1/pixel_ownership_history?pixel_index=gte.${TEST_INDEX_BASE}`, { method: "DELETE", headers: headers() });
  // Wallets here are real generated keypairs (not a "Phase3Test..." tagged
  // string — see freshWallet's doc comment), so intents are identified by
  // the same reserved index range instead.
  await fetch(`${base}/rest/v1/purchase_intents?pixel_index=gte.${TEST_INDEX_BASE}`, { method: "DELETE", headers: headers() });
}

const verifySolTransferMock = vi.fn();
const verifyBurnMock = vi.fn();
const verifyTokenTransferMock = vi.fn();
const tokenAmountToRawMock = vi.fn();
const getBurnedFractionMock = vi.fn();

vi.mock("@/lib/server/verify-tx", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/server/verify-tx")>();
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

async function freshRoutes() {
  vi.resetModules();
  process.env.NEXT_PUBLIC_TREASURY_ADDRESS = TREASURY.publicKey.toBase58();
  delete process.env.NEXT_PUBLIC_PIXEL98_MINT;

  verifySolTransferMock.mockReset().mockResolvedValue({ ok: true });
  verifyBurnMock.mockReset().mockResolvedValue({ ok: true });
  verifyTokenTransferMock.mockReset().mockResolvedValue({ ok: true });
  tokenAmountToRawMock.mockReset().mockResolvedValue(1000n);
  getBurnedFractionMock.mockReset().mockResolvedValue(0);

  const pixels = await import("../../app/api/pixels/route");
  const intents = await import("../../app/api/purchase-intents/route");
  return { pixels, intents };
}

function post(url: string, body: Record<string, unknown>) {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
const postPixels = (body: Record<string, unknown>) => post("http://localhost/api/pixels", body);
const postIntents = (body: Record<string, unknown>) => post("http://localhost/api/purchase-intents", body);

// Seeds an owned, listed pixel directly via PostgREST — this file is about
// the intent/redemption flow, not the buy/list-sale flows (already covered
// by phase1-staging.test.ts and the unit suite), so it bypasses both the
// "buy" action (treasury purchase) and "list-sale" (needs a wallet-signed
// auth proof) and writes the equivalent end state in one insert.
async function seedListedPixel(index: number, seller: string, priceSol: number) {
  const base = process.env.SUPABASE_URL!;
  await fetch(`${base}/rest/v1/pixels`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify([
      {
        index,
        data: {
          index,
          owner: seller,
          destination: "",
          imageUrl: "",
          message: "",
          neon: "none",
          valuationSol: 0.2,
          purchasedAt: Date.now(),
          isRented: false,
          listingPriceSol: priceSol,
        },
      },
    ]),
  });
}

d("Phase 3 — market security red team, against real staging DB", () => {
  beforeAll(async () => {
    await cleanup();
  });
  afterAll(async () => {
    await cleanup();
  });

  it("RED TEAM #1 — an intent created for Pixel A cannot result in ownership of Pixel B, even when B has an identical (seller, price)", async () => {
    const { pixels, intents } = await freshRoutes();
    const seller = freshWallet("s1Seller");
    const buyer = freshWallet("s1Buyer");
    const indexA = freshIndex();
    const indexB = freshIndex();
    await seedListedPixel(indexA, seller, 2);
    await seedListedPixel(indexB, seller, 2);

    const createdRes = await intents.POST(postIntents({ actor: buyer, actionType: "buy-listing", index: indexA }));
    expect(createdRes.status).toBe(200);
    const { intentId } = await createdRes.json();

    const res = await pixels.POST(postPixels({ action: "buy-listing", actor: buyer, signature: freshSignature("s1-redeem"), intentId }));
    expect(res.status).toBe(200);
    const pixel = (await res.json()).pixel;
    expect(pixel.index).toBe(indexA);
    expect(pixel.owner).toBe(buyer);

    const base = process.env.SUPABASE_URL!;
    const checkB = await fetch(`${base}/rest/v1/pixels?index=eq.${indexB}&select=data`, { headers: headers() });
    const rowsB = (await checkB.json()) as { data: { owner: string } }[];
    expect(rowsB[0].data.owner).toBe(seller); // untouched — real Postgres row, not a mock
  });

  it("RED TEAM #2 — payment with an EXPIRED intent must be REJECTED (410), against real Postgres now() semantics", async () => {
    const { pixels } = await freshRoutes();
    const seller = freshWallet("s2Seller");
    const buyer = freshWallet("s2Buyer");
    const index = freshIndex();
    await seedListedPixel(index, seller, 2);

    const { createIntent } = await import("../../lib/server/intent-db");
    const expired = await createIntent({
      actionType: "buy-listing",
      boardId: null,
      pixelIndex: index,
      buyerWallet: buyer,
      sellerWallet: seller,
      currency: "SOL",
      priceSol: 2,
      ttlMs: -1000, // already expired per the DATABASE's clock, not just this process's
    });

    const res = await pixels.POST(postPixels({ action: "buy-listing", actor: buyer, signature: freshSignature("s2-redeem"), intentId: expired.id }));
    expect(res.status).toBe(410);

    const base = process.env.SUPABASE_URL!;
    const check = await fetch(`${base}/rest/v1/pixels?index=eq.${index}&select=data`, { headers: headers() });
    const rows = (await check.json()) as { data: { owner: string } }[];
    expect(rows[0].data.owner).toBe(seller);
  });

  it("RED TEAM #3 — payment attempted with ANOTHER WALLET's intent_id must be REJECTED (403), against real Postgres row data", async () => {
    const { pixels, intents } = await freshRoutes();
    const seller = freshWallet("s3Seller");
    const rightfulBuyer = freshWallet("s3Buyer");
    const attacker = freshWallet("s3Attacker");
    const index = freshIndex();
    await seedListedPixel(index, seller, 2);

    const createdRes = await intents.POST(postIntents({ actor: rightfulBuyer, actionType: "buy-listing", index }));
    const { intentId } = await createdRes.json();

    const res = await pixels.POST(postPixels({ action: "buy-listing", actor: attacker, signature: freshSignature("s3-attack"), intentId }));
    expect(res.status).toBe(403);

    const base = process.env.SUPABASE_URL!;
    const check = await fetch(`${base}/rest/v1/pixels?index=eq.${index}&select=data`, { headers: headers() });
    const rows = (await check.json()) as { data: { owner: string } }[];
    expect(rows[0].data.owner).toBe(seller);
  });

  it("RED TEAM #4 — DB RPC atomicity: a payment_transactions UNIQUE(signature) violation inside update_pixel_owner_atomic rolls back the ownership UPDATE from the SAME call", async () => {
    const base = process.env.SUPABASE_URL!;
    const index = freshIndex();
    const seller = freshWallet("s4Seller");
    const buyer = freshWallet("s4Buyer");
    const signature = freshSignature("atomicity");

    // Seed a pixel directly (no route involved — this test is about the
    // RPC/transaction boundary itself, not the application layer).
    await fetch(`${base}/rest/v1/pixels`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify([
        {
          index,
          data: {
            index,
            owner: seller,
            destination: "",
            imageUrl: "",
            message: "",
            neon: "none",
            valuationSol: 0.2,
            purchasedAt: Date.now(),
            isRented: false,
            listingPriceSol: 2,
          },
        },
      ]),
    });

    // Pre-insert a payment_transactions row using the EXACT signature the
    // RPC call below will also try to insert — deterministically triggers a
    // unique_violation INSIDE the function body, at the ledger-insert step,
    // which runs strictly AFTER the ownership UPDATE has already executed
    // (but not yet committed) within that same function call.
    const preInsert = await fetch(`${base}/rest/v1/payment_transactions`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ signature, wallet: "pre-existing-unrelated-wallet", action: "buy-listing", amount_sol: 2 }),
    });
    expect([201, 204]).toContain(preInsert.status);

    const rpcRes = await fetch(`${base}/rest/v1/rpc/update_pixel_owner_atomic`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        p_index: index,
        p_expected_owner: seller,
        p_new_data: {
          index,
          owner: buyer,
          destination: "",
          imageUrl: "",
          message: "",
          neon: "none",
          valuationSol: 0.2,
          purchasedAt: Date.now(),
          isRented: false,
        },
        p_signature: signature,
        p_wallet: buyer,
        p_action: "buy-listing",
        p_amount_sol: 2,
        p_mint: null,
        p_intent_id: null,
        p_prev_owner: seller,
        p_new_owner: buyer,
        p_record_history: true,
      }),
    });

    // The function call itself must fail — the unique_violation propagates
    // as a PostgREST error response, not a quiet {ok:false}.
    expect(rpcRes.ok).toBe(false);

    // The ownership UPDATE that ran successfully EARLIER in this exact same
    // function call must have been rolled back along with the failed
    // ledger insert — this is the whole point of doing both in one
    // Postgres function instead of two independent PostgREST writes.
    const check = await fetch(`${base}/rest/v1/pixels?index=eq.${index}&select=data`, { headers: headers() });
    const rows = (await check.json()) as { data: { owner: string } }[];
    expect(rows[0].data.owner).toBe(seller); // NOT buyer

    // And no ownership_history row was left behind either (that INSERT is
    // even later in the function body — never reached).
    const historyCheck = await fetch(
      `${base}/rest/v1/pixel_ownership_history?pixel_index=eq.${index}&signature=eq.${signature}`,
      { headers: headers() }
    );
    const historyRows = (await historyCheck.json()) as unknown[];
    expect(historyRows).toHaveLength(0);

    // And there is still exactly ONE payment_transactions row for this
    // signature (the pre-inserted one) — the RPC's own attempted insert did
    // not silently create a duplicate.
    const ledgerCheck = await fetch(`${base}/rest/v1/payment_transactions?signature=eq.${signature}`, { headers: headers() });
    const ledgerRows = (await ledgerCheck.json()) as { wallet: string }[];
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0].wallet).toBe("pre-existing-unrelated-wallet");
  });
});
