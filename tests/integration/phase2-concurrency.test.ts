// SOL-98 Phase 2 — red-team §7 concurrency re-verification against the REAL
// staging database (same staging project Phase 1 used — never production,
// red rule #10). NOT part of `npm test` (see vitest.config.mts's include
// glob, which only picks up tests/*.test.ts) — run explicitly:
//
//   SUPABASE_URL=https://<staging-ref>.supabase.co \
//   SUPABASE_SERVICE_ROLE_KEY=<staging-service-role-or-secret-key> \
//   NODE_ENV=production \
//     npx vitest run tests/integration/phase2-concurrency.test.ts
//
// Phase 1's tests/integration/phase1-staging.test.ts already proved 2-way
// and 8-way races are safe at the DB layer (#9, #9b, #15). This file targets
// the SPECIFIC scenarios the Phase 2 brief calls out by name:
//   - A×2, B×2, C×4 simultaneous purchases of the SAME brand-new pixel
//   - Purchase+Purchase / Purchase+Sell / Purchase+Hijack cross-action races
//   - Whether hijackPixel's atomicity (currently exercised only by the FREE
//     simulated path, since $PIXEL98 isn't live) would hold once real
//     token-gated hijacks are turned on — the DB primitive is identical
//     either way, so this is a direct, evidenced answer to that question.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const HAVE_STAGING = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
const d = HAVE_STAGING ? describe : describe.skip;

