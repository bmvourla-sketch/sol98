// SOL-98 Phase 4 (TREASURY ATOMICITY) — GÖREV 2, run against the REAL
// staging Supabase project (never production, red rule #10). NOT part of
// `npm test` — run explicitly:
//
//   SUPABASE_URL=https://<staging-ref>.supabase.co \
//   SUPABASE_SERVICE_ROLE_KEY=<staging-service-role-or-secret-key> \
//   NODE_ENV=production \
//     npx vitest run --config vitest.integration.config.mts tests/integration/phase4-treasury-atomicity-staging.test.ts
//
// Covers the Phase 4 test requirement (verbatim):
//   [ ] UI üzerinden Hazine alımı (buy-area) ve DB'de ownership + ledger'ın
//       aynı anda hatasız oluşması. ("...and ownership + ledger being
//       created at the same time without error")
// plus the RED TEAM extension of Phase 3's atomicity proof to the
// INSERT-based treasury paths this phase's insert_pixels_atomic /
// insert_board_pixels_atomic RPCs cover (buy / buy-area / buy-board) —
// mirroring tests/integration/phase3-market-security-staging.test.ts's
// RED TEAM #4 exactly, but for INSERT instead of UPDATE.
import { Keypair } from "@solana/web3.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const HAVE_STAGING = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
const d = HAVE_STAGING ? describe : describe.skip;

// Same reasoning as phase3-market-security-staging.test.ts: this file
// exercises the REAL HTTP routes (isValidIndex caps the main board at
// TOTAL_SPOTS=10,000), so it needs an in-range, dedicated, collision-free
// index block. 9950-9989 is used here (9990-9999 is Phase 3's own block).
const TEST_INDEX_BASE = 9950;
let nextIndex = TEST_INDEX_BASE;
function freshIndex() {
  if (nextIndex > 9989) throw new Error("phase4 staging test index block (9950-9989) exhausted");
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
  await fetch(`${base}/rest/v1/pixels?index=gte.${TEST_INDEX_BASE}&index=lt.9990`, { method: "DELETE", headers: headers() });
  await fetch(`${base}/rest/v1/used_signatures?signature=like.phase4test-*`, { method: "DELETE", headers: headers() });
  await fetch(`${base}/rest/v1/payment_transactions?signature=like.phase4test-*`, { method: "DELETE", headers: headers() });
  await fetch(`${base}/rest/v1/pixel_ownership_history?pixel_index=gte.${TEST_INDEX_BASE}&pixel_index=lt.9990`, {
    method: "DELETE",
    headers: headers(),
  });
  await fetch(`${base}/rest/v1/board_pixels?data->>bannerGroupId=like.phase4test-*`, { method: "DELETE", headers: headers() }).catch(
    () => undefined
  );
  await fetch(`${base}/rest/v1/board_files?name=like.Phase4Test*`, { method: "DELETE", headers: headers() });
}

const verifySolTransferMock = vi.fn();
const getBurnedFractionMock = vi.fn();

