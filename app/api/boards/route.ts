import { PublicKey } from "@solana/web3.js";
import { NextResponse } from "next/server";

import {
  countBoardFiles,
  getBoardPixel,
  hijackBoardPixel,
  makeSubBlocks,
  readAllBoards,
  renameBoardFile,
  updateBoardPixel,
} from "@/lib/server/board-db";
import { claimSignature, releaseSignatureSafely } from "@/lib/server/used-signatures";
import { verifyAuthProof } from "@/lib/server/verify-message";
import {
  solRequiredLamportsWithTolerance,
  tokenAmountToRaw,
  verifyBurn,
  verifySolTransfer,
  verifyTokenTransfer,
} from "@/lib/server/verify-tx";
import { getBurnedFraction } from "@/lib/server/token-stats";
import { isRateLimited, requestIp } from "@/lib/server/rate-limit";
import { createMutex } from "@/lib/server/mutex";
import { recordOwnershipHistory } from "@/lib/server/ownership-history";
import { logAudit } from "@/lib/server/audit-log";
import { getIntent, type IntentActionType, type PurchaseIntent } from "@/lib/server/intent-db";
import { updateBoardPixelOwnerAtomic } from "@/lib/server/board-mutations-atomic";
import { insertBoardAtomic } from "@/lib/server/board-insert-atomic";
import { HIJACK_COOLDOWN_MS, HIJACK_VALUATION_DECAY, hijackCostInTokens, splitHijackBurn } from "@/lib/token";
import { PIXEL98_MINT, TREASURY_ADDRESS } from "@/lib/solana";
import {
  BOARD_BLOCK_BASE_SOL,
  BOARD_FILE_BLOCKS,
  nextBoardFilePrice,
  sanitizeBoardName,
  type BoardFile,
  type BoardPixel,
} from "@/lib/board-types";
import { isAdValidationError, sanitizeAdContent } from "@/lib/pixel-types";

// Board state changes constantly — never statically optimize this route.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Same rationale as the pixel route: serialize everything that spends an
// on-chain signature (buy-board / buy-listing / rent / live hijack) so two
// concurrent requests can't both pass verification for the SAME signature.
const withWriteLock = createMutex();

function fail(status: number, error: string) {
  return NextResponse.json({ error }, { status });
}

// Anti-harassment cooldown — mirrors app/api/pixels/route.ts's identical
// helper (see HIJACK_COOLDOWN_MS in lib/token.ts).
function hijackProtectionError(protectedUntil: number | undefined): Response | null {
  if (!protectedUntil || Date.now() >= protectedUntil) return null;
  const mins = Math.max(1, Math.ceil((protectedUntil - Date.now()) / 60_000));
  return fail(409, `this spot is protected from hijacks for another ${mins} min — it was recently bought or hijacked`);
}

function parsePubkey(value: unknown): PublicKey | null {
  if (typeof value !== "string" || !value) return null;
  try {
    return new PublicKey(value);
  } catch {
    return null;
  }
}

function isValidBoardIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < BOARD_FILE_BLOCKS;
}

function parseBoardId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 80 ? value : null;
}

function readAd(body: Record<string, unknown>) {
  return sanitizeAdContent(body.ad);
}

/** GET /api/boards — every board.exe file and their sub-blocks. */
export async function GET() {
  try {
    const { files, pixels } = await readAllBoards();
    const burnedFraction = await getBurnedFraction();
    return NextResponse.json({ files, pixels, burnedFraction });
  } catch (error) {
    return fail(500, error instanceof Error ? error.message : "read failed");
  }
}

