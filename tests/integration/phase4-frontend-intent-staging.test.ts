// SOL-98 Phase 4 (FRONTEND INTENT INTEGRATION) — GÖREV 1, run against the
// REAL staging Supabase project (never production, red rule #10). NOT part
// of `npm test` — run explicitly:
//
//   SUPABASE_URL=https://<staging-ref>.supabase.co \
//   SUPABASE_SERVICE_ROLE_KEY=<staging-service-role-or-secret-key> \
//   NODE_ENV=production \
//     npx vitest run --config vitest.integration.config.mts tests/integration/phase4-frontend-intent-staging.test.ts
//
// Covers the Phase 4 test requirements (verbatim):
//   [ ] UI üzerinden başarılı bir "buy-listing" akışı (Intent oluşturma ->
//       İmza -> Başarılı API çağrısı).
//   [ ] Kasıtlı olarak intent'i expire edip (DB'den süreyi geriye alarak)
//       UI'ın bu hatayı yakalayıp düzgün bir mesaj göstermesi.
//
// "UI üzerinden" here means through the client's own code, not a browser:
// this file does NOT re-implement the client's request/response contract —
// it calls lib/purchase-intent.ts's real createPurchaseIntent()/postJson()
// (the EXACT functions lib/pixel-store.tsx / lib/board-store.tsx call) with
// `global.fetch` stubbed to forward directly into the real Next.js route
// handlers (app/api/purchase-intents/route.ts, app/api/pixels/route.ts) —
// which run for real against real staging Postgres. This proves the whole
// chain: client request shape -> server validation -> real DB read/write ->
// server response shape -> client error classification (ApiError status ->
// friendlyIntentError message), with nothing mocked except the on-chain
// payment verification (verifySolTransfer) — same rationale as every other
// route test file in this repo.
import { Keypair } from "@solana/web3.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const HAVE_STAGING = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
const d = HAVE_STAGING ? describe : describe.skip;

// Own dedicated block, disjoint from phase3's (9990-9999) and phase4's
// treasury-atomicity file's (9950-9989).
const TEST_INDEX_BASE = 9900;
let nextIndex = TEST_INDEX_BASE;
function freshIndex() {
  if (nextIndex > 9949) throw new Error("phase4 frontend-intent staging test index block (9900-9949) exhausted");
  return nextIndex++;
}
function freshWallet(): string {
  return Keypair.generate().publicKey.toBase58();
}
function freshSignature(tag: string) {
  return `phase4test-sig-${tag}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
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
  await fetch(`${base}/rest/v1/pixels?index=gte.${TEST_INDEX_BASE}&index=lt.9950`, { method: "DELETE", headers: headers() });
  await fetch(`${base}/rest/v1/used_signatures?signature=like.phase4test-*`, { method: "DELETE", headers: headers() });
  await fetch(`${base}/rest/v1/payment_transactions?signature=like.phase4test-*`, { method: "DELETE", headers: headers() });
  await fetch(`${base}/rest/v1/pixel_ownership_history?pixel_index=gte.${TEST_INDEX_BASE}&pixel_index=lt.9950`, {
    method: "DELETE",
    headers: headers(),
  });
  await fetch(`${base}/rest/v1/purchase_intents?pixel_index=gte.${TEST_INDEX_BASE}&pixel_index=lt.9950`, {
    method: "DELETE",
    headers: headers(),
  });
}

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

const verifySolTransferMock = vi.fn();
vi.mock("@/lib/server/verify-tx", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/server/verify-tx")>();
  return { ...actual, verifySolTransfer: (...args: unknown[]) => verifySolTransferMock(...args) };
});
vi.mock("@/lib/server/token-stats", () => ({ getBurnedFraction: () => Promise.resolve(0) }));

async function freshRoutes() {
  vi.resetModules();
  delete process.env.NEXT_PUBLIC_PIXEL98_MINT;
  verifySolTransferMock.mockReset().mockResolvedValue({ ok: true });

  const pixels = await import("../../app/api/pixels/route");
  const intents = await import("../../app/api/purchase-intents/route");
  // lib/purchase-intent.ts is imported AFTER vi.resetModules() so it binds
  // fresh, same as the route modules above.
  const client = await import("../../lib/purchase-intent");
  return { pixels, intents, client };
}

/**
 * Wires `global.fetch` to forward straight into the real route handlers —
 * the exact `Request`/`Response` objects Next.js itself would construct
 * from an HTTP call, just without an HTTP server in between. This is what
 * makes lib/purchase-intent.ts's createPurchaseIntent()/postJson() run for
 * real against real Postgres in this test, unmodified.
 */
const realFetch = globalThis.fetch;

function wireFetchToRoutes(routes: Awaited<ReturnType<typeof freshRoutes>>) {
  const fetchShim = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    // Only lib/purchase-intent.ts's own relative-path calls (/api/...) are
    // routed into the real Next.js handlers below — everything else (this
    // file's own direct-to-Supabase seed/verify/cleanup calls, which also
    // run through the global `fetch`) passes straight through to the real
    // network fetch, unmodified.
    if (url.startsWith("/api/purchase-intents")) return routes.intents.POST(new Request(`http://localhost${url}`, init));
    if (url.startsWith("/api/pixels")) return routes.pixels.POST(new Request(`http://localhost${url}`, init));
    return realFetch(input, init);
  });
  vi.stubGlobal("fetch", fetchShim);
  return fetchShim;
}

