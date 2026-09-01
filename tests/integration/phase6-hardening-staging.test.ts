// SOL-98 Phase 6 (RED-TEAM HARDENING & SECURITY REMEDIATION) — run against
// the REAL staging Supabase project (never production, red rule #10). NOT
// part of `npm test` — run explicitly:
//
//   SUPABASE_URL=https://<staging-ref>.supabase.co \
//   SUPABASE_SERVICE_ROLE_KEY=<staging-service-role-or-secret-key> \
//   NODE_ENV=production \
//     npx vitest run --config vitest.integration.config.mts tests/integration/phase6-hardening-staging.test.ts
//
// Proves the three schema-level fixes in
// supabase/migrations/0006_hardening_price_lock_documents_intent_expiry.up.sql
// actually hold against real Postgres — not just that the SQL applies
// cleanly, but that the race BULGU 1 describes is genuinely closed:
//
//   RED TEAM — BULGU 1: two concurrent insert_pixels_atomic /
//   insert_board_pixels_atomic calls, both paying exactly the CURRENT
//   price, targeting DIFFERENT indices (so the pre-existing unique-index
//   defense can't be what rejects the second one) — before this phase, BOTH
//   would have succeeded (the RPC never re-checked price). After this
//   phase, only the one that wins the pg_advisory_xact_lock race is priced
//   against the count it actually landed at; the other sees the
//   NOW-higher true price and is cleanly rejected (ok:false,
//   reason:"underpaid") instead of silently underpaying.
//
//   BULGU 2 — insert_document_atomic: happy-path atomicity, plus a RED TEAM
//   ledger-rollback proof mirroring the existing pixel/board ones.
//
//   BULGU 3 — expire_stale_purchase_intents: a manually-expired pending row
//   actually flips to 'expired'; a still-live pending row is untouched.
import { Keypair } from "@solana/web3.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const HAVE_STAGING = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
const d = HAVE_STAGING ? describe : describe.skip;

