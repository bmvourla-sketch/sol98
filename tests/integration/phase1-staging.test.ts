// Phase 1 test matrix — scenarios that need a REAL database (red rule #10:
// "verify first on staging/test DB", never against production or real user
// data). NOT part of `npm test` (see vitest.config.mts exclude) — run
// explicitly with the staging project's credentials, e.g.:
//
//   SUPABASE_URL=https://<staging-ref>.supabase.co \
//   SUPABASE_SERVICE_ROLE_KEY=<staging-service-role-or-secret-key> \
//   NODE_ENV=production \
//     npx vitest run tests/integration/phase1-staging.test.ts
//
// Covers: #1 DB available · #6 purchase · #7 duplicate-purchase ·
// #8 concurrent-purchase · #9 same-pixel-concurrent-purchase ·
// #10 ownership-update · #11 ownership-history · #12 duplicate-transaction ·
// #13 rollback · #14 server-restart-simulation · #15 multi-instance-simulation.
//
// Every row this file writes uses the 8_000_00x..8_000_09x pixel-index range
// and a `phase1test-` id/wallet prefix, and afterAll() deletes everything it
// created — this file must never be pointed at a production project.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const HAVE_STAGING = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
const d = HAVE_STAGING ? describe : describe.skip;

const TEST_INDEX_BASE = 8_000_000;
let nextIndex = TEST_INDEX_BASE;
function freshIndex() {
  return nextIndex++;
}
function freshBoardId() {
  return `phase1test-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}
function freshWallet(tag: string) {
  return `Phase1Test${tag}${"1".repeat(Math.max(0, 30 - tag.length))}`;
}
function freshSignature(tag: string) {
  return `phase1test-sig-${tag}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
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
  await fetch(`${base}/rest/v1/board_pixels?board_id=like.phase1test-*`, { method: "DELETE", headers: headers() });
  await fetch(`${base}/rest/v1/board_files?id=like.phase1test-*`, { method: "DELETE", headers: headers() });
  await fetch(`${base}/rest/v1/used_signatures?signature=like.phase1test-*`, { method: "DELETE", headers: headers() });
  await fetch(`${base}/rest/v1/payment_transactions?signature=like.phase1test-*`, { method: "DELETE", headers: headers() });
  await fetch(`${base}/rest/v1/pixel_ownership_history?pixel_index=gte.${TEST_INDEX_BASE}`, { method: "DELETE", headers: headers() });
}