beforeEach(() => {
  // Each test calls wireFetchToRoutes itself (after freshRoutes(), so the
  // shim closes over that call's fresh route module instances) — this only
  // guarantees a clean slate between tests.
  vi.unstubAllGlobals();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

d("Phase 4 — frontend intent flow (lib/purchase-intent.ts) against real staging DB + real routes", () => {
  beforeAll(async () => {
    await cleanup();
  });
  afterAll(async () => {
    await cleanup();
  });

  it("buy-listing happy path: create intent -> (skip real wallet signature; verifySolTransfer mocked ok) -> redeem -> real Postgres ownership change", async () => {
    const routes = await freshRoutes();
    wireFetchToRoutes(routes);
    const seller = freshWallet();
    const buyer = freshWallet();
    const index = freshIndex();
    await seedListedPixel(index, seller, 1.5);

    // Step 1: intent creation — through the REAL client module.
    const intent = await routes.client.createPurchaseIntent({ actor: buyer, actionType: "buy-listing", index });
    expect(intent.intentId).toBeTruthy();
    expect(intent.currency).toBe("SOL");
    expect(intent.priceSol).toBe(1.5);
    expect(intent.sellerWallet).toBe(seller);
    expect(intent.expiresAt).toBeGreaterThan(Date.now());

    // Step 2: "sign" — in production this builds+sends a real SOL transfer
    // to intent.sellerWallet for intent.priceSol via the connected wallet
    // (lib/use-solana-tx.ts); verifySolTransfer is mocked to accept it here,
    // same as every other route test in this repo (that verification logic
    // is exhaustively covered elsewhere against a faked Connection).
    const signature = freshSignature("frontend-buy-listing");

    // Step 3: redemption — through the REAL client module's postJson(),
    // sending intentId (never index).
    const result = await routes.client.postJson<{ ok: boolean; pixel: { owner: string; index: number } }>("/api/pixels", {
      action: "buy-listing",
      actor: buyer,
      intentId: intent.intentId,
      signature,
    });
    expect(result.pixel.owner).toBe(buyer);
    expect(result.pixel.index).toBe(index);

    // Verify against REAL Postgres, not just the response body.
    const base = process.env.SUPABASE_URL!;
    const check = await fetch(`${base}/rest/v1/pixels?index=eq.${index}&select=data`, { headers: headers() });
    const rows = (await check.json()) as { data: { owner: string } }[];
    expect(rows[0].data.owner).toBe(buyer);
  });

  it("expired intent: redemption is REJECTED (410) by the real route, and friendlyIntentError produces a message the UI can show", async () => {
    const routes = await freshRoutes();
    wireFetchToRoutes(routes);
    const seller = freshWallet();
    const buyer = freshWallet();
    const index = freshIndex();
    await seedListedPixel(index, seller, 1);

    // Create a real intent, THEN roll its expiry backward directly in the
    // DATABASE (not just in-process) — this is the literal Phase 4
    // instruction: "Kasıtlı olarak intent'i expire edip (DB'den süreyi
    // geriye alarak)". Proves the server checks Postgres' now() against the
    // real stored row, not some in-memory value.
    const intent = await routes.client.createPurchaseIntent({ actor: buyer, actionType: "buy-listing", index });
    const base = process.env.SUPABASE_URL!;
    const patch = await fetch(`${base}/rest/v1/purchase_intents?id=eq.${intent.intentId}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ expires_at: new Date(Date.now() - 60_000).toISOString() }),
    });
    expect(patch.ok).toBe(true);

    // Redeem through the REAL client module — this is the exact call
    // lib/pixel-store.tsx's buyListing() makes.
    const err: unknown = await routes.client
      .postJson("/api/pixels", { action: "buy-listing", actor: buyer, intentId: intent.intentId, signature: freshSignature("expired") })
      .catch((e) => e);

    expect(err).toBeInstanceOf(routes.client.ApiError);
    expect((err as InstanceType<typeof routes.client.ApiError>).status).toBe(410);

    // This is what the UI actually renders to the user (see
    // components/market.tsx / components/pixel-dialog.tsx / components/
    // start-ads.tsx's catch blocks, all of which call this same function).
    const message = routes.client.friendlyIntentError(err);
    expect(message).toMatch(/expired/i);
    expect(message).not.toMatch(/\[object Object\]/); // never a raw/opaque error leaking to the user

    // And real Postgres confirms nothing changed hands.
    const check = await fetch(`${base}/rest/v1/pixels?index=eq.${index}&select=data`, { headers: headers() });
    const rows = (await check.json()) as { data: { owner: string } }[];
    expect(rows[0].data.owner).toBe(seller);
  });

  it("foreign wallet's intent: redemption is REJECTED (403), mapped to a message that doesn't blame the user's own wallet incorrectly", async () => {
    const routes = await freshRoutes();
    wireFetchToRoutes(routes);
    const seller = freshWallet();
    const rightfulBuyer = freshWallet();
    const attacker = freshWallet();
    const index = freshIndex();
    await seedListedPixel(index, seller, 1);

    const intent = await routes.client.createPurchaseIntent({ actor: rightfulBuyer, actionType: "buy-listing", index });

    const err: unknown = await routes.client
      .postJson("/api/pixels", { action: "buy-listing", actor: attacker, intentId: intent.intentId, signature: freshSignature("foreign") })
      .catch((e) => e);
    expect(err).toBeInstanceOf(routes.client.ApiError);
    expect((err as InstanceType<typeof routes.client.ApiError>).status).toBe(403);
    expect(routes.client.friendlyIntentError(err)).toMatch(/wallet/i);
  });
});
