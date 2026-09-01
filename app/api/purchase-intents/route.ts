import { PublicKey } from "@solana/web3.js";
import { NextResponse } from "next/server";

import { getPixel } from "@/lib/server/pixel-db";
import { getBoardPixel } from "@/lib/server/board-db";
import { createIntent, type IntentActionType } from "@/lib/server/intent-db";
import { getBurnedFraction } from "@/lib/server/token-stats";
import { isRateLimited, requestIp } from "@/lib/server/rate-limit";
import { logAudit } from "@/lib/server/audit-log";
import { hijackCostInTokens, splitHijackBurn } from "@/lib/token";
import { PIXEL98_MINT } from "@/lib/solana";
import { INITIAL_PRICE_SOL, TOTAL_SPOTS } from "@/lib/pricing";
import { BOARD_BLOCK_BASE_SOL, BOARD_FILE_BLOCKS } from "@/lib/board-types";

// SOL-98 Phase 3 (MARKET SECURITY) — GÖREV 1/2: the fix for finding P2-F1
// (transaction substitution — see docs/production-readiness/
// PHASE-2-PAYMENT-SECURITY.md and PHASE-3-MARKET-SECURITY.md).
//
// Required flow (this route is steps 1-4 of it):
//   1. client asks to buy/rent/hijack a SPECIFIC pixel at its CURRENT price
//   2/3. this route re-reads the LIVE pixel/board-pixel state itself — the
//        listing/rent price and the seller are taken EXCLUSIVELY from that
//        live read, never from anything the client sends in the body — and
//        creates a `purchase_intents` row binding
//        (action_type, board_id, pixel_index, buyer_wallet, seller_wallet,
//        price, expires_at, status='pending').
//   4. the intent's id is returned to the client.
//   5. the client references this intent_id when it builds/sends its
//      Solana transaction and again when it calls back into
//      /api/pixels or /api/boards to redeem it.
//   6. at redemption, those routes act SOLELY on the stored intent record —
//      see the "memo vs. server-side nonce" discussion in
//      docs/production-readiness/PHASE-3-MARKET-SECURITY.md for why this
//      (a server-side reservation) was chosen over an on-chain spl-memo or
//      a server partial-signature.
//
// hijack intents deliberately do NOT lock in a cost: hijackCostInTokens()
// is a function of the continuously-moving global burnedFraction, and
// Phase 2 already established the principle that the server always
// recomputes price fresh from live state rather than trusting anything
// cached — an intent-locked hijack price would be exactly that kind of
// stale, trusted value. The `hijackCostTokens` figure returned here is an
// informational preview only; app/api/pixels/route.ts and
// app/api/boards/route.ts recompute the real cost at redemption time.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const INTENT_TTL_MS = 15 * 60_000; // 15 minutes

function fail(status: number, error: string) {
  return NextResponse.json({ error }, { status });
}

function parsePubkey(value: unknown): PublicKey | null {
  if (typeof value !== "string" || !value) return null;
  try {
    return new PublicKey(value);
  } catch {
    return null;
  }
}

function isValidIndexFor(value: unknown, limit: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < limit;
}

const ACTION_TYPES: IntentActionType[] = ["buy-listing", "rent", "hijack", "buy-valuation"];