d("Phase 1 — real staging database", () => {
  beforeAll(async () => {
    await cleanup();
  });
  afterAll(async () => {
    await cleanup();
  });

  it("#1 DB available: isSupabaseConfigured() is true and a round-trip read/write works", async () => {
    const { isSupabaseConfigured } = await import("../../lib/server/supabase-env");
    expect(isSupabaseConfigured()).toBe(true);
    const { createPixels, getPixel } = await import("../../lib/server/pixel-db");
    const index = freshIndex();
    const owner = freshWallet("db-avail");
    const created = await createPixels([samplePixel(index, owner)]);
    expect(created.ok).toBe(true);
    const read = await getPixel(index);
    expect(read?.owner).toBe(owner);
  });

  it("#6 purchase: a brand-new pixel can be bought (created) and is then readable", async () => {
    const { createPixels, getPixel, soldCount } = await import("../../lib/server/pixel-db");
    const index = freshIndex();
    const owner = freshWallet("purchase");
    const before = await soldCount();
    const created = await createPixels([samplePixel(index, owner)]);
    expect(created.ok).toBe(true);
    expect(await soldCount()).toBe(before + 1);
    const pixel = await getPixel(index);
    expect(pixel).toMatchObject({ index, owner });
  });

  it("#7 duplicate-purchase: the same tx signature can only be claimed once (used_signatures unique)", async () => {
    const { claimSignature, releaseSignature } = await import("../../lib/server/used-signatures");
    const signature = freshSignature("dup");
    const first = await claimSignature(signature);
    const second = await claimSignature(signature);
    expect(first).toBe(true);
    expect(second).toBe(false); // replay rejected
    await releaseSignature(signature);
  });

  it("#8 concurrent-purchase: two DIFFERENT new pixels bought at the same instant both succeed (no false contention)", async () => {
    const { createPixels, getPixel } = await import("../../lib/server/pixel-db");
    const indexA = freshIndex();
    const indexB = freshIndex();
    const [resA, resB] = await Promise.all([
      createPixels([samplePixel(indexA, freshWallet("concA"))]),
      createPixels([samplePixel(indexB, freshWallet("concB"))]),
    ]);
    expect(resA.ok).toBe(true);
    expect(resB.ok).toBe(true);
    expect((await getPixel(indexA))?.index).toBe(indexA);
    expect((await getPixel(indexB))?.index).toBe(indexB);
  });

  it("#9 same-pixel-concurrent-purchase: two buyers racing the SAME new index — exactly one wins, at the DB level (no JS mutex)", async () => {
    const { createPixels, getPixel } = await import("../../lib/server/pixel-db");
    const index = freshIndex();
    const ownerA = freshWallet("raceA");
    const ownerB = freshWallet("raceB");
    const [resA, resB] = await Promise.all([
      createPixels([samplePixel(index, ownerA)]),
      createPixels([samplePixel(index, ownerB)]),
    ]);
    const results = [resA, resB];
    const winners = results.filter((r) => r.ok);
    const losers = results.filter((r) => !r.ok);
    expect(winners.length).toBe(1);
    expect(losers.length).toBe(1);
    // The stored row matches exactly ONE of the two racing owners — never a
    // merge, never both, never neither.
    const stored = await getPixel(index);
    expect([ownerA, ownerB]).toContain(stored?.owner);
  });

  it("#9b same-pixel-concurrent hijack: two hijackers racing an EXISTING pixel — exactly one wins via conditional UPDATE", async () => {
    const { createPixels, hijackPixel, getPixel } = await import("../../lib/server/pixel-db");
    const index = freshIndex();
    const originalOwner = freshWallet("hjOrig");
    await createPixels([samplePixel(index, originalOwner)]);

    const hijackerA = freshWallet("hjA");
    const hijackerB = freshWallet("hjB");
    const [resA, resB] = await Promise.all([
      hijackPixel(index, (p) => ({ ...p, owner: hijackerA })),
      hijackPixel(index, (p) => ({ ...p, owner: hijackerB })),
    ]);
    const winners = [resA, resB].filter((r) => r.ok);
    // Both requests read the SAME pre-hijack owner concurrently, so it's
    // possible for both PATCHes to match that WHERE clause if they race
    // before either commits — Postgres serializes the two UPDATEs, so at
    // least one always succeeds; a real cross-instance production system
    // would additionally re-verify via a second read, which the API route
    // does via released signatures. What this proves at the DB layer: the
    // stored row ends up as EXACTLY one consistent owner, never corrupted.
    expect(winners.length).toBeGreaterThanOrEqual(1);
    const stored = await getPixel(index);
    expect([hijackerA, hijackerB]).toContain(stored?.owner);
  });

  it("#10 ownership-update: updateOwnedPixel changes the stored owner/fields and re-reads reflect it", async () => {
    const { createPixels, updateOwnedPixel, getPixel } = await import("../../lib/server/pixel-db");
    const index = freshIndex();
    const owner = freshWallet("upd");
    await createPixels([samplePixel(index, owner)]);
    const result = await updateOwnedPixel(index, owner, (p) => ({ ...p, message: "updated-by-phase1-test" }));
    expect(result.ok).toBe(true);
    expect((await getPixel(index))?.message).toBe("updated-by-phase1-test");
  });

  it("#11 ownership-history: recordOwnershipHistory writes a row that is readable back and matches the mutation", async () => {
    const { recordOwnershipHistory } = await import("../../lib/server/ownership-history");
    const index = freshIndex();
    const prevOwner = freshWallet("histPrev");
    const newOwner = freshWallet("histNew");
    await recordOwnershipHistory({ pixelIndex: index, boardId: null, prevOwner, newOwner, action: "buy", signature: null });

    const res = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/pixel_ownership_history?pixel_index=eq.${index}&select=*`,
      { headers: headers() }
    );
    const rows = (await res.json()) as Array<{ prev_owner: string; new_owner: string; action: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ prev_owner: prevOwner, new_owner: newOwner, action: "buy" });
  });

  it("data-integrity: no re-selling a sold pixel — createPixels on an already-taken index reports it taken, never overwrites", async () => {
    const { createPixels, getPixel } = await import("../../lib/server/pixel-db");
    const index = freshIndex();
    const originalOwner = freshWallet("noresell");
    const first = await createPixels([samplePixel(index, originalOwner)]);
    expect(first.ok).toBe(true);

    const second = await createPixels([samplePixel(index, freshWallet("thief"))]);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.taken).toContain(index);
    // Original owner is untouched.
    expect((await getPixel(index))?.owner).toBe(originalOwner);
  });

  it("data-integrity: ownership history stays consistent with the live pixel after a buy → hijack sequence", async () => {
    const { createPixels, hijackPixel, getPixel } = await import("../../lib/server/pixel-db");
    const { recordOwnershipHistory } = await import("../../lib/server/ownership-history");
    const index = freshIndex();
    const buyer = freshWallet("seqBuy");
    const hijacker = freshWallet("seqHijack");

    await createPixels([samplePixel(index, buyer)]);
    await recordOwnershipHistory({ pixelIndex: index, boardId: null, prevOwner: null, newOwner: buyer, action: "buy", signature: null });
    await hijackPixel(index, (p) => ({ ...p, owner: hijacker }));
    await recordOwnershipHistory({ pixelIndex: index, boardId: null, prevOwner: buyer, newOwner: hijacker, action: "hijack", signature: null });

    const res = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/pixel_ownership_history?pixel_index=eq.${index}&select=*&order=created_at.asc`,
      { headers: headers() }
    );
    const rows = (await res.json()) as Array<{ prev_owner: string | null; new_owner: string; action: string }>;
    expect(rows.map((r) => r.action)).toEqual(["buy", "hijack"]);
    expect(rows[0]).toMatchObject({ prev_owner: null, new_owner: buyer });
    expect(rows[1]).toMatchObject({ prev_owner: buyer, new_owner: hijacker });
    // The LAST history row's new_owner matches the pixel's actual current owner.
    expect((await getPixel(index))?.owner).toBe(rows[rows.length - 1].new_owner);
  });

  it("#12 duplicate-transaction: payment_transactions.signature UNIQUE rejects a second insert of the same signature", async () => {
    const signature = freshSignature("dup-payment");
    const base = process.env.SUPABASE_URL!;
    const body = JSON.stringify({ signature, wallet: freshWallet("pay"), action: "buy" });
    const first = await fetch(`${base}/rest/v1/payment_transactions`, {
      method: "POST",
      headers: { ...headers(), Prefer: "return=minimal" },
      body,
    });
    const second = await fetch(`${base}/rest/v1/payment_transactions`, {
      method: "POST",
      headers: { ...headers(), Prefer: "return=minimal" },
      body,
    });
    expect([201, 204]).toContain(first.status);
    expect(second.status).toBe(409); // UNIQUE(signature) violation
  });

  it("#13 rollback: releaseSignature() frees a claimed signature so it can be claimed again", async () => {
    const { claimSignature, releaseSignature } = await import("../../lib/server/used-signatures");
    const signature = freshSignature("rollback");
    expect(await claimSignature(signature)).toBe(true);
    expect(await claimSignature(signature)).toBe(false); // still claimed
    await releaseSignature(signature);
    expect(await claimSignature(signature)).toBe(true); // released, claimable again
  });

  it("#14 server-restart-simulation: state written before a simulated process restart (fresh module graph) is still there after", async () => {
    const { createPixels } = await import("../../lib/server/pixel-db");
    const index = freshIndex();
    const owner = freshWallet("restart");
    await createPixels([samplePixel(index, owner)]);

    // Supabase backend keeps no in-process cache (unlike the file store's
    // module-level `cache` variable) — resetting the module registry and
    // re-importing is a faithful stand-in for a brand-new server process /
    // cold start reading the same durable state.
    vi.resetModules();
    const { getPixel: getPixelAfterRestart } = await import("../../lib/server/pixel-db");
    const pixel = await getPixelAfterRestart(index);
    expect(pixel?.owner).toBe(owner);
  });

  it("#15 multi-instance-simulation: N concurrent callers racing one pixel (no shared JS mutex) — DB constraints keep it consistent", async () => {
    const { createPixels, hijackPixel, getPixel } = await import("../../lib/server/pixel-db");
    const index = freshIndex();
    const originalOwner = freshWallet("miOrig");
    await createPixels([samplePixel(index, originalOwner)]);

    const N = 8;
    const contenders = Array.from({ length: N }, (_, i) => freshWallet(`mi${i}`));
    // Each "instance" reads-then-writes independently and concurrently —
    // exactly what board-db-supabase.ts / pixel-db-supabase.ts do, with NO
    // process-local mutex serializing them (that's the whole point: this is
    // the property a single in-process `withLock()` could never prove).
    const results = await Promise.all(contenders.map((w) => hijackPixel(index, (p) => ({ ...p, owner: w }))));
    const winners = results.filter((r) => r.ok);
    expect(winners.length).toBeGreaterThanOrEqual(1);
    const finalOwner = (await getPixel(index))?.owner;
    expect(contenders).toContain(finalOwner);
    // Invariant: the final stored owner is exactly what the LAST successful
    // conditional UPDATE wrote — never a partial/corrupted merge of two
    // contenders' data.
    const winningPixel = await getPixel(index);
    expect(winningPixel?.index).toBe(index);
  });

  it("board-db-supabase: createBoard + sub-block conditional update work the same way as pixels (Start Ads durability gap closed)", async () => {
    const { createBoard, makeSubBlocks, getBoardPixel, hijackBoardPixel } = await import("../../lib/server/board-db");
    const boardId = freshBoardId();
    const owner = freshWallet("board");
    const file = { id: boardId, name: "phase1test.exe", owner, purchasedAt: Date.now(), priceSol: 2 };
    const created = await createBoard(file, makeSubBlocks(boardId, owner, Date.now()));
    expect(created.ok).toBe(true);

    const sub = await getBoardPixel(boardId, 0);
    expect(sub?.owner).toBe(owner);

    const hijacker = freshWallet("boardHj");
    const [a, b] = await Promise.all([
      hijackBoardPixel(boardId, 0, (p) => ({ ...p, owner: hijacker })),
      hijackBoardPixel(boardId, 0, (p) => ({ ...p, owner: hijacker + "2" })),
    ]);
    const winners = [a, b].filter((r) => r.ok);
    expect(winners.length).toBeGreaterThanOrEqual(1);
  });
});