// Own, dedicated, collision-free index block — 9900-9909 (phase3 owns
// 9990-9999, phase4 owns 9950-9989).
const TEST_INDEX_BASE = 9900;
let nextIndex = TEST_INDEX_BASE;
function freshIndex() {
  if (nextIndex > 9909) throw new Error("phase6 staging test index block (9900-9909) exhausted");
  return nextIndex++;
}
function freshWallet(): string {
  return Keypair.generate().publicKey.toBase58();
}
function freshTag(tag: string) {
  return `phase6test-${tag}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function headers() {
  return {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  };
}

function base() {
  return process.env.SUPABASE_URL!;
}

async function cleanup() {
  await fetch(`${base()}/rest/v1/pixels?index=gte.${TEST_INDEX_BASE}&index=lt.9910`, { method: "DELETE", headers: headers() });
  await fetch(`${base()}/rest/v1/payment_transactions?signature=like.phase6test-*`, { method: "DELETE", headers: headers() });
  await fetch(`${base()}/rest/v1/pixel_ownership_history?pixel_index=gte.${TEST_INDEX_BASE}&pixel_index=lt.9910`, {
    method: "DELETE",
    headers: headers(),
  });
  await fetch(`${base()}/rest/v1/board_files?name=like.Phase6Test*`, { method: "DELETE", headers: headers() });
  await fetch(`${base()}/rest/v1/board_pixels?data->>bannerGroupId=like.phase6test-*`, { method: "DELETE", headers: headers() }).catch(
    () => undefined
  );
  await fetch(`${base()}/rest/v1/documents?id=like.phase6test-*`, { method: "DELETE", headers: headers() });
  await fetch(`${base()}/rest/v1/purchase_intents?buyer_wallet=like.Phase6TestIntent*`, { method: "DELETE", headers: headers() }).catch(
    () => undefined
  );
}

/** Live pixel-board soldCount, read the exact same way pixel-db-supabase.ts's soldCount() does. */
async function livePixelSoldCount(): Promise<number> {
  const res = await fetch(`${base()}/rest/v1/pixels?select=index`, {
    headers: { ...headers(), Prefer: "count=exact", Range: "0-0" },
  });
  const range = res.headers.get("content-range");
  return range ? parseInt(range.split("/")[1] ?? "0", 10) : 0;
}

/** Live board.exe soldCount, mirroring countBoardFiles(). */
async function liveBoardSoldCount(): Promise<number> {
  const res = await fetch(`${base()}/rest/v1/board_files?select=id`, {
    headers: { ...headers(), Prefer: "count=exact", Range: "0-0" },
  });
  const range = res.headers.get("content-range");
  return range ? parseInt(range.split("/")[1] ?? "0", 10) : 0;
}

async function areaPriceMinLamports(soldCount: number, count: number): Promise<number> {
  const res = await fetch(`${base()}/rest/v1/rpc/area_price_min_lamports`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ p_sold_count: soldCount, p_count: count }),
  });
  return Number(await res.json());
}

async function boardFileMinLamports(soldCount: number): Promise<number> {
  const res = await fetch(`${base()}/rest/v1/rpc/next_board_file_min_lamports`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ p_sold_count: soldCount }),
  });
  return Number(await res.json());
}

function pixelPayload(index: number, owner: string) {
  return {
    index,
    owner,
    destination: "",
    imageUrl: "",
    message: "",
    neon: "none",
    valuationSol: 0.2,
    purchasedAt: Date.now(),
    isRented: false,
  };
}

interface InsertPixelsRpcRow {
  ok: boolean;
  reason: string | null;
  taken: number[] | null;
}
interface InsertBoardRpcRow {
  ok: boolean;
  reason: string | null;
}

d("Phase 6 — bonding-curve price race is closed (BULGU 1), against real staging DB", () => {
  beforeAll(cleanup);
  afterAll(cleanup);

  it("RED TEAM — insert_pixels_atomic: two concurrent purchases at the SAME (current) price, DIFFERENT indices — exactly one succeeds, the other is cleanly rejected as underpaid", async () => {
    const soldCount = await livePixelSoldCount();
    const currentPriceLamports = await areaPriceMinLamports(soldCount, 1);
    const walletA = freshWallet();
    const walletB = freshWallet();
    const indexA = freshIndex();
    const indexB = freshIndex();
    const sigA = freshTag("race-a");
    const sigB = freshTag("race-b");

    const call = (index: number, owner: string, signature: string) =>
      fetch(`${base()}/rest/v1/rpc/insert_pixels_atomic`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          p_records: [pixelPayload(index, owner)],
          p_signature: signature,
          p_wallet: owner,
          p_action: "buy",
          p_amount_sol: 0.2,
          p_mint: null,
          // Both racers pay EXACTLY what's required for the CURRENT sold
          // count — i.e. what a stale, racy JS-side price computation
          // would have verified as sufficient for BOTH requests before
          // this phase's fix.
          p_paid_lamports: currentPriceLamports,
        }),
      });

    const [resA, resB] = await Promise.all([call(indexA, walletA, sigA), call(indexB, walletB, sigB)]);
    const [rowsA, rowsB] = await Promise.all([
      resA.json() as Promise<InsertPixelsRpcRow[]>,
      resB.json() as Promise<InsertPixelsRpcRow[]>,
    ]);
    const outcomeA = rowsA[0];
    const outcomeB = rowsB[0];

    const outcomes = [outcomeA, outcomeB];
    const winners = outcomes.filter((o) => o.ok === true);
    const losers = outcomes.filter((o) => o.ok === false);

    // Before Phase 6: both would have been `ok:true` (no price re-check).
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]!.reason).toBe("underpaid");

    // Confirm against the actual table: exactly ONE of the two indices was
    // ever created — the loser's underpayment never became a pixel row.
    const check = await fetch(`${base()}/rest/v1/pixels?index=in.(${indexA},${indexB})&select=index`, { headers: headers() });
    const created = (await check.json()) as { index: number }[];
    expect(created).toHaveLength(1);
  });

  it("RED TEAM — insert_board_pixels_atomic: same race, board.exe files — exactly one succeeds, the other is underpaid", async () => {
    const soldCount = await liveBoardSoldCount();
    const currentPriceLamports = await boardFileMinLamports(soldCount);
    const ownerA = freshWallet();
    const ownerB = freshWallet();
    const fileIdA = `phase6test-board-a-${Date.now()}`;
    const fileIdB = `phase6test-board-b-${Date.now()}`;
    const sigA = freshTag("board-race-a");
    const sigB = freshTag("board-race-b");

    const call = (fileId: string, owner: string, signature: string) =>
      fetch(`${base()}/rest/v1/rpc/insert_board_pixels_atomic`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          p_file_id: fileId,
          p_file_data: { id: fileId, name: "Phase6Test Race Board", owner, purchasedAt: Date.now(), priceSol: 2 },
          p_records: [
            { boardId: fileId, index: 0, owner, destination: "", imageUrl: "", message: "", neon: "none", valuationSol: 0.2, purchasedAt: Date.now(), isRented: false },
          ],
          p_signature: signature,
          p_wallet: owner,
          p_action: "buy-board",
          p_amount_sol: 2,
          p_mint: null,
          p_paid_lamports: currentPriceLamports,
        }),
      });

    const [resA, resB] = await Promise.all([call(fileIdA, ownerA, sigA), call(fileIdB, ownerB, sigB)]);
    const [rowsA, rowsB] = await Promise.all([
      resA.json() as Promise<InsertBoardRpcRow[]>,
      resB.json() as Promise<InsertBoardRpcRow[]>,
    ]);
    const outcomes = [rowsA[0], rowsB[0]];
    const winners = outcomes.filter((o) => o.ok === true);
    const losers = outcomes.filter((o) => o.ok === false);

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]!.reason).toBe("underpaid");

    const check = await fetch(`${base()}/rest/v1/board_files?id=in.(${fileIdA},${fileIdB})&select=id`, { headers: headers() });
    expect(((await check.json()) as unknown[])).toHaveLength(1);
  });
});

d("Phase 6 — documents purchases are now atomic (BULGU 2), against real staging DB", () => {
  beforeAll(cleanup);
  afterAll(cleanup);

  it("insert_document_atomic: document row + payment ledger row land together via ONE call", async () => {
    const owner = freshWallet();
    const signature = freshTag("doc-happy");
    const docId = freshTag("doc-id");

    const res = await fetch(`${base()}/rest/v1/rpc/insert_document_atomic`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        p_doc: { id: docId, name: "Phase6 Test Doc", content: "hello", owner, purchasedAt: Date.now() },
        p_signature: signature,
        p_wallet: owner,
        p_action: "buy-document",
        p_amount_sol: 0.2,
      }),
    });
    expect(res.ok).toBe(true);
    const rows = (await res.json()) as { ok: boolean; reason: string | null; doc: { owner: string } | null }[];
    expect(rows[0]!.ok).toBe(true);
    expect(rows[0]!.doc!.owner).toBe(owner);

    const docCheck = await fetch(`${base()}/rest/v1/documents?id=eq.${encodeURIComponent(docId)}`, { headers: headers() });
    expect(((await docCheck.json()) as unknown[])).toHaveLength(1);

    const ledgerCheck = await fetch(`${base()}/rest/v1/payment_transactions?signature=eq.${signature}`, { headers: headers() });
    const ledgerRows = (await ledgerCheck.json()) as { wallet: string; action: string }[];
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0]!.action).toBe("buy-document");
  });

  it("RED TEAM — insert_document_atomic: a payment_transactions UNIQUE(signature) violation rolls back the document INSERT from the SAME call", async () => {
    const owner = freshWallet();
    const signature = freshTag("doc-rollback");
    const docId = freshTag("doc-id-rollback");

    const preInsert = await fetch(`${base()}/rest/v1/payment_transactions`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ signature, wallet: "pre-existing-unrelated-wallet", action: "buy-document", amount_sol: 0.2 }),
    });
    expect([201, 204]).toContain(preInsert.status);

    const rpcRes = await fetch(`${base()}/rest/v1/rpc/insert_document_atomic`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        p_doc: { id: docId, name: "Phase6 Rollback Doc", content: "should not survive", owner, purchasedAt: Date.now() },
        p_signature: signature,
        p_wallet: owner,
        p_action: "buy-document",
        p_amount_sol: 0.2,
      }),
    });
    expect(rpcRes.ok).toBe(false); // unique_violation propagates as a thrown error, same contract as pixels/boards

    const docCheck = await fetch(`${base()}/rest/v1/documents?id=eq.${encodeURIComponent(docId)}`, { headers: headers() });
    expect(((await docCheck.json()) as unknown[])).toHaveLength(0); // rolled back, not left half-created

    const ledgerCheck = await fetch(`${base()}/rest/v1/payment_transactions?signature=eq.${signature}`, { headers: headers() });
    const ledgerRows = (await ledgerCheck.json()) as { wallet: string }[];
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0]!.wallet).toBe("pre-existing-unrelated-wallet"); // still the ORIGINAL row, no duplicate
  });
});

d("Phase 6 — stale purchase intents actually expire (BULGU 3), against real staging DB", () => {
  afterAll(async () => {
    await fetch(`${base()}/rest/v1/purchase_intents?buyer_wallet=like.Phase6TestIntent*`, { method: "DELETE", headers: headers() });
  });

  it("expire_stale_purchase_intents flips a past-due pending intent to 'expired', and leaves a still-live one alone", async () => {
    const staleBuyer = `Phase6TestIntentStale-${Date.now()}`;
    const liveBuyer = `Phase6TestIntentLive-${Date.now()}`;

    const seed = (buyer: string, expiresAt: Date) =>
      fetch(`${base()}/rest/v1/purchase_intents`, {
        method: "POST",
        headers: { ...headers(), Prefer: "return=representation" },
        body: JSON.stringify({
          action_type: "buy-listing",
          board_id: null,
          pixel_index: 1,
          buyer_wallet: buyer,
          seller_wallet: "SomeSellerWalletXYZ",
          currency: "SOL",
          price_sol: 1,
          status: "pending",
          expires_at: expiresAt.toISOString(),
        }),
      });

    const staleRes = await seed(staleBuyer, new Date(Date.now() - 60 * 60 * 1000)); // 1 hour in the past
    const liveRes = await seed(liveBuyer, new Date(Date.now() + 60 * 60 * 1000)); // 1 hour in the future
    expect(staleRes.status).toBe(201);
    expect(liveRes.status).toBe(201);
    const [staleRow] = (await staleRes.json()) as { id: string }[];
    const [liveRow] = (await liveRes.json()) as { id: string }[];

    const sweepRes = await fetch(`${base()}/rest/v1/rpc/expire_stale_purchase_intents`, {
      method: "POST",
      headers: headers(),
      body: "{}",
    });
    expect(sweepRes.ok).toBe(true);
    const sweptCount = (await sweepRes.json()) as number;
    expect(sweptCount).toBeGreaterThanOrEqual(1); // at least ours — other stale rows may legitimately exist too

    const staleCheck = await fetch(`${base()}/rest/v1/purchase_intents?id=eq.${staleRow!.id}&select=status`, { headers: headers() });
    expect(((await staleCheck.json()) as { status: string }[])[0]!.status).toBe("expired");

    const liveCheck = await fetch(`${base()}/rest/v1/purchase_intents?id=eq.${liveRow!.id}&select=status`, { headers: headers() });
    expect(((await liveCheck.json()) as { status: string }[])[0]!.status).toBe("pending"); // untouched — not yet due
  });
});