export async function POST(request: Request) {
  const ip = requestIp(request);
  if (isRateLimited(`purchase-intents:${ip}`, 60, 60_000)) {
    return fail(429, "Too many requests — slow down and try again in a minute.");
  }

  let body: Record<string, unknown>;
  try {
    const text = await request.text();
    if (text.length > 100_000) return fail(413, "payload too large");
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return fail(400, "invalid JSON body");
  }

  const actorKey = parsePubkey(body.actor);
  if (!actorKey) return fail(400, "missing or invalid actor pubkey");
  const actor = actorKey.toBase58();

  const actionType = body.actionType;
  if (typeof actionType !== "string" || !ACTION_TYPES.includes(actionType as IntentActionType)) {
    return fail(400, `actionType must be one of ${ACTION_TYPES.join(", ")}`);
  }

  // boardId is optional: absent/null = main pixel board, a string = a
  // specific Start Ads board.exe file. Never trust anything else about the
  // target beyond WHICH (board, index) — the price/seller always comes from
  // the live read below.
  const boardIdRaw = body.boardId;
  const boardId = typeof boardIdRaw === "string" && boardIdRaw.length > 0 ? boardIdRaw : null;
  if (boardIdRaw !== undefined && boardIdRaw !== null && boardId === null) {
    return fail(400, "invalid boardId");
  }

  const indexLimit = boardId === null ? TOTAL_SPOTS : BOARD_FILE_BLOCKS;
  const index = body.index;
  if (!isValidIndexFor(index, indexLimit)) return fail(400, "invalid index");

  try {
    const current = boardId === null ? await getPixel(index) : await getBoardPixel(boardId, index);
    if (!current) return fail(404, "spot not found");
    if (current.owner === actor) return fail(400, "you already own this spot");

    if (actionType === "buy-listing") {
      if (current.listingPriceSol === undefined && current.listingPricePixel98 === undefined) {
        return fail(400, "spot is not listed for sale");
      }
      const currency: "SOL" | "PIXEL98" = current.listingPriceSol !== undefined ? "SOL" : "PIXEL98";
      if (currency === "PIXEL98" && !PIXEL98_MINT) {
        return fail(503, "$PIXEL98 not live yet — this listing can't be paid until launch");
      }
      const intent = await createIntent({
        actionType: "buy-listing",
        boardId,
        pixelIndex: index,
        buyerWallet: actor,
        sellerWallet: current.owner,
        currency,
        priceSol: currency === "SOL" ? current.listingPriceSol : undefined,
        pricePixel98: currency === "PIXEL98" ? current.listingPricePixel98 : undefined,
        mint: currency === "PIXEL98" ? PIXEL98_MINT : null,
        ttlMs: INTENT_TTL_MS,
      });
      logAudit("intent_created", { actionType, wallet: actor, boardId, index, intentId: intent.id });
      return NextResponse.json({
        ok: true,
        intentId: intent.id,
        expiresAt: intent.expiresAt,
        currency,
        price: currency === "SOL" ? intent.priceSol : intent.pricePixel98,
        // SOL-98 Phase 4 (GÖREV 1) — the client needs the AUTHORITATIVE
        // seller wallet (this route's own live read, never anything the
        // client sent) to address its peer-to-peer payment transaction to.
        // Reading it back off this response instead of off a possibly-stale
        // local cache closes a correctness gap, not a security one — the
        // redemption routes (handleBuyListing/handleRent/handleHijack)
        // still re-verify the payment against intent.sellerWallet
        // server-side regardless of what the client actually sent it to.
        sellerWallet: intent.sellerWallet,
      });
    }

    if (actionType === "rent") {
      if (current.rentPriceSol === undefined && current.rentPricePixel98 === undefined) {
        return fail(400, "spot is not listed for rent");
      }
      const days = body.days;
      if (typeof days !== "number" || !Number.isInteger(days) || days <= 0 || days > 365) {
        return fail(400, "invalid days (1-365)");
      }
      const currency: "SOL" | "PIXEL98" = current.rentPriceSol !== undefined ? "SOL" : "PIXEL98";
      if (currency === "PIXEL98" && !PIXEL98_MINT) {
        return fail(503, "$PIXEL98 not live yet — this listing can't be paid until launch");
      }
      const priceSol = currency === "SOL" ? (current.rentPriceSol ?? 0) * days : undefined;
      const pricePixel98 = currency === "PIXEL98" ? (current.rentPricePixel98 ?? 0) * days : undefined;
      const intent = await createIntent({
        actionType: "rent",
        boardId,
        pixelIndex: index,
        buyerWallet: actor,
        sellerWallet: current.owner,
        currency,
        priceSol,
        pricePixel98,
        mint: currency === "PIXEL98" ? PIXEL98_MINT : null,
        rentDays: days,
        ttlMs: INTENT_TTL_MS,
      });
      logAudit("intent_created", { actionType, wallet: actor, boardId, index, intentId: intent.id });
      return NextResponse.json({
        ok: true,
        intentId: intent.id,
        expiresAt: intent.expiresAt,
        currency,
        price: currency === "SOL" ? intent.priceSol : intent.pricePixel98,
        days,
        sellerWallet: intent.sellerWallet,
      });
    }

    // buy-valuation — an always-available direct purchase of ANY owned spot
    // at its current on-record valuationSol, no listing required. Unlike
    // buy-listing, the PRICE itself is derived from live state (the spot's
    // valuation), not from a value the owner set — so, like hijack, it's
    // read fresh here and used to build the intent; it does NOT need to be
    // re-validated against a client-submitted figure the way listing prices
    // are, because there is no other source it could have come from.
    if (actionType === "buy-valuation") {
      const intent = await createIntent({
        actionType: "buy-valuation",
        boardId,
        pixelIndex: index,
        buyerWallet: actor,
        sellerWallet: current.owner,
        currency: "SOL",
        priceSol: current.valuationSol,
        ttlMs: INTENT_TTL_MS,
      });
      logAudit("intent_created", { actionType, wallet: actor, boardId, index, intentId: intent.id });
      return NextResponse.json({
        ok: true,
        intentId: intent.id,
        expiresAt: intent.expiresAt,
        currency: "SOL",
        price: intent.priceSol,
        sellerWallet: intent.sellerWallet,
      });
    }

    // hijack — see the module doc comment: no price is locked into the
    // intent, only WHICH spot and WHO the (informational, re-verified fresh
    // at redemption) compensation recipient is.
    if (!PIXEL98_MINT) {
      return fail(503, "$PIXEL98 not live yet — hijack can't be paid until launch");
    }
    const burnedFraction = await getBurnedFraction();
    const referenceSol = boardId === null ? INITIAL_PRICE_SOL : BOARD_BLOCK_BASE_SOL;
    const hijackCost = hijackCostInTokens(burnedFraction, current.valuationSol, referenceSol);
    const split = splitHijackBurn(hijackCost);
    const intent = await createIntent({
      actionType: "hijack",
      boardId,
      pixelIndex: index,
      buyerWallet: actor,
      sellerWallet: current.owner,
      currency: "PIXEL98",
      mint: PIXEL98_MINT,
      ttlMs: INTENT_TTL_MS,
    });
    logAudit("intent_created", { actionType, wallet: actor, boardId, index, intentId: intent.id });
    return NextResponse.json({
      ok: true,
      intentId: intent.id,
      expiresAt: intent.expiresAt,
      currency: "PIXEL98",
      hijackCostTokensPreview: hijackCost,
      burnedTokensPreview: split.burnedTokens,
      ownerTokensPreview: split.ownerTokens,
      sellerWallet: intent.sellerWallet,
      note: "hijack cost is recomputed fresh from the live burned fraction when you redeem this intent — this figure is a preview only",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "request failed";
    logAudit("db_failure", { where: "purchase-intents POST", action: actionType, error: message });
    return fail(500, message);
  }
}