const TEST_INDEX_BASE = 8_100_000; // disjoint range from phase1-staging.test.ts's 8_000_000 block
let nextIndex = TEST_INDEX_BASE;
function freshIndex() {
  return nextIndex++;
}
function freshWallet(tag: string) {
  return `Phase2Test${tag}${"1".repeat(Math.max(0, 30 - tag.length))}`;
}
function freshSignature(tag: string) {
  return `phase2test-sig-${tag}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function samplePixel(index: number, owner: string) {
  return {
    index,
    owner,
    destination: "",
    imageUrl: "",
    message: "",
    neon: "none" as const,
    valuationSol: 0.2,
    purchasedAt: Date.now(),
    isRented: false,
  };
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
  await fetch(`${base}/rest/v1/used_signatures?signature=like.phase2test-*`, { method: "DELETE", headers: headers() });
  await fetch(`${base}/rest/v1/payment_transactions?signature=like.phase2test-*`, { method: "DELETE", headers: headers() });
  await fetch(`${base}/rest/v1/pixel_ownership_history?pixel_index=gte.${TEST_INDEX_BASE}`, { method: "DELETE", headers: headers() });
}

async function raceCreate(index: number, n: number, tag: string) {
  const { createPixels } = await import("../../lib/server/pixel-db");
  const contenders = Array.from({ length: n }, (_, i) => freshWallet(`${tag}${i}`));
  const results = await Promise.all(contenders.map((owner) => createPixels([samplePixel(index, owner)])));
  return { contenders, results };
}

d("Phase 2 — concurrency re-verification against real staging DB (§7)", () => {
  beforeAll(async () => {
    await cleanup();
  });
  afterAll(async () => {
    await cleanup();
  });

  it("A×2: two buyers racing ONE brand-new pixel — exactly one owner, ever", async () => {
    const { getPixel } = await import("../../lib/server/pixel-db");
    const index = freshIndex();
    const { contenders, results } = await raceCreate(index, 2, "a2-");
    const winners = results.filter((r) => r.ok);
    expect(winners.length).toBe(1);
    const stored = await getPixel(index);
    expect(contenders).toContain(stored?.owner);
  });

  it("B×2 (repeat run, different index — rules out a fluke on the first race)", async () => {
    const { getPixel } = await import("../../lib/server/pixel-db");
    const index = freshIndex();
    const { contenders, results } = await raceCreate(index, 2, "b2-");
    const winners = results.filter((r) => r.ok);
    expect(winners.length).toBe(1);
    const stored = await getPixel(index);
    expect(contenders).toContain(stored?.owner);
  });

  it("C×4: FOUR buyers racing ONE brand-new pixel simultaneously — still exactly one owner", async () => {
    const { getPixel } = await import("../../lib/server/pixel-db");
    const index = freshIndex();
    const { contenders, results } = await raceCreate(index, 4, "c4-");
    const winners = results.filter((r) => r.ok);
    const losers = results.filter((r) => !r.ok);
    expect(winners.length).toBe(1);
    expect(losers.length).toBe(3);
    const stored = await getPixel(index);
    expect(contenders).toContain(stored?.owner);
    // every loser's response must correctly report the index as taken
    for (const loser of losers) {
      if (!loser.ok) expect(loser.taken).toContain(index);
    }
  });

  it("Purchase+Purchase: repeat C×4 at a HIGHER concurrency (8) to push harder on the same invariant", async () => {
    const { getPixel } = await import("../../lib/server/pixel-db");
    const index = freshIndex();
    const { contenders, results } = await raceCreate(index, 8, "pp8-");
    const winners = results.filter((r) => r.ok);
    expect(winners.length).toBe(1);
    const stored = await getPixel(index);
    expect(contenders).toContain(stored?.owner);
  });

  it("Purchase+Sell race: TWO buyers racing to buy the SAME listed (already-owned) pixel via updateOwnedPixel — exactly one buyer wins", async () => {
    const { createPixels, updateOwnedPixel, getPixel } = await import("../../lib/server/pixel-db");
    const index = freshIndex();
    const seller = freshWallet("sellerPS");
    await createPixels([{ ...samplePixel(index, seller), listingPriceSol: 2 }]);

    const buyerA = freshWallet("psBuyerA");
    const buyerB = freshWallet("psBuyerB");
    const buy = (buyer: string) =>
      updateOwnedPixel(index, seller, (current) => ({
        ...current,
        owner: buyer,
        listingPriceSol: undefined,
        purchasedAt: Date.now(),
      }));
    const [resA, resB] = await Promise.all([buy(buyerA), buy(buyerB)]);
    const winners = [resA, resB].filter((r) => r.ok);
    expect(winners.length).toBe(1); // the second's WHERE owner=seller no longer matches once the first commits
    const stored = await getPixel(index);
    expect([buyerA, buyerB]).toContain(stored?.owner);
    // the loser must NOT silently succeed with stale data — it reports a conflict
    const loser = [resA, resB].find((r) => !r.ok);
    expect(loser).toBeDefined();
  });

  it("Purchase+Hijack race: a listed pixel being bought (updateOwnedPixel) AND hijacked (hijackPixel) at the same instant — DB stays consistent, exactly one mutation wins", async () => {
    // This is the direct evidence for whether hijackPixel's atomicity would
    // hold once $PIXEL98 goes live and real (non-simulated) hijacks start
    // calling this SAME primitive (see app/api/pixels/route.ts handleHijack:
    // both the simulated and the future real-burn path call the identical
    // `hijackPixel(index, mutate)` from lib/server/pixel-db.ts). The payment
    // verification step differs (free+auth-proof today vs a verified burn
    // tomorrow), but the DB race protection being tested here does not
    // change at all between those two modes.
    const { createPixels, updateOwnedPixel, hijackPixel, getPixel } = await import("../../lib/server/pixel-db");
    const index = freshIndex();
    const owner = freshWallet("phOwner");
    await createPixels([{ ...samplePixel(index, owner), listingPriceSol: 1 }]);

    const buyer = freshWallet("phBuyer");
    const hijacker = freshWallet("phHijacker");
    const [buyResult, hijackResult] = await Promise.all([
      updateOwnedPixel(index, owner, (current) => ({ ...current, owner: buyer, listingPriceSol: undefined })),
      hijackPixel(index, (current) => ({ ...current, owner: hijacker })),
    ]);

    const stored = await getPixel(index);
    // Whichever of the two conditional PATCHes committed first wins; the
    // other's WHERE clause (data->>owner=eq.<owner-it-read>) then fails to
    // match and it reports a conflict. There is no possible outcome where
    // BOTH win, and no possible outcome where the stored owner is anything
    // other than one of the two contenders.
    const winners = [buyResult, hijackResult].filter((r) => r.ok);
    // Empirically pinned down by running this exact race 10 times against
    // real staging Postgres before fixing this assertion: winners.length
    // was 1 in all 10 runs (sometimes the buy won, sometimes the hijack —
    // order is not deterministic, but a double-win never occurred). Both
    // updateOwnedPixel and hijackPixel issue their conditional PATCH keyed
    // off the SAME pre-race owner, but Postgres's row-level locking means
    // the second UPDATE to reach the row blocks until the first commits,
    // then re-evaluates its WHERE against the now-changed row and matches
    // zero rows — there is no window for both to "win". See
    // PHASE-2-PAYMENT-SECURITY.md finding on Purchase+Hijack races.
    expect(winners.length).toBe(1);
    expect([buyer, hijacker]).toContain(stored?.owner);
  });

  it("invariant §13: a batch createPixels (buy-area) that partially conflicts creates ZERO rows — no partial ownership, against the real Postgres insert", async () => {
    const { createPixels, getPixel } = await import("../../lib/server/pixel-db");
    const takenIndex = freshIndex();
    const freeIndex1 = freshIndex();
    const freeIndex2 = freshIndex();
    const originalOwner = freshWallet("partialOrig");
    await createPixels([samplePixel(takenIndex, originalOwner)]);

    const attacker = freshWallet("partialAttacker");
    const batch = await createPixels([
      samplePixel(freeIndex1, attacker),
      samplePixel(takenIndex, attacker), // conflicts
      samplePixel(freeIndex2, attacker),
    ]);
    expect(batch.ok).toBe(false);

    // The two indices that were NOT conflicting must still be completely
    // unowned — a partial insert would show them created for `attacker`.
    expect(await getPixel(freeIndex1)).toBeUndefined();
    expect(await getPixel(freeIndex2)).toBeUndefined();
    // And the conflicting one is untouched (still the original owner).
    expect((await getPixel(takenIndex))?.owner).toBe(originalOwner);
  });
});