export async function POST(request: Request) {
  const ip = requestIp(request);
  if (isRateLimited(`boards:${ip}`, 90, 60_000)) {
    return fail(429, "Too many requests — slow down and try again in a minute.");
  }

  let body: Record<string, unknown>;
  try {
    const text = await request.text();
    if (text.length > 3_000_000) return fail(413, "payload too large");
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return fail(400, "invalid JSON body");
  }

  const action = body.action;
  if (typeof action !== "string") return fail(400, "missing action");

  const actorKey = parsePubkey(body.actor);
  if (!actorKey) return fail(400, "missing or invalid actor pubkey");
  const actor = actorKey.toBase58();

  try {
    switch (action) {
      case "buy-board":
        return await handleBuyBoard(body, actor, ip);
      case "edit-pixel":
        return await handleEditPixel(body, actor);
      case "list-sale":
        return await handleListSale(body, actor);
      case "list-rent":
        return await handleListRent(body, actor);
      case "unlist":
        return await handleUnlist(body, actor);
      case "buy-listing":
        return await handleBuyListing(body, actor, ip);
      case "buy-valuation":
        return await handleBuyValuation(body, actor, ip);
      case "rent":
        return await handleRent(body, actor, ip);
      case "hijack":
        return await handleHijack(body, actor, ip);
      case "rename-board":
        return await handleRename(body, actor);
      default:
        return fail(400, `unknown action "${action}"`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "request failed";
    logAudit("db_failure", { where: "boards POST", action, error: message });
    return fail(500, message);
  }
}

async function handleRename(body: Record<string, unknown>, actor: string) {
  const boardId = parseBoardId(body.boardId);
  if (!boardId) return fail(400, "missing or invalid boardId");
  const auth = readAuth(body, "board-rename", -1, actor);
  if (!auth.ok) return fail(401, auth.error);
  const newName = sanitizeBoardName(body.name);

  const result = await renameBoardFile(boardId, actor, newName);
  if (!result.ok) return fail(result.reason === "not_owner" ? 403 : 404, result.reason);
  return NextResponse.json({ ok: true, file: result.file });
}

// ---------------------------------------------------------------------------
// SOL-98 Phase 3 (MARKET SECURITY) — mirrors app/api/pixels/route.ts's
// resolveIntent exactly (see that file's doc comment for the full P2-F1
// rationale). Extending the fix here is an own-initiative scope decision:
// while building the intent system it became clear boards/route.ts's
// buy-listing / rent / live-hijack handlers have the IDENTICAL
// transaction-substitution pattern as the main board did before this phase
// — disclosed in full in docs/production-readiness/PHASE-3-MARKET-SECURITY.md.
// ---------------------------------------------------------------------------
async function resolveIntent(
  body: Record<string, unknown>,
  actor: string,
  expectedActionType: IntentActionType
): Promise<{ ok: true; intent: PurchaseIntent & { boardId: string } } | { ok: false; response: Response }> {
  const intentId = body.intentId;
  if (typeof intentId !== "string" || !intentId) {
    return { ok: false, response: fail(400, "missing intentId — create one via POST /api/purchase-intents first") };
  }
  const intent = await getIntent(intentId);
  if (!intent) return { ok: false, response: fail(404, "purchase intent not found") };
  if (intent.actionType !== expectedActionType) {
    return { ok: false, response: fail(400, "this intent was not created for this action") };
  }
  // The intent's OWN boardId is authoritative — which board.exe file this
  // redeems is never taken from the request body, only from the server-
  // issued intent record. (null means the intent was created for the main
  // pixel board, which this route can't redeem.)
  if (intent.boardId === null) {
    return { ok: false, response: fail(400, "this intent is for the main pixel board — redeem it via POST /api/pixels") };
  }
  if (intent.buyerWallet !== actor) {
    logAudit("authorization_failure", { action: expectedActionType, wallet: actor, reason: "intent belongs to a different wallet", intentId });
    return { ok: false, response: fail(403, "this purchase intent belongs to a different wallet") };
  }
  if (intent.status !== "pending") {
    return { ok: false, response: fail(409, `this intent is ${intent.status}, not pending`) };
  }
  if (intent.expiresAt <= Date.now()) {
    return { ok: false, response: fail(410, "this purchase intent has expired — create a new one") };
  }
  // Defense in depth: POST /api/purchase-intents already refuses to create
  // a self-targeting intent.
  if (intent.buyerWallet === intent.sellerWallet) {
    return { ok: false, response: fail(400, "you already own this spot") };
  }
  return { ok: true, intent: intent as PurchaseIntent & { boardId: string } };
}

function readAuth(body: Record<string, unknown>, action: string, index: number, actor: string) {
  const timestamp = body.authTimestamp;
  const signature = body.authSignature;
  if (typeof timestamp !== "number" || typeof signature !== "string" || !signature) {
    logAudit("authorization_failure", { action, wallet: actor, reason: "missing auth proof" });
    return { ok: false as const, error: "missing auth proof" };
  }
  const result = verifyAuthProof({ action, index, owner: actor, timestamp, signature });
  if (!result.ok) logAudit("authorization_failure", { action, wallet: actor, reason: result.error });
  return result;
}

// ---------------------------------------------------------------------------
// buy-board — the next board.exe file, paid at the 2 SOL (+10%) bonding curve
// to the treasury. Price is recomputed server-side from the live file count.
// ---------------------------------------------------------------------------
async function handleBuyBoard(body: Record<string, unknown>, actor: string, ip: string) {
  if (isRateLimited(`boards-buy:${ip}`, 20, 60_000)) return fail(429, "Too many purchase attempts — slow down.");
  if (!TREASURY_ADDRESS) return fail(500, "Treasury not configured — set NEXT_PUBLIC_TREASURY_ADDRESS");

  const signature = body.signature;
  if (typeof signature !== "string" || !signature) return fail(400, "missing signature");
  const name = sanitizeBoardName(body.name);

  return withWriteLock(async () => {
    const soldCount = await countBoardFiles();
    const priceSol = nextBoardFilePrice(soldCount);
    const minLamports = solRequiredLamportsWithTolerance(priceSol);

    const verified = await verifySolTransfer({ signature, fromOwner: actor, toOwner: TREASURY_ADDRESS, minLamports });
    if (!verified.ok) {
      logAudit("payment_verification_failed", { action: "buy-board", wallet: actor, reason: verified.error });
      return fail(402, `payment not verified: ${verified.error}`);
    }
    logAudit("payment_verified", { action: "buy-board", wallet: actor });
    // SOL-98 Phase 6 (BULGU 1, see docs/production-readiness/
    // RED-TEAM-FINDINGS.md) — same fix as buy/buy-area: forward the REAL
    // verified lamport amount so insertBoardAtomic's RPC can re-derive the
    // true board.exe price under a cross-instance advisory lock and reject
    // an underpayment caused by a racy soldCount read.
    const paidLamports = verified.lamportsFound ?? minLamports;

    const firstUse = await claimSignature(signature);
    if (!firstUse) {
      logAudit("duplicate_transaction_detected", { action: "buy-board", wallet: actor, where: "used_signatures" });
      return fail(409, "this transaction signature was already used");
    }

    const id = `b-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const now = Date.now();
    const file: BoardFile = { id, name, owner: actor, purchasedAt: now, priceSol };
    const subBlocks = makeSubBlocks(id, actor, now);

    // SOL-98 Phase 3 (own-initiative fix, same class as P2-F2 — see
    // docs/production-readiness/PHASE-3-MARKET-SECURITY.md's disclosure
    // section): boards/route.ts predates the Phase 2.1 fix, which only
    // touched pixels/route.ts. A THROWN error here — a real DB/infra
    // failure, not a clean creation conflict — must not permanently burn a
    // signature that already paid the treasury.
    // SOL-98 Phase 4 (fixes P2-F4 for the treasury paths — GÖREV 2): the
    // board_files INSERT, the board_pixels sub-block INSERT, the
    // payment_transactions INSERT, and the pixel_ownership_history INSERT
    // now happen in ONE Postgres transaction (see
    // lib/server/board-insert-atomic.ts) instead of createBoard()'s
    // two-INSERT-plus-manual-compensating-DELETE sequence followed by two
    // more separate best-effort ledger writes.
    let created: Awaited<ReturnType<typeof insertBoardAtomic>>;
    try {
      created = await insertBoardAtomic({ file, subBlocks, signature, wallet: actor, action: "buy-board", amountSol: priceSol, paidLamports });
    } catch (error) {
      await releaseSignatureSafely(signature, { action: "buy-board", wallet: actor });
      logAudit("db_failure", {
        where: "insertBoardAtomic",
        action: "buy-board",
        wallet: actor,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    if (!created.ok) {
      await releaseSignatureSafely(signature, { action: "buy-board", wallet: actor });
      if (created.reason === "underpaid") {
        logAudit("ownership_conflict", { action: "buy-board", wallet: actor, reason: "underpaid" });
        return fail(
          409,
          "the price moved before your purchase landed (someone bought ahead of you in the queue) — your payment proof is still valid, please check the current price and retry"
        );
      }
      logAudit("ownership_conflict", { action: "buy-board", wallet: actor });
      return fail(409, "board creation conflict — please retry");
    }
    return NextResponse.json({ ok: true, file: created.file });
  });
}

// ---------------------------------------------------------------------------
// Free, owner-only sub-block actions (edit / list / unlist) — signed message
// proof, ownership re-checked against the STORED pixel.
// ---------------------------------------------------------------------------
async function handleEditPixel(body: Record<string, unknown>, actor: string) {
  const boardId = parseBoardId(body.boardId);
  if (!boardId) return fail(400, "missing or invalid boardId");
  const index = body.index;
  if (!isValidBoardIndex(index)) return fail(400, "invalid index");
  const auth = readAuth(body, "board-edit", index, actor);
  if (!auth.ok) return fail(401, auth.error);
  const ad = readAd(body);
  if (isAdValidationError(ad)) return fail(400, `${ad.field}: ${ad.reason}`);

  const result = await updateBoardPixel(boardId, index, actor, (current) => ({ ...current, ...ad }));
  if (!result.ok) return fail(result.reason === "not_owner" ? 403 : 404, result.reason);
  return NextResponse.json({ ok: true, pixel: result.pixel });
}

async function handleListSale(body: Record<string, unknown>, actor: string) {
  const boardId = parseBoardId(body.boardId);
  if (!boardId) return fail(400, "missing or invalid boardId");
  const index = body.index;
  if (!isValidBoardIndex(index)) return fail(400, "invalid index");
  const auth = readAuth(body, "board-list-sale", index, actor);
  if (!auth.ok) return fail(401, auth.error);
  const currency = body.currency === "PIXEL98" ? "PIXEL98" : "SOL";
  const price = body.price;
  if (typeof price !== "number" || !Number.isFinite(price) || price <= 0 || price > 1_000_000) {
    return fail(400, "invalid price");
  }

  const result = await updateBoardPixel(boardId, index, actor, (current) => ({
    ...current,
    listingPriceSol: currency === "SOL" ? price : undefined,
    listingPricePixel98: currency === "PIXEL98" ? price : undefined,
    rentPriceSol: undefined,
    rentPricePixel98: undefined,
  }));
  if (!result.ok) return fail(result.reason === "not_owner" ? 403 : 404, result.reason);
  return NextResponse.json({ ok: true, pixel: result.pixel });
}

async function handleListRent(body: Record<string, unknown>, actor: string) {
  const boardId = parseBoardId(body.boardId);
  if (!boardId) return fail(400, "missing or invalid boardId");
  const index = body.index;
  if (!isValidBoardIndex(index)) return fail(400, "invalid index");
  const auth = readAuth(body, "board-list-rent", index, actor);
  if (!auth.ok) return fail(401, auth.error);
  const currency = body.currency === "PIXEL98" ? "PIXEL98" : "SOL";
  const pricePerDay = body.pricePerDay;
  if (typeof pricePerDay !== "number" || !Number.isFinite(pricePerDay) || pricePerDay <= 0 || pricePerDay > 1_000_000) {
    return fail(400, "invalid pricePerDay");
  }

  const result = await updateBoardPixel(boardId, index, actor, (current) => ({
    ...current,
    rentPriceSol: currency === "SOL" ? pricePerDay : undefined,
    rentPricePixel98: currency === "PIXEL98" ? pricePerDay : undefined,
    listingPriceSol: undefined,
    listingPricePixel98: undefined,
  }));
  if (!result.ok) return fail(result.reason === "not_owner" ? 403 : 404, result.reason);
  return NextResponse.json({ ok: true, pixel: result.pixel });
}

async function handleUnlist(body: Record<string, unknown>, actor: string) {
  const boardId = parseBoardId(body.boardId);
  if (!boardId) return fail(400, "missing or invalid boardId");
  const index = body.index;
  if (!isValidBoardIndex(index)) return fail(400, "invalid index");
  const auth = readAuth(body, "board-unlist", index, actor);
  if (!auth.ok) return fail(401, auth.error);

  const result = await updateBoardPixel(boardId, index, actor, (current) => ({
    ...current,
    listingPriceSol: undefined,
    listingPricePixel98: undefined,
    rentPriceSol: undefined,
    rentPricePixel98: undefined,
  }));
  if (!result.ok) return fail(result.reason === "not_owner" ? 403 : 404, result.reason);
  return NextResponse.json({ ok: true, pixel: result.pixel });
}

// ---------------------------------------------------------------------------
// buy-listing / rent — peer-to-peer sub-block payments (SOL or $PIXEL98).
// ---------------------------------------------------------------------------
async function handleBuyListing(body: Record<string, unknown>, actor: string, ip: string) {
  if (isRateLimited(`boards-buy:${ip}`, 20, 60_000)) return fail(429, "Too many purchase attempts — slow down.");
  const resolved = await resolveIntent(body, actor, "buy-listing");
  if (!resolved.ok) return resolved.response;
  const intent = resolved.intent;
  const boardId = intent.boardId;
  const index = intent.pixelIndex;
  const signature = body.signature;
  if (typeof signature !== "string" || !signature) return fail(400, "missing signature");

  return withWriteLock(async () => {
    const current = await getBoardPixel(boardId, index);
    if (!current) return fail(404, "spot not found");
    if (current.owner !== intent.sellerWallet) {
      return fail(409, "this listing changed since your intent was created — please create a new intent");
    }
    if (current.listingPriceSol === undefined && current.listingPricePixel98 === undefined) {
      return fail(400, "spot is not listed for sale");
    }
    const seller = intent.sellerWallet;
    const paidPixel98 = intent.currency === "PIXEL98";

    if (!paidPixel98) {
      const priceSol = intent.priceSol ?? 0;
      if (current.listingPriceSol !== priceSol) {
        return fail(409, "the listing price changed since your intent was created — please create a new intent");
      }
      const minLamports = solRequiredLamportsWithTolerance(priceSol);
      const verified = await verifySolTransfer({ signature, fromOwner: actor, toOwner: seller, minLamports });
      if (!verified.ok) {
        logAudit("payment_verification_failed", { action: "board-buy-listing", wallet: actor, reason: verified.error });
        return fail(402, `payment not verified: ${verified.error}`);
      }
    } else {
      if (!PIXEL98_MINT) return fail(503, "$PIXEL98 not live yet — this listing can't be paid until launch");
      const pricePixel98 = intent.pricePixel98 ?? 0;
      if (current.listingPricePixel98 !== pricePixel98) {
        return fail(409, "the listing price changed since your intent was created — please create a new intent");
      }
      const minRaw = await tokenAmountToRaw(PIXEL98_MINT, pricePixel98);
      const verified = await verifyTokenTransfer({ signature, fromOwner: actor, toOwner: seller, mint: PIXEL98_MINT, minRawAmount: minRaw });
      if (!verified.ok) {
        logAudit("payment_verification_failed", { action: "board-buy-listing", wallet: actor, reason: verified.error });
        return fail(402, `payment not verified: ${verified.error}`);
      }
    }
    logAudit("payment_verified", { action: "board-buy-listing", wallet: actor, boardId, index });

    const firstUse = await claimSignature(signature);
    if (!firstUse) {
      logAudit("duplicate_transaction_detected", { action: "board-buy-listing", wallet: actor, where: "used_signatures" });
      return fail(409, "this transaction signature was already used");
    }

    let result: Awaited<ReturnType<typeof updateBoardPixelOwnerAtomic>>;
    try {
      result = await updateBoardPixelOwnerAtomic({
        boardId,
        index,
        expectedOwner: seller,
        mutate: (existing) => ({
          ...existing,
          owner: actor,
          destination: "",
          imageUrl: "",
          message: "",
          neon: "none",
          purchasedAt: Date.now(),
          isRented: false,
          listingPriceSol: undefined,
          listingPricePixel98: undefined,
          rentPriceSol: undefined,
          rentPricePixel98: undefined,
          valuationSol: existing.listingPriceSol ?? existing.valuationSol,
          protectedUntil: Date.now() + HIJACK_COOLDOWN_MS,
        }),
        signature,
        wallet: actor,
        action: "board-buy-listing",
        amountSol: paidPixel98 ? undefined : intent.priceSol,
        mint: paidPixel98 ? PIXEL98_MINT : null,
        intentId: intent.id,
        prevOwner: seller,
        newOwner: actor,
        recordHistory: true,
      });
    } catch (error) {
      await releaseSignatureSafely(signature, { action: "board-buy-listing", wallet: actor, boardId, index });
      logAudit("db_failure", {
        where: "updateBoardPixelOwnerAtomic",
        action: "board-buy-listing",
        wallet: actor,
        boardId,
        index,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    if (!result.ok) {
      await releaseSignatureSafely(signature, { action: "board-buy-listing", wallet: actor, boardId, index });
      logAudit("ownership_conflict", { action: "board-buy-listing", wallet: actor, boardId, index });
      return fail(409, "this listing changed before your purchase landed — your payment proof is still valid to retry");
    }
    return NextResponse.json({ ok: true, pixel: result.pixel });
  });
}

// ---------------------------------------------------------------------------
// buy-valuation — mirrors app/api/pixels/route.ts's handleBuyValuation
// exactly, for a Start Ads sub-block: always-available direct purchase of
// any owned sub-block at its current on-record valuationSol, no listing
// required. On success the valuation is bumped +10% — the buy half of the
// buy(+10%)/hijack(−5%) cycle.
// ---------------------------------------------------------------------------
async function handleBuyValuation(body: Record<string, unknown>, actor: string, ip: string) {
  if (isRateLimited(`boards-buy:${ip}`, 20, 60_000)) return fail(429, "Too many purchase attempts — slow down.");
  const resolved = await resolveIntent(body, actor, "buy-valuation");
  if (!resolved.ok) return resolved.response;
  const intent = resolved.intent;
  const boardId = intent.boardId;
  const index = intent.pixelIndex;
  const signature = body.signature;
  if (typeof signature !== "string" || !signature) return fail(400, "missing signature");

  return withWriteLock(async () => {
    const current = await getBoardPixel(boardId, index);
    if (!current) return fail(404, "spot not found");
    if (current.owner !== intent.sellerWallet) {
      return fail(409, "this spot changed hands since your intent was created — please create a new intent");
    }
    const priceSol = intent.priceSol ?? 0;
    if (current.valuationSol !== priceSol) {
      return fail(409, "this spot's valuation changed since your intent was created — please create a new intent");
    }
    const seller = intent.sellerWallet;

    const minLamports = solRequiredLamportsWithTolerance(priceSol);
    const verified = await verifySolTransfer({ signature, fromOwner: actor, toOwner: seller, minLamports });
    if (!verified.ok) {
      logAudit("payment_verification_failed", { action: "board-buy-valuation", wallet: actor, reason: verified.error });
      return fail(402, `payment not verified: ${verified.error}`);
    }
    logAudit("payment_verified", { action: "board-buy-valuation", wallet: actor, boardId, index });

    const firstUse = await claimSignature(signature);
    if (!firstUse) {
      logAudit("duplicate_transaction_detected", { action: "board-buy-valuation", wallet: actor, where: "used_signatures" });
      return fail(409, "this transaction signature was already used");
    }

    let result: Awaited<ReturnType<typeof updateBoardPixelOwnerAtomic>>;
    try {
      result = await updateBoardPixelOwnerAtomic({
        boardId,
        index,
        expectedOwner: seller,
        mutate: (existing) => ({
          ...existing,
          owner: actor,
          destination: "",
          imageUrl: "",
          message: "",
          neon: "none",
          purchasedAt: Date.now(),
          isRented: false,
          listingPriceSol: undefined,
          listingPricePixel98: undefined,
          rentPriceSol: undefined,
          rentPricePixel98: undefined,
          valuationSol: existing.valuationSol * 1.1,
          protectedUntil: Date.now() + HIJACK_COOLDOWN_MS,
        }),
        signature,
        wallet: actor,
        action: "board-buy-valuation",
        amountSol: intent.priceSol,
        mint: null,
        intentId: intent.id,
        prevOwner: seller,
        newOwner: actor,
        recordHistory: true,
      });
    } catch (error) {
      await releaseSignatureSafely(signature, { action: "board-buy-valuation", wallet: actor, boardId, index });
      logAudit("db_failure", {
        where: "updateBoardPixelOwnerAtomic",
        action: "board-buy-valuation",
        wallet: actor,
        boardId,
        index,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    if (!result.ok) {
      await releaseSignatureSafely(signature, { action: "board-buy-valuation", wallet: actor, boardId, index });
      logAudit("ownership_conflict", { action: "board-buy-valuation", wallet: actor, boardId, index });
      return fail(409, "this spot changed hands before your purchase landed — your payment proof is still valid to retry");
    }
    return NextResponse.json({ ok: true, pixel: result.pixel });
  });
}

async function handleRent(body: Record<string, unknown>, actor: string, ip: string) {
  if (isRateLimited(`boards-buy:${ip}`, 20, 60_000)) return fail(429, "Too many purchase attempts — slow down.");
  const resolved = await resolveIntent(body, actor, "rent");
  if (!resolved.ok) return resolved.response;
  const intent = resolved.intent;
  const boardId = intent.boardId;
  const index = intent.pixelIndex;
  const days = intent.rentDays ?? 0;
  const signature = body.signature;
  if (typeof signature !== "string" || !signature) return fail(400, "missing signature");

  return withWriteLock(async () => {
    const current = await getBoardPixel(boardId, index);
    if (!current) return fail(404, "spot not found");
    if (current.owner !== intent.sellerWallet) {
      return fail(409, "this listing changed since your intent was created — please create a new intent");
    }
    if (current.rentPriceSol === undefined && current.rentPricePixel98 === undefined) {
      return fail(400, "spot is not listed for rent");
    }
    const owner = intent.sellerWallet;
    const paidPixel98 = intent.currency === "PIXEL98";

    if (!paidPixel98) {
      if (current.rentPriceSol === undefined) {
        return fail(409, "this spot is no longer listed for rent in SOL — please create a new intent");
      }
      const priceSol = intent.priceSol ?? 0;
      if (current.rentPriceSol * days !== priceSol) {
        return fail(409, "the rent price changed since your intent was created — please create a new intent");
      }
      const minLamports = solRequiredLamportsWithTolerance(priceSol);
      const verified = await verifySolTransfer({ signature, fromOwner: actor, toOwner: owner, minLamports });
      if (!verified.ok) {
        logAudit("payment_verification_failed", { action: "board-rent", wallet: actor, reason: verified.error });
        return fail(402, `payment not verified: ${verified.error}`);
      }
    } else {
      if (!PIXEL98_MINT) return fail(503, "$PIXEL98 not live yet — this listing can't be paid until launch");
      if (current.rentPricePixel98 === undefined) {
        return fail(409, "this spot is no longer listed for rent in $PIXEL98 — please create a new intent");
      }
      const pricePixel98 = intent.pricePixel98 ?? 0;
      if (current.rentPricePixel98 * days !== pricePixel98) {
        return fail(409, "the rent price changed since your intent was created — please create a new intent");
      }
      const minRaw = await tokenAmountToRaw(PIXEL98_MINT, pricePixel98);
      const verified = await verifyTokenTransfer({ signature, fromOwner: actor, toOwner: owner, mint: PIXEL98_MINT, minRawAmount: minRaw });
      if (!verified.ok) {
        logAudit("payment_verification_failed", { action: "board-rent", wallet: actor, reason: verified.error });
        return fail(402, `payment not verified: ${verified.error}`);
      }
    }
    logAudit("payment_verified", { action: "board-rent", wallet: actor, boardId, index });

    const firstUse = await claimSignature(signature);
    if (!firstUse) {
      logAudit("duplicate_transaction_detected", { action: "board-rent", wallet: actor, where: "used_signatures" });
      return fail(409, "this transaction signature was already used");
    }

    let result: Awaited<ReturnType<typeof updateBoardPixelOwnerAtomic>>;
    try {
      result = await updateBoardPixelOwnerAtomic({
        boardId,
        index,
        expectedOwner: owner,
        mutate: (existing) => ({
          ...existing,
          isRented: true,
          rentedTo: actor,
          rentedUntil: Date.now() + days * 24 * 60 * 60 * 1000,
          rentPriceSol: undefined,
          rentPricePixel98: undefined,
        }),
        signature,
        wallet: actor,
        action: "board-rent",
        amountSol: paidPixel98 ? undefined : intent.priceSol,
        mint: paidPixel98 ? PIXEL98_MINT : null,
        intentId: intent.id,
        prevOwner: owner,
        newOwner: owner,
        recordHistory: false,
      });
    } catch (error) {
      await releaseSignatureSafely(signature, { action: "board-rent", wallet: actor, boardId, index });
      logAudit("db_failure", {
        where: "updateBoardPixelOwnerAtomic",
        action: "board-rent",
        wallet: actor,
        boardId,
        index,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    if (!result.ok) {
      await releaseSignatureSafely(signature, { action: "board-rent", wallet: actor, boardId, index });
      logAudit("ownership_conflict", { action: "board-rent", wallet: actor, boardId, index });
      return fail(409, "this listing changed before your rental landed — your payment proof is still valid to retry");
    }
    return NextResponse.json({ ok: true, pixel: result.pixel });
  });
}

// ---------------------------------------------------------------------------
// hijack — overtake a sub-block. Live = tiered $PIXEL98 burn (50/50 split),
// pre-launch = simulated (wallet-signed + rate-limited).
// ---------------------------------------------------------------------------
async function handleHijack(body: Record<string, unknown>, actor: string, ip: string) {
  const tokenLive = Boolean(PIXEL98_MINT);

  // SOL-98 Phase 3 (fixes P2-F1 / GÖREV 2) — mirrors
  // app/api/pixels/route.ts's handleHijack exactly: once $PIXEL98 is live a
  // hijack spends a real verified burn, so it goes through the same
  // purchase_intent system. The free pre-launch simulated path is
  // unaffected — nothing is paid, so there's nothing to substitute.
  if (tokenLive) {
    if (isRateLimited(`boards-hijack:${ip}`, 20, 60_000)) return fail(429, "Too many hijack attempts — slow down.");
    const resolved = await resolveIntent(body, actor, "hijack");
    if (!resolved.ok) return resolved.response;
    const intent = resolved.intent;
    const boardId = intent.boardId;
    const index = intent.pixelIndex;
    const signature = body.signature;
    if (typeof signature !== "string" || !signature) return fail(400, "missing hijack transaction signature");

    return withWriteLock(async () => {
      const target = await getBoardPixel(boardId, index);
      if (!target) return fail(404, "nothing to hijack there yet");
      if (target.owner === actor) return fail(400, "you already own this spot");
      if (target.owner !== intent.sellerWallet) {
        return fail(409, "that spot changed hands since your intent was created — please create a new intent");
      }
      const protectionError = hijackProtectionError(target.protectedUntil);
      if (protectionError) return protectionError;

      // Cost is ALWAYS recomputed fresh from the live burned fraction AND
      // the target's live valuation — never taken from the intent.
      const burnedFraction = await getBurnedFraction();
      const hijackCost = hijackCostInTokens(burnedFraction, target.valuationSol, BOARD_BLOCK_BASE_SOL);
      const split = splitHijackBurn(hijackCost);
      const burnRaw = await tokenAmountToRaw(PIXEL98_MINT, split.burnedTokens);
      const ownerRaw = await tokenAmountToRaw(PIXEL98_MINT, split.ownerTokens);

      const burnVerified = await verifyBurn({ signature, owner: actor, mint: PIXEL98_MINT, minRawAmount: burnRaw });
      if (!burnVerified.ok) {
        logAudit("payment_verification_failed", { action: "board-hijack", wallet: actor, reason: burnVerified.error });
        return fail(402, `burn not verified: ${burnVerified.error}`);
      }

      const transferVerified = await verifyTokenTransfer({
        signature,
        fromOwner: actor,
        toOwner: target.owner,
        mint: PIXEL98_MINT,
        minRawAmount: ownerRaw,
      });
      if (!transferVerified.ok) {
        logAudit("payment_verification_failed", { action: "board-hijack", wallet: actor, reason: transferVerified.error });
        return fail(402, `owner compensation not verified: ${transferVerified.error}`);
      }
      logAudit("payment_verified", { action: "board-hijack", wallet: actor, boardId, index });

      const firstUse = await claimSignature(signature);
      if (!firstUse) {
        logAudit("duplicate_transaction_detected", { action: "board-hijack", wallet: actor, where: "used_signatures" });
        return fail(409, "this hijack transaction signature was already used");
      }

      const prevOwner = target.owner;
      let result: Awaited<ReturnType<typeof updateBoardPixelOwnerAtomic>>;
      try {
        result = await updateBoardPixelOwnerAtomic({
          boardId,
          index,
          expectedOwner: prevOwner,
          mutate: (current) => applyHijack(current, actor),
          signature,
          wallet: actor,
          action: "board-hijack",
          mint: PIXEL98_MINT,
          intentId: intent.id,
          prevOwner,
          newOwner: actor,
          recordHistory: true,
        });
      } catch (error) {
        await releaseSignatureSafely(signature, { action: "board-hijack", wallet: actor, boardId, index });
        logAudit("db_failure", {
          where: "updateBoardPixelOwnerAtomic",
          action: "board-hijack",
          wallet: actor,
          boardId,
          index,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
      if (!result.ok) {
        await releaseSignatureSafely(signature, { action: "board-hijack", wallet: actor, boardId, index });
        logAudit("ownership_conflict", { action: "board-hijack", wallet: actor, boardId, index });
        return fail(409, "that spot changed hands before your hijack landed — please retry");
      }
      return NextResponse.json({
        ok: true,
        pixel: result.pixel,
        simulated: false,
        hijack: { costTokens: hijackCost, burnedTokens: split.burnedTokens, ownerTokens: split.ownerTokens, burnedFraction },
      });
    });
  }

  // Simulated (pre-launch) — free, wallet-signed + rate-limited. No
  // purchase intent involved.
  const boardId = parseBoardId(body.boardId);
  if (!boardId) return fail(400, "missing or invalid boardId");
  const index = body.index;
  if (!isValidBoardIndex(index)) return fail(400, "invalid index");
  const target = await getBoardPixel(boardId, index);
  if (!target) return fail(404, "nothing to hijack there yet");
  if (target.owner === actor) return fail(400, "you already own this spot");
  const protectionError = hijackProtectionError(target.protectedUntil);
  if (protectionError) return protectionError;

  const burnedFraction = await getBurnedFraction();
  const hijackCost = hijackCostInTokens(burnedFraction, target.valuationSol, BOARD_BLOCK_BASE_SOL);
  const split = splitHijackBurn(hijackCost);

  if (isRateLimited(`boards-hijack-sim:${actor}`, 5, 10 * 60_000)) {
    return fail(429, "Too many simulated hijacks from this wallet — try again later.");
  }
  const authCheck = readAuth(body, "board-hijack", index, actor);
  if (!authCheck.ok) return fail(401, authCheck.error);

  const prevOwnerSim = target.owner;
  const result = await hijackBoardPixel(boardId, index, (current) => applyHijack(current, actor));
  if (!result.ok) {
    logAudit("ownership_conflict", { action: "board-hijack-simulated", wallet: actor, boardId, index });
    return fail(409, "that spot changed hands — please retry");
  }
  await recordOwnershipHistory({ pixelIndex: index, boardId, prevOwner: prevOwnerSim, newOwner: actor, action: "hijack" });
  return NextResponse.json({
    ok: true,
    pixel: result.pixel,
    simulated: true,
    hijack: { costTokens: hijackCost, burnedTokens: split.burnedTokens, ownerTokens: split.ownerTokens, burnedFraction },
  });
}

function applyHijack(current: BoardPixel, newOwner: string): BoardPixel {
  return {
    ...current,
    owner: newOwner,
    valuationSol: current.valuationSol * (1 - HIJACK_VALUATION_DECAY),
    destination: "",
    imageUrl: "",
    message: "",
    neon: "none",
    purchasedAt: Date.now(),
    protectedUntil: Date.now() + HIJACK_COOLDOWN_MS,
    isRented: false,
    rentedTo: undefined,
    rentedUntil: undefined,
    listingPriceSol: undefined,
    rentPriceSol: undefined,
    listingPricePixel98: undefined,
    rentPricePixel98: undefined,
  };
}