vi.mock("@/lib/server/verify-tx", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/server/verify-tx")>();
  return {
    ...actual,
    verifySolTransfer: (...args: unknown[]) => verifySolTransferMock(...args),
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
  getBurnedFractionMock.mockReset().mockResolvedValue(0);

  const pixels = await import("../../app/api/pixels/route");
  const boards = await import("../../app/api/boards/route");
  return { pixels, boards };
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

const blankAd = { destination: "", imageUrl: "", message: "", neon: "none" };

d("Phase 4 — treasury purchase atomicity, against real staging DB", () => {
  beforeAll(async () => {
    await cleanup();
  });
  afterAll(async () => {
    await cleanup();
  });

  it("buy-area: ownership rows AND the payment ledger AND ownership history all land together, in real Postgres, via ONE HTTP call", async () => {
    const { pixels } = await freshRoutes();
    const buyer = freshWallet();
    const indexA = freshIndex();
    const indexB = freshIndex(); // adjacent, forms a valid 1x2 (or 2x1) rectangle if same row — use computeBannerLayout-friendly pair
    // 9950/9951 are adjacent on the same 100-wide row, a valid 1x2 rectangle.
    const signature = freshSignature("buy-area-happy");

    const res = await pixels.POST(
      postPixels({ action: "buy-area", actor: buyer, indices: [indexA, indexB], signature, ad: blankAd })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pixels).toHaveLength(2);

    const base = process.env.SUPABASE_URL!;

    // Ownership: both pixel rows exist, owned by the buyer.
    const pixelsCheck = await fetch(`${base}/rest/v1/pixels?index=in.(${indexA},${indexB})&select=data`, { headers: headers() });
    const pixelRows = (await pixelsCheck.json()) as { data: { owner: string } }[];
    expect(pixelRows).toHaveLength(2);
    expect(pixelRows.every((r) => r.data.owner === buyer)).toBe(true);

    // Ledger: exactly one payment_transactions row for this signature.
    const ledgerCheck = await fetch(`${base}/rest/v1/payment_transactions?signature=eq.${signature}`, { headers: headers() });
    const ledgerRows = (await ledgerCheck.json()) as { wallet: string; action: string }[];
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0].wallet).toBe(buyer);
    expect(ledgerRows[0].action).toBe("buy-area");

    // History: one row PER pixel, same signature, same call.
    const historyCheck = await fetch(
      `${base}/rest/v1/pixel_ownership_history?pixel_index=in.(${indexA},${indexB})&signature=eq.${signature}`,
      { headers: headers() }
    );
    const historyRows = (await historyCheck.json()) as { new_owner: string; action: string }[];
    expect(historyRows).toHaveLength(2);
    expect(historyRows.every((r) => r.new_owner === buyer && r.action === "buy-area")).toBe(true);
  });

  it("buy: a genuine already-taken conflict is reported cleanly (409) — no ledger row, no history row, existing owner untouched", async () => {
    const { pixels } = await freshRoutes();
    const firstOwner = freshWallet();
    const attacker = freshWallet();
    const index = freshIndex();

    const first = await pixels.POST(postPixels({ action: "buy", actor: firstOwner, index, signature: freshSignature("conflict-1"), ad: blankAd }));
    expect(first.status).toBe(200);

    const second = await pixels.POST(postPixels({ action: "buy", actor: attacker, index, signature: freshSignature("conflict-2"), ad: blankAd }));
    expect(second.status).toBe(409);

    const base = process.env.SUPABASE_URL!;
    const check = await fetch(`${base}/rest/v1/pixels?index=eq.${index}&select=data`, { headers: headers() });
    const rows = (await check.json()) as { data: { owner: string } }[];
    expect(rows[0].data.owner).toBe(firstOwner);
  });

  it("RED TEAM — insert_pixels_atomic: a payment_transactions UNIQUE(signature) violation rolls back the pixel INSERT from the SAME call", async () => {
    const base = process.env.SUPABASE_URL!;
    const index = freshIndex();
    const wallet = freshWallet();
    const signature = freshSignature("insert-atomicity");

    // Pre-insert a payment_transactions row using the EXACT signature the
    // RPC call below will also try to insert.
    const preInsert = await fetch(`${base}/rest/v1/payment_transactions`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ signature, wallet: "pre-existing-unrelated-wallet", action: "buy", amount_sol: 0.2 }),
    });
    expect([201, 204]).toContain(preInsert.status);

    const pixelData = {
      index,
      owner: wallet,
      destination: "",
      imageUrl: "",
      message: "",
      neon: "none",
      valuationSol: 0.2,
      purchasedAt: Date.now(),
      isRented: false,
    };

    const rpcRes = await fetch(`${base}/rest/v1/rpc/insert_pixels_atomic`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        p_records: [pixelData],
        p_signature: signature,
        p_wallet: wallet,
        p_action: "buy",
        p_amount_sol: 0.2,
        p_mint: null,
        // SOL-98 Phase 6 (BULGU 1) — insert_pixels_atomic now re-checks the
        // price under an advisory lock; this test is about the LEDGER
        // rollback, not pricing, so pass a comfortably sufficient amount so
        // the price check always passes and the test reaches the exception
        // it's actually probing.
        p_paid_lamports: 999_999_999_999,
      }),
    });

    // The function call itself must fail — the unique_violation propagates
    // as a PostgREST error response, not a quiet {ok:false}.
    expect(rpcRes.ok).toBe(false);

    // The pixel row that was inserted EARLIER in this exact same function
    // call must have been rolled back along with the failed ledger insert.
    const pixelCheck = await fetch(`${base}/rest/v1/pixels?index=eq.${index}`, { headers: headers() });
    const pixelRows = (await pixelCheck.json()) as unknown[];
    expect(pixelRows).toHaveLength(0); // NOT created

    // No ownership_history row either (that INSERT is even later in the
    // function body — never reached).
    const historyCheck = await fetch(`${base}/rest/v1/pixel_ownership_history?pixel_index=eq.${index}&signature=eq.${signature}`, {
      headers: headers(),
    });
    expect(((await historyCheck.json()) as unknown[])).toHaveLength(0);

    // And still exactly ONE payment_transactions row for this signature
    // (the pre-inserted one) — the RPC's own attempted insert did not
    // silently create a duplicate.
    const ledgerCheck = await fetch(`${base}/rest/v1/payment_transactions?signature=eq.${signature}`, { headers: headers() });
    const ledgerRows = (await ledgerCheck.json()) as { wallet: string }[];
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0].wallet).toBe("pre-existing-unrelated-wallet");
  });

  it("RED TEAM — insert_board_pixels_atomic: the SAME ledger-constraint rollback also undoes the board_files + board_pixels INSERTs", async () => {
    const base = process.env.SUPABASE_URL!;
    const wallet = freshWallet();
    const signature = freshSignature("board-insert-atomicity");
    const fileId = `phase4test-board-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

    const preInsert = await fetch(`${base}/rest/v1/payment_transactions`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ signature, wallet: "pre-existing-unrelated-wallet", action: "buy-board", amount_sol: 2 }),
    });
    expect([201, 204]).toContain(preInsert.status);

    const fileData = { id: fileId, name: "Phase4Test Board", owner: wallet, purchasedAt: Date.now(), priceSol: 2 };
    const subBlocks = Array.from({ length: 5 }, (_, i) => ({
      boardId: fileId,
      index: i,
      owner: wallet,
      destination: "",
      imageUrl: "",
      message: "",
      neon: "none",
      valuationSol: 0.2,
      purchasedAt: Date.now(),
      isRented: false,
    }));

    const rpcRes = await fetch(`${base}/rest/v1/rpc/insert_board_pixels_atomic`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        p_file_id: fileId,
        p_file_data: fileData,
        p_records: subBlocks,
        p_signature: signature,
        p_wallet: wallet,
        p_action: "buy-board",
        p_amount_sol: 2,
        p_mint: null,
        // SOL-98 Phase 6 (BULGU 1) — see the insert_pixels_atomic RED TEAM
        // test's identical comment above.
        p_paid_lamports: 999_999_999_999,
      }),
    });
    expect(rpcRes.ok).toBe(false);

    const fileCheck = await fetch(`${base}/rest/v1/board_files?id=eq.${encodeURIComponent(fileId)}`, { headers: headers() });
    expect(((await fileCheck.json()) as unknown[])).toHaveLength(0); // rolled back

    const pixelsCheck = await fetch(`${base}/rest/v1/board_pixels?board_id=eq.${encodeURIComponent(fileId)}`, { headers: headers() });
    expect(((await pixelsCheck.json()) as unknown[])).toHaveLength(0); // rolled back

    const ledgerCheck = await fetch(`${base}/rest/v1/payment_transactions?signature=eq.${signature}`, { headers: headers() });
    const ledgerRows = (await ledgerCheck.json()) as { wallet: string }[];
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0].wallet).toBe("pre-existing-unrelated-wallet");
  });

  it("buy-board: file + sub-blocks + ledger + history all land together via ONE HTTP call", async () => {
    const { boards } = await freshRoutes();
    const owner = freshWallet();
    const signature = freshSignature("buy-board-happy");

    const res = await boards.POST(postBoards({ action: "buy-board", actor: owner, name: "Phase4Test Happy Board", signature }));
    expect(res.status).toBe(200);
    const file = (await res.json()).file as { id: string };

    const base = process.env.SUPABASE_URL!;
    const pixelsCheck = await fetch(`${base}/rest/v1/board_pixels?board_id=eq.${encodeURIComponent(file.id)}&select=data`, {
      headers: headers(),
    });
    const pixelRows = (await pixelsCheck.json()) as { data: { owner: string } }[];
    expect(pixelRows).toHaveLength(100); // BOARD_FILE_BLOCKS
    expect(pixelRows.every((r) => r.data.owner === owner)).toBe(true);

    const ledgerCheck = await fetch(`${base}/rest/v1/payment_transactions?signature=eq.${signature}`, { headers: headers() });
    expect(((await ledgerCheck.json()) as unknown[])).toHaveLength(1);

    const historyCheck = await fetch(`${base}/rest/v1/pixel_ownership_history?board_id=eq.${encodeURIComponent(file.id)}&signature=eq.${signature}`, {
      headers: headers(),
    });
    expect(((await historyCheck.json()) as unknown[])).toHaveLength(100);
  });
});
