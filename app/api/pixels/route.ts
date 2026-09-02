import { PublicKey } from "@solana/web3.js";
import { NextResponse } from "next/server";

import {
  getPixel,
  hijackPixel,
  readAllPixels,
  soldCount,
  updateGroupOwnedPixels,
  updateOwnedPixel,
} from "@/lib/server/pixel-db";
import { claimSignature, releaseSignatureSafely } from "@/lib/server/used-signatures";
import { verifyAuthProof } from "@/lib/server/verify-message";
import { solRequiredLamportsWithTolerance, tokenAmountToRaw, verifyBurn, verifySolTransfer, verifyTokenTransfer } from "@/lib/server/verify-tx";
import { getBurnedFraction } from "@/lib/server/token-stats";
import { isRateLimited, requestIp } from "@/lib/server/rate-limit";
import { createMutex } from "@/lib/server/mutex";
import { recordOwnershipHistory } from "@/lib/server/ownership-history";
import { logAudit } from "@/lib/server/audit-log";
import { getIntent, type IntentActionType, type PurchaseIntent } from "@/lib/server/intent-db";
import { updatePixelOwnerAtomic } from "@/lib/server/pixel-mutations-atomic";
import { insertPixelsAtomic } from "@/lib/server/pixel-insert-atomic";
import { areaPrice, BOARD_SIZE, INITIAL_PRICE_SOL, nextSpotPrice, TOTAL_SPOTS } from "@/lib/pricing";
import { HIJACK_COOLDOWN_MS, HIJACK_VALUATION_DECAY, hijackCostInTokens, splitHijackBurn } from "@/lib/token";
import { PIXEL98_MINT, TREASURY_ADDRESS } from "@/lib/solana";
import {
  bannerPosition,
  computeBannerLayout,
  isAdValidationError,
  MAX_AREA_BLOCKS,
  sanitizeAdContent,
  type PixelData,
} from "@/lib/pixel-types";

// Board state changes constantly — never statically optimize this route.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Serializes every action that spends an on-chain signature (buy / buy-area
// / live hijack / buy-listing / rent) into one critical section per process.
// This is what makes "claim the signature, then write" safe: without it two
// concurrent requests could both pass verification for the SAME signature
// before either had recorded it as used, and both grant a pixel for one
// payment. See lib/server/used-signatures.ts for the claim/release contract.
const withWriteLock = createMutex();

function fail(status: number, error: string) {
  return NextResponse.json({ error }, { status });
}

// Anti-harassment cooldown (see HIJACK_COOLDOWN_MS): a spot that was just
// bought or hijacked can't be hijacked again until this passes, so an owner
// always gets a guaranteed window of real "ad time" instead of being
// re-hijacked the instant they take a spot back.
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

function isValidIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < TOTAL_SPOTS;
}

/** Requested indices must form one gap-free, duplicate-free rectangle. */
function isValidRectangle(indices: number[]): boolean {
  if (indices.length === 0 || indices.length > MAX_AREA_BLOCKS) return false;
  if (!indices.every(isValidIndex)) return false;
  const unique = new Set(indices);
  if (unique.size !== indices.length) return false;
  const layout = computeBannerLayout(indices, BOARD_SIZE);
  if (layout.cols * layout.rows !== indices.length) return false;
  for (const index of indices) {
    const { bannerX, bannerY } = bannerPosition(index, BOARD_SIZE, layout);
    if (bannerX < 0 || bannerX >= layout.cols || bannerY < 0 || bannerY >= layout.rows) return false;
  }
  return true;
}

/** GET /api/pixels — the whole board. Every user sees this same global state. */
export async function GET() {
  try {
    const pixels = await readAllPixels();
    const burnedFraction = await getBurnedFraction();
    return NextResponse.json({ pixels, burnedFraction });
  } catch (error) {
    return fail(500, error instanceof Error ? error.message : "read failed");
  }
}

export async function POST(request: Request) {
  const ip = requestIp(request);
  if (isRateLimited(`pixels:${ip}`, 90, 60_000)) {
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
      case "buy":
        return await handleBuy(body, actor, ip);
      case "buy-area":
        return await handleBuyArea(body, actor, ip);
      case "hijack":
        return await handleHijack(body, actor, ip);
      case "edit":
        return await handleEdit(body, actor);
      case "edit-area":
        return await handleEditArea(body, actor);
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
      default:
        return fail(400, `unknown action "${action}"`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "request failed";
    logAudit("db_failure", { where: "pixels POST", action, error: message });
    return fail(500, message);
  }
}

function readAd(body: Record<string, unknown>) {
  return sanitizeAdContent(body.ad);
}

function requireTreasury(): string | null {
  return TREASURY_ADDRESS || null;
}

// ---------------------------------------------------------------------------
// SOL-98 Phase 3 (MARKET SECURITY) — fixes finding P2-F1 (transaction
// substitution, see docs/production-readiness/PHASE-2-PAYMENT-SECURITY.md
// and PHASE-3-MARKET-SECURITY.md). buy-listing / rent / hijack(live) now
// require a server-issued purchase_intent (created via
// POST /api/purchase-intents) instead of trusting a client-submitted
// index. This resolves + validates that intent; every caller below then
// uses `intent.pixelIndex` / `intent.sellerWallet` / `intent.priceSol` /
// `intent.pricePixel98` as the SOLE source of truth for what's being paid
// for — the request body's own `index` field (if present) is never read by
// any of these three handlers again.
// ---------------------------------------------------------------------------
async function resolveIntent(
  body: Record<string, unknown>,
  actor: string,
  expectedActionType: IntentActionType
): Promise<{ ok: true; intent: PurchaseIntent } | { ok: false; response: Response }> {
  const intentId = body.intentId;
  if (typeof intentId !== "string" || !intentId) {
    return { ok: false, response: fail(400, "missing intentId — create one via POST /api/purchase-intents first") };
  }
  const intent = await getIntent(intentId);
  if (!intent) return { ok: false, response: fail(404, "purchase intent not found") };
  if (intent.actionType !== expectedActionType) {
    return { ok: false, response: fail(400, "this intent was not created for this action") };
  }
  if (intent.boardId !== null) {
    return { ok: false, response: fail(400, "this intent is for a Start Ads board — redeem it via POST /api/boards") };
  }
  // Wallet-bound: closes red-team requirement "payment attempted with
  // another wallet's intent_id must be REJECTED".
  if (intent.buyerWallet !== actor) {
    logAudit("authorization_failure", { action: expectedActionType, wallet: actor, reason: "intent belongs to a different wallet", intentId });
    return { ok: false, response: fail(403, "this purchase intent belongs to a different wallet") };
  }
  if (intent.status !== "pending") {
    return { ok: false, response: fail(409, `this intent is ${intent.status}, not pending`) };
  }
  // Time-bound: closes red-team requirement "payment with an expired
  // intent must be REJECTED".
  if (intent.expiresAt <= Date.now()) {
    return { ok: false, response: fail(410, "this purchase intent has expired — create a new one") };
  }
  // Defense in depth: POST /api/purchase-intents already refuses to create
  // a self-targeting intent, so this can only fire if that invariant is
  // ever broken elsewhere.
  if (intent.buyerWallet === intent.sellerWallet) {
    return { ok: false, response: fail(400, "you already own this spot") };
  }
  return { ok: true, intent };
}

// ---------------------------------------------------------------------------
// buy — one brand-new spot, paid at the CURRENT bonding-curve price to the
// treasury. Price is recomputed server-side from the live sold count; the
// client's displayed price is only ever a preview.
// ---------------------------------------------------------------------------
async function handleBuy(body: Record<string, unknown>, actor: string, ip: string) {
  if (isRateLimited(`pixels-buy:${ip}`, 20, 60_000)) return fail(429, "Too many purchase attempts — slow down.");
  const treasury = requireTreasury();
  if (!treasury) return fail(500, "Treasury not configured — set NEXT_PUBLIC_TREASURY_ADDRESS");

  const index = body.index;
  if (!isValidIndex(index)) return fail(400, "invalid index");
  const signature = body.signature;
  if (typeof signature !== "string" || !signature) return fail(400, "missing signature");
  const ad = readAd(body);
  if (isAdValidationError(ad)) return fail(400, `${ad.field}: ${ad.reason}`);

  return withWriteLock(async () => {
    const existing = await getPixel(index);
    if (existing) return fail(409, "that spot was just sold — pick another");

    const currentSoldCount = await soldCount();
    const priceSol = nextSpotPrice(currentSoldCount);
    const minLamports = solRequiredLamportsWithTolerance(priceSol);

    const verified = await verifySolTransfer({ signature, fromOwner: actor, toOwner: treasury, minLamports });
    if (!verified.ok) {
      logAudit("payment_verification_failed", { action: "buy", wallet: actor, reason: verified.error });
      return fail(402, `payment not verified: ${verified.error}`);
    }
    logAudit("payment_verified", { action: "buy", wallet: actor, index });
    // SOL-98 Phase 6 (BULGU 1): the REAL verified lamport amount, not this
    // request's own possibly-stale price guess — insertPixelsAtomic's RPC
    // re-derives the true price under a cross-instance lock and rejects if
    // this falls short. See lib/server/verify-tx.ts's lamportsFound doc.
    const paidLamports = verified.lamportsFound ?? minLamports;

    const firstUse = await claimSignature(signature);
    if (!firstUse) {
      logAudit("duplicate_transaction_detected", { action: "buy", wallet: actor, where: "used_signatures" });
      return fail(409, "this transaction signature was already used");
    }

    const pixel: PixelData = {
      index,
      owner: actor,
      destination: ad.destination,
      imageUrl: ad.imageUrl,
      message: ad.message,
      neon: ad.neon,
      valuationSol: priceSol,
      purchasedAt: Date.now(),
      protectedUntil: Date.now() + HIJACK_COOLDOWN_MS,
      isRented: false,
    };

    // SOL-98 Phase 2.1 (fixes P2-F2): a THROWN error here — a real DB/infra
    // failure, not a clean "index already taken" conflict — must not
    // permanently burn a signature that already paid the treasury. Release
    // it and preserve the original error before it reaches the outer
    // try/catch, so the SAME signature is retryable once the failure
    // clears. See docs/production-readiness/PHASE-2.1-P2-F2-FIX.md.
    // SOL-98 Phase 4 (fixes P2-F4 for the treasury paths — GÖREV 2): the
    // pixel row INSERT, the payment_transactions INSERT, and the
    // pixel_ownership_history INSERT now happen in ONE Postgres transaction
    // (see lib/server/pixel-insert-atomic.ts) instead of one insert
    // followed by two separate best-effort ledger writes.
    let created: Awaited<ReturnType<typeof insertPixelsAtomic>>;
    try {
      created = await insertPixelsAtomic({ pixels: [pixel], signature, wallet: actor, action: "buy", amountSol: priceSol, paidLamports });
    } catch (error) {
      await releaseSignatureSafely(signature, { action: "buy", wallet: actor, index });
      logAudit("db_failure", {
        where: "insertPixelsAtomic",
        action: "buy",
        wallet: actor,
        index,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    if (!created.ok) {
      await releaseSignatureSafely(signature, { action: "buy", wallet: actor, index });
      if (created.reason === "underpaid") {
        // SOL-98 Phase 6 (BULGU 1): the race this closes — a concurrent
        // purchase committed first, so the REAL price at this request's
        // actual turn (recomputed fresh, under lock, inside the RPC) was
        // higher than what this signature's payment covers.
        logAudit("ownership_conflict", { action: "buy", wallet: actor, index, reason: "underpaid" });
        return fail(
          409,
          "the price moved before your purchase landed (someone bought ahead of you in the queue) — your payment proof is still valid, please check the current price and retry"
        );
      }
      logAudit("ownership_conflict", { action: "buy", wallet: actor, index });
      return fail(409, "that spot was just sold — pick another, your payment proof is still valid to retry");
    }
    return NextResponse.json({ ok: true, pixel });
  });
}

// ---------------------------------------------------------------------------
// buy-area — a rectangle of brand-new spots as one banner, paid at the true
// integrated bonding-curve price (see lib/pricing.ts areaPrice).
// ---------------------------------------------------------------------------
async function handleBuyArea(body: Record<string, unknown>, actor: string, ip: string) {
  if (isRateLimited(`pixels-buy:${ip}`, 20, 60_000)) return fail(429, "Too many purchase attempts — slow down.");
  const treasury = requireTreasury();
  if (!treasury) return fail(500, "Treasury not configured — set NEXT_PUBLIC_TREASURY_ADDRESS");

  const indices = body.indices;
  if (!Array.isArray(indices) || !isValidRectangle(indices as number[])) {
    return fail(400, "indices must form a valid, gap-free rectangle within the board");
  }
  const typedIndices = indices as number[];
  const signature = body.signature;
  if (typeof signature !== "string" || !signature) return fail(400, "missing signature");
  const ad = readAd(body);
  if (isAdValidationError(ad)) return fail(400, `${ad.field}: ${ad.reason}`);

  return withWriteLock(async () => {
    const currentSoldCount = await soldCount();
    const priceSol = areaPrice(currentSoldCount, typedIndices.length);
    const minLamports = solRequiredLamportsWithTolerance(priceSol);

    const verified = await verifySolTransfer({ signature, fromOwner: actor, toOwner: treasury, minLamports });
    if (!verified.ok) {
      logAudit("payment_verification_failed", { action: "buy-area", wallet: actor, reason: verified.error });
      return fail(402, `payment not verified: ${verified.error}`);
    }
    logAudit("payment_verified", { action: "buy-area", wallet: actor, count: typedIndices.length });
    // SOL-98 Phase 6 (BULGU 1) — see handleBuy's identical comment.
    const paidLamports = verified.lamportsFound ?? minLamports;

    const firstUse = await claimSignature(signature);
    if (!firstUse) {
      logAudit("duplicate_transaction_detected", { action: "buy-area", wallet: actor, where: "used_signatures" });
      return fail(409, "this transaction signature was already used");
    }

    const layout = computeBannerLayout(typedIndices, BOARD_SIZE);
    const groupId = `b-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const now = Date.now();
    const pixels: PixelData[] = typedIndices.map((index) => ({
      index,
      owner: actor,
      destination: ad.destination,
      imageUrl: ad.imageUrl,
      message: ad.message,
      neon: ad.neon,
      valuationSol: nextSpotPrice(currentSoldCount), // per-block reference valuation for future hijack pricing
      purchasedAt: now,
      protectedUntil: now + HIJACK_COOLDOWN_MS,
      isRented: false,
      bannerGroupId: groupId,
      bannerCols: layout.cols,
      bannerRows: layout.rows,
      ...bannerPosition(index, BOARD_SIZE, layout),
    }));

    // SOL-98 Phase 2.1 (fixes P2-F2) — same reasoning as handleBuy: a thrown
    // error must release the signature and preserve the original error.
    // SOL-98 Phase 4 (fixes P2-F4 for the treasury paths — GÖREV 2) — same
    // atomic INSERT+ledger RPC as handleBuy above.
    let created: Awaited<ReturnType<typeof insertPixelsAtomic>>;
    try {
      created = await insertPixelsAtomic({ pixels, signature, wallet: actor, action: "buy-area", amountSol: priceSol, paidLamports });
    } catch (error) {
      await releaseSignatureSafely(signature, { action: "buy-area", wallet: actor, count: typedIndices.length });
      logAudit("db_failure", {
        where: "insertPixelsAtomic",
        action: "buy-area",
        wallet: actor,
        count: typedIndices.length,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    if (!created.ok) {
      await releaseSignatureSafely(signature, { action: "buy-area", wallet: actor, taken: created.taken.length });
      if (created.reason === "underpaid") {
        logAudit("ownership_conflict", { action: "buy-area", wallet: actor, reason: "underpaid" });
        return fail(
          409,
          "the price moved before your purchase landed (someone bought ahead of you in the queue) — your payment proof is still valid, please check the current price and retry"
        );
      }
      logAudit("ownership_conflict", { action: "buy-area", wallet: actor, taken: created.taken.length });
      return fail(
        409,
        `${created.taken.length} of those spots were just sold (#${created.taken.map((i) => i + 1).join(", #")}) — pick another area, your payment proof is still valid to retry`
      );
    }
    return NextResponse.json({ ok: true, pixels });
  });
}

// ---------------------------------------------------------------------------
// hijack — overtake an existing spot. Once $PIXEL98 is live this REQUIRES a
// verified on-chain burn; before launch it's the documented "simulated"
// path, gated behind a signed wallet-ownership proof (not a bare POST) and
// a tight per-wallet rate limit, since it has zero real cost by design.
// ---------------------------------------------------------------------------
async function handleHijack(body: Record<string, unknown>, actor: string, ip: string) {
  const tokenLive = Boolean(PIXEL98_MINT); // server's own env check, never trust the client's claim

  // SOL-98 Phase 3 (fixes P2-F1 / GÖREV 2): once $PIXEL98 is live, a hijack
  // spends a real verified burn — the exact same substitution exposure as
  // buy-listing/rent — so it goes through the same purchase_intent system.
  // The pre-launch simulated path below is free (no on-chain payment at
  // all), so it keeps using body.index directly; there is nothing to
  // substitute a free action onto.
  if (tokenLive) {
    if (isRateLimited(`pixels-hijack:${ip}`, 20, 60_000)) return fail(429, "Too many hijack attempts — slow down.");
    const resolved = await resolveIntent(body, actor, "hijack");
    if (!resolved.ok) return resolved.response;
    const intent = resolved.intent;
    const index = intent.pixelIndex;
    const signature = body.signature;
    if (typeof signature !== "string" || !signature) return fail(400, "missing hijack transaction signature");

    return withWriteLock(async () => {
      const target = await getPixel(index);
      if (!target) return fail(404, "nothing to hijack there yet");
      if (target.owner === actor) return fail(400, "you already own this spot");
      // Defense in depth: the intent's recorded seller must still match the
      // LIVE owner — closes the staleness window without ever trusting the
      // client for who the compensation recipient is.
      if (target.owner !== intent.sellerWallet) {
        return fail(409, "that spot changed hands since your intent was created — please create a new intent");
      }
      const protectionError = hijackProtectionError(target.protectedUntil);
      if (protectionError) return protectionError;

      // Cost is ALWAYS recomputed fresh from the live burned fraction AND
      // the target's live valuation — never taken from the intent (see
      // app/api/purchase-intents/route.ts's doc comment on why hijack
      // intents don't lock in a price).
      const burnedFraction = await getBurnedFraction();
      const hijackCost = hijackCostInTokens(burnedFraction, target.valuationSol, INITIAL_PRICE_SOL);
      const split = splitHijackBurn(hijackCost);
      const burnRaw = await tokenAmountToRaw(PIXEL98_MINT, split.burnedTokens);
      const ownerRaw = await tokenAmountToRaw(PIXEL98_MINT, split.ownerTokens);

      const burnVerified = await verifyBurn({ signature, owner: actor, mint: PIXEL98_MINT, minRawAmount: burnRaw });
      if (!burnVerified.ok) {
        logAudit("payment_verification_failed", { action: "hijack", wallet: actor, reason: burnVerified.error });
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
        logAudit("payment_verification_failed", { action: "hijack", wallet: actor, reason: transferVerified.error });
        return fail(402, `owner compensation not verified: ${transferVerified.error}`);
      }
      logAudit("payment_verified", { action: "hijack", wallet: actor, index });

      const firstUse = await claimSignature(signature);
      if (!firstUse) {
        logAudit("duplicate_transaction_detected", { action: "hijack", wallet: actor, where: "used_signatures" });
        return fail(409, "this hijack transaction signature was already used");
      }

      const prevOwner = target.owner;
      // SOL-98 Phase 2.1 (fixes P2-F2) + Phase 3 GÖREV 3 (atomic ledger) — a
      // thrown error must release the signature and preserve the original
      // error, not silently burn a verified burn+transfer proof; a
      // successful mutation's ledger/history rows are now written in the
      // SAME Postgres transaction as the ownership change itself (see
      // pixel-mutations-atomic.ts).
      let result: Awaited<ReturnType<typeof updatePixelOwnerAtomic>>;
      try {
        result = await updatePixelOwnerAtomic({
          index,
          expectedOwner: prevOwner,
          mutate: (current) => applyHijack(current, actor),
          signature,
          wallet: actor,
          action: "hijack",
          mint: PIXEL98_MINT,
          intentId: intent.id,
          prevOwner,
          newOwner: actor,
          recordHistory: true,
        });
      } catch (error) {
        await releaseSignatureSafely(signature, { action: "hijack", wallet: actor, index });
        logAudit("db_failure", {
          where: "updatePixelOwnerAtomic",
          action: "hijack",
          wallet: actor,
          index,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
      if (!result.ok) {
        await releaseSignatureSafely(signature, { action: "hijack", wallet: actor, index });
        logAudit("ownership_conflict", { action: "hijack", wallet: actor, index });
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

  // Simulated (pre-launch) path — free, so require proof of wallet control
  // and hard rate-limit it per actor to blunt casual scripted abuse. No
  // purchase intent involved: nothing is paid, so there is nothing to
  // substitute a payment onto.
  const index = body.index;
  if (!isValidIndex(index)) return fail(400, "invalid index");
  const target = await getPixel(index);
  if (!target) return fail(404, "nothing to hijack there yet");
  if (target.owner === actor) return fail(400, "you already own this spot");
  const protectionError = hijackProtectionError(target.protectedUntil);
  if (protectionError) return protectionError;

  const burnedFraction = await getBurnedFraction();
  const hijackCost = hijackCostInTokens(burnedFraction, target.valuationSol, INITIAL_PRICE_SOL);
  const split = splitHijackBurn(hijackCost);

  if (isRateLimited(`pixels-hijack-sim:${actor}`, 5, 10 * 60_000)) {
    return fail(429, "Too many simulated hijacks from this wallet — try again later.");
  }
  const authCheck = readAuth(body, "hijack", index, actor);
  if (!authCheck.ok) return fail(401, authCheck.error);

  const prevOwnerSim = target.owner;
  const result = await hijackPixel(index, (current) => applyHijack(current, actor));
  if (!result.ok) {
    logAudit("ownership_conflict", { action: "hijack-simulated", wallet: actor, index });
    return fail(409, "that spot changed hands — please retry");
  }
  await recordOwnershipHistory({ pixelIndex: index, boardId: null, prevOwner: prevOwnerSim, newOwner: actor, action: "hijack" });
  return NextResponse.json({
    ok: true,
    pixel: result.pixel,
    simulated: true,
    hijack: { costTokens: hijackCost, burnedTokens: split.burnedTokens, ownerTokens: split.ownerTokens, burnedFraction },
  });
}

function applyHijack(current: PixelData, newOwner: string): PixelData {
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
    listingPricePixel98: undefined,
    rentPriceSol: undefined,
    rentPricePixel98: undefined,
    bannerGroupId: undefined,
    bannerCols: undefined,
    bannerRows: undefined,
    bannerX: undefined,
    bannerY: undefined,
  };
}

// ---------------------------------------------------------------------------
// Free, owner-only actions — no funds move, so instead of a tx signature
// these require a fresh wallet-signed auth message (see lib/auth-message.ts
// + lib/server/verify-message.ts). Ownership is re-checked against the
// STORED pixel, never against whatever the request claims.
// ---------------------------------------------------------------------------
function readAuth(body: Record<string, unknown>, action: string, index: number | number[], actor: string) {
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

async function handleEdit(body: Record<string, unknown>, actor: string) {
  const index = body.index;
  if (!isValidIndex(index)) return fail(400, "invalid index");
  const auth = readAuth(body, "edit", index, actor);
  if (!auth.ok) return fail(401, auth.error);
  const ad = readAd(body);
  if (isAdValidationError(ad)) return fail(400, `${ad.field}: ${ad.reason}`);

  const result = await updateOwnedPixel(index, actor, (current) => ({ ...current, ...ad }));
  if (!result.ok) return fail(result.reason === "not_owner" ? 403 : 404, result.reason);
  return NextResponse.json({ ok: true, pixel: result.pixel });
}

async function handleEditArea(body: Record<string, unknown>, actor: string) {
  const groupId = body.groupId;
  if (typeof groupId !== "string" || !groupId) return fail(400, "missing groupId");
  const auth = readAuth(body, "edit-area", -1, actor);
  if (!auth.ok) return fail(401, auth.error);
  const ad = readAd(body);
  if (isAdValidationError(ad)) return fail(400, `${ad.field}: ${ad.reason}`);

  const result = await updateGroupOwnedPixels(groupId, actor, (current) => ({ ...current, ...ad }));
  if (!result.ok) return fail(404, result.reason);
  return NextResponse.json({ ok: true, pixels: result.pixels });
}

async function handleListSale(body: Record<string, unknown>, actor: string) {
  const index = body.index;
  if (!isValidIndex(index)) return fail(400, "invalid index");
  const auth = readAuth(body, "list-sale", index, actor);
  if (!auth.ok) return fail(401, auth.error);
  const currency = body.currency === "PIXEL98" ? "PIXEL98" : "SOL";
  const price = body.price;
  if (typeof price !== "number" || !Number.isFinite(price) || price <= 0 || price > 1_000_000) {
    return fail(400, "invalid price");
  }

  const result = await updateOwnedPixel(index, actor, (current) => ({
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
  const index = body.index;
  if (!isValidIndex(index)) return fail(400, "invalid index");
  const auth = readAuth(body, "list-rent", index, actor);
  if (!auth.ok) return fail(401, auth.error);
  const currency = body.currency === "PIXEL98" ? "PIXEL98" : "SOL";
  const pricePerDay = body.pricePerDay;
  if (
    typeof pricePerDay !== "number" ||
    !Number.isFinite(pricePerDay) ||
    pricePerDay <= 0 ||
    pricePerDay > 1_000_000
  ) {
    return fail(400, "invalid pricePerDay");
  }

  const result = await updateOwnedPixel(index, actor, (current) => ({
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
  const index = body.index;
  if (!isValidIndex(index)) return fail(400, "invalid index");
  const auth = readAuth(body, "unlist", index, actor);
  if (!auth.ok) return fail(401, auth.error);

  const result = await updateOwnedPixel(index, actor, (current) => ({
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
// buy-listing / rent — PEER-TO-PEER payments. The buyer/renter pays the
// CURRENT owner directly (read fresh, inside the lock) — never the treasury.
// ---------------------------------------------------------------------------
async function handleBuyListing(body: Record<string, unknown>, actor: string, ip: string) {
  if (isRateLimited(`pixels-buy:${ip}`, 20, 60_000)) return fail(429, "Too many purchase attempts — slow down.");
  const resolved = await resolveIntent(body, actor, "buy-listing");
  if (!resolved.ok) return resolved.response;
  const intent = resolved.intent;
  const index = intent.pixelIndex;
  const signature = body.signature;
  if (typeof signature !== "string" || !signature) return fail(400, "missing signature");

  return withWriteLock(async () => {
    const current = await getPixel(index);
    if (!current) return fail(404, "spot not found");
    // Defense in depth: the live state must still match what the intent was
    // created against. This does not RE-TRUST anything from the client —
    // `seller` and `price` below always come from the intent, never from
    // this live read or from the request body; this is only a staleness
    // guard so a listing that changed (or was unlisted) between intent
    // creation and redemption fails cleanly instead of silently charging
    // the old terms.
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
        logAudit("payment_verification_failed", { action: "buy-listing", wallet: actor, reason: verified.error });
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
        logAudit("payment_verification_failed", { action: "buy-listing", wallet: actor, reason: verified.error });
        return fail(402, `payment not verified: ${verified.error}`);
      }
    }
    logAudit("payment_verified", { action: "buy-listing", wallet: actor, index });

    const firstUse = await claimSignature(signature);
    if (!firstUse) {
      logAudit("duplicate_transaction_detected", { action: "buy-listing", wallet: actor, where: "used_signatures" });
      return fail(409, "this transaction signature was already used");
    }

    // SOL-98 Phase 2.1 (fixes P2-F2) + Phase 3 GÖREV 1/3 (intent binding +
    // atomic ledger) — a thrown error must release the signature and
    // preserve the original error, not silently burn a verified peer-to-
    // peer payment; the ledger/history rows are now written in the SAME
    // Postgres transaction as the ownership change (pixel-mutations-atomic.ts),
    // and the intent is consumed in that same transaction too.
    let result: Awaited<ReturnType<typeof updatePixelOwnerAtomic>>;
    try {
      result = await updatePixelOwnerAtomic({
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
        action: "buy-listing",
        amountSol: paidPixel98 ? undefined : intent.priceSol,
        mint: paidPixel98 ? PIXEL98_MINT : null,
        intentId: intent.id,
        prevOwner: seller,
        newOwner: actor,
        recordHistory: true,
      });
    } catch (error) {
      await releaseSignatureSafely(signature, { action: "buy-listing", wallet: actor, index });
      logAudit("db_failure", {
        where: "updatePixelOwnerAtomic",
        action: "buy-listing",
        wallet: actor,
        index,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    if (!result.ok) {
      await releaseSignatureSafely(signature, { action: "buy-listing", wallet: actor, index });
      logAudit("ownership_conflict", { action: "buy-listing", wallet: actor, index });
      return fail(409, "this listing changed before your purchase landed — your payment proof is still valid to retry");
    }
    return NextResponse.json({ ok: true, pixel: result.pixel });
  });
}

// ---------------------------------------------------------------------------
// buy-valuation — an always-available direct purchase of ANY owned pixel at
// its current on-record valuationSol, in SOL, with no listing required from
// the owner. Mirrors handleBuyListing's payment-verification + atomic-
// mutation shape exactly; the two differences are (1) no "is this listed"
// gate, and (2) on success the valuation is bumped +10% (this — together
// with hijack's −5% HIJACK_VALUATION_DECAY — is the full buy/hijack cycle
// the whitepaper describes: a spot's price rises 10% whenever it's bought,
// and falls 5% whenever it's hijacked).
// ---------------------------------------------------------------------------
async function handleBuyValuation(body: Record<string, unknown>, actor: string, ip: string) {
  if (isRateLimited(`pixels-buy:${ip}`, 20, 60_000)) return fail(429, "Too many purchase attempts — slow down.");
  const resolved = await resolveIntent(body, actor, "buy-valuation");
  if (!resolved.ok) return resolved.response;
  const intent = resolved.intent;
  const index = intent.pixelIndex;
  const signature = body.signature;
  if (typeof signature !== "string" || !signature) return fail(400, "missing signature");

  return withWriteLock(async () => {
    const current = await getPixel(index);
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
      logAudit("payment_verification_failed", { action: "buy-valuation", wallet: actor, reason: verified.error });
      return fail(402, `payment not verified: ${verified.error}`);
    }
    logAudit("payment_verified", { action: "buy-valuation", wallet: actor, index });

    const firstUse = await claimSignature(signature);
    if (!firstUse) {
      logAudit("duplicate_transaction_detected", { action: "buy-valuation", wallet: actor, where: "used_signatures" });
      return fail(409, "this transaction signature was already used");
    }

    let result: Awaited<ReturnType<typeof updatePixelOwnerAtomic>>;
    try {
      result = await updatePixelOwnerAtomic({
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
        action: "buy-valuation",
        amountSol: intent.priceSol,
        mint: null,
        intentId: intent.id,
        prevOwner: seller,
        newOwner: actor,
        recordHistory: true,
      });
    } catch (error) {
      await releaseSignatureSafely(signature, { action: "buy-valuation", wallet: actor, index });
      logAudit("db_failure", {
        where: "updatePixelOwnerAtomic",
        action: "buy-valuation",
        wallet: actor,
        index,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    if (!result.ok) {
      await releaseSignatureSafely(signature, { action: "buy-valuation", wallet: actor, index });
      logAudit("ownership_conflict", { action: "buy-valuation", wallet: actor, index });
      return fail(409, "this spot changed hands before your purchase landed — your payment proof is still valid to retry");
    }
    return NextResponse.json({ ok: true, pixel: result.pixel });
  });
}

async function handleRent(body: Record<string, unknown>, actor: string, ip: string) {
  if (isRateLimited(`pixels-buy:${ip}`, 20, 60_000)) return fail(429, "Too many purchase attempts — slow down.");
  const resolved = await resolveIntent(body, actor, "rent");
  if (!resolved.ok) return resolved.response;
  const intent = resolved.intent;
  const index = intent.pixelIndex;
  const days = intent.rentDays ?? 0; // committed at intent creation, never re-read from the body
  const signature = body.signature;
  if (typeof signature !== "string" || !signature) return fail(400, "missing signature");

  return withWriteLock(async () => {
    const current = await getPixel(index);
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
      // Staleness guard: recompute the total from the LIVE per-day rate and
      // the intent-committed day count, and require it to still match what
      // was locked in at intent creation.
      if (current.rentPriceSol * days !== priceSol) {
        return fail(409, "the rent price changed since your intent was created — please create a new intent");
      }
      const minLamports = solRequiredLamportsWithTolerance(priceSol);
      const verified = await verifySolTransfer({ signature, fromOwner: actor, toOwner: owner, minLamports });
      if (!verified.ok) {
        logAudit("payment_verification_failed", { action: "rent", wallet: actor, reason: verified.error });
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
        logAudit("payment_verification_failed", { action: "rent", wallet: actor, reason: verified.error });
        return fail(402, `payment not verified: ${verified.error}`);
      }
    }
    logAudit("payment_verified", { action: "rent", wallet: actor, index });

    const firstUse = await claimSignature(signature);
    if (!firstUse) {
      logAudit("duplicate_transaction_detected", { action: "rent", wallet: actor, where: "used_signatures" });
      return fail(409, "this transaction signature was already used");
    }

    // SOL-98 Phase 2.1 (fixes P2-F2) + Phase 3 GÖREV 1/3 — same reasoning as
    // handleBuyListing.
    let result: Awaited<ReturnType<typeof updatePixelOwnerAtomic>>;
    try {
      result = await updatePixelOwnerAtomic({
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
        action: "rent",
        amountSol: paidPixel98 ? undefined : intent.priceSol,
        mint: paidPixel98 ? PIXEL98_MINT : null,
        intentId: intent.id,
        // Rent changes usage rights (rentedTo/rentedUntil), not `owner` —
        // no ownership_history entry (see ownership-history.ts doc
        // comment); still recorded in payment_transactions as a real
        // payment, atomically with the mutation.
        prevOwner: owner,
        newOwner: owner,
        recordHistory: false,
      });
    } catch (error) {
      await releaseSignatureSafely(signature, { action: "rent", wallet: actor, index });
      logAudit("db_failure", {
        where: "updatePixelOwnerAtomic",
        action: "rent",
        wallet: actor,
        index,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    if (!result.ok) {
      await releaseSignatureSafely(signature, { action: "rent", wallet: actor, index });
      logAudit("ownership_conflict", { action: "rent", wallet: actor, index });
      return fail(409, "this listing changed before your rental landed — your payment proof is still valid to retry");
    }
    return NextResponse.json({ ok: true, pixel: result.pixel });
  });
}
