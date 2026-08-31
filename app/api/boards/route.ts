import { PublicKey } from "@solana/web3.js";
import { NextResponse } from "next/server";

import {
  countBoardFiles,
  createBoard,
  getBoardPixel,
  hijackBoardPixel,
  makeSubBlocks,
  readAllBoards,
  renameBoardFile,
  updateBoardPixel,
} from "@/lib/server/board-db";
import { claimSignature, releaseSignature } from "@/lib/server/used-signatures";
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
import { HIJACK_VALUATION_DECAY, hijackCostInTokens, splitHijackBurn } from "@/lib/token";
import { PIXEL98_MINT, TREASURY_ADDRESS } from "@/lib/solana";
import {
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
    return fail(500, error instanceof Error ? error.message : "request failed");
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

function readAuth(body: Record<string, unknown>, action: string, index: number, actor: string) {
  const timestamp = body.authTimestamp;
  const signature = body.authSignature;
  if (typeof timestamp !== "number" || typeof signature !== "string" || !signature) {
    return { ok: false as const, error: "missing auth proof" };
  }
  return verifyAuthProof({ action, index, owner: actor, timestamp, signature });
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
    if (!verified.ok) return fail(402, `payment not verified: ${verified.error}`);

    const firstUse = await claimSignature(signature);
    if (!firstUse) return fail(409, "this transaction signature was already used");

    const id = `b-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const now = Date.now();
    const file: BoardFile = { id, name, owner: actor, purchasedAt: now, priceSol };

    const created = await createBoard(file, makeSubBlocks(id, actor, now));
    if (!created.ok) {
      await releaseSignature(signature);
      return fail(409, "board creation conflict — please retry");
    }
    return NextResponse.json({ ok: true, file });
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
  const boardId = parseBoardId(body.boardId);
  if (!boardId) return fail(400, "missing or invalid boardId");
  const index = body.index;
  if (!isValidBoardIndex(index)) return fail(400, "invalid index");
  const signature = body.signature;
  if (typeof signature !== "string" || !signature) return fail(400, "missing signature");

  return withWriteLock(async () => {
    const current = await getBoardPixel(boardId, index);
    if (!current) return fail(404, "spot not found");
    if (current.listingPriceSol === undefined && current.listingPricePixel98 === undefined) {
      return fail(400, "spot is not listed for sale");
    }
    if (current.owner === actor) return fail(400, "you already own this spot");
    const seller = current.owner;

    if (current.listingPriceSol !== undefined) {
      const minLamports = solRequiredLamportsWithTolerance(current.listingPriceSol);
      const verified = await verifySolTransfer({ signature, fromOwner: actor, toOwner: seller, minLamports });
      if (!verified.ok) return fail(402, `payment not verified: ${verified.error}`);
    } else {
      if (!PIXEL98_MINT) return fail(503, "$PIXEL98 not live yet — this listing can't be paid until launch");
      const minRaw = await tokenAmountToRaw(PIXEL98_MINT, current.listingPricePixel98 ?? 0);
      const verified = await verifyTokenTransfer({ signature, fromOwner: actor, toOwner: seller, mint: PIXEL98_MINT, minRawAmount: minRaw });
      if (!verified.ok) return fail(402, `payment not verified: ${verified.error}`);
    }

    const firstUse = await claimSignature(signature);
    if (!firstUse) return fail(409, "this transaction signature was already used");

    const result = await updateBoardPixel(boardId, index, seller, (existing) => ({
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
    }));
    if (!result.ok) {
      await releaseSignature(signature);
      return fail(409, "this listing changed before your purchase landed — your payment proof is still valid to retry");
    }
    return NextResponse.json({ ok: true, pixel: result.pixel });
  });
}

async function handleRent(body: Record<string, unknown>, actor: string, ip: string) {
  if (isRateLimited(`boards-buy:${ip}`, 20, 60_000)) return fail(429, "Too many purchase attempts — slow down.");
  const boardId = parseBoardId(body.boardId);
  if (!boardId) return fail(400, "missing or invalid boardId");
  const index = body.index;
  if (!isValidBoardIndex(index)) return fail(400, "invalid index");
  const days = body.days;
  if (typeof days !== "number" || !Number.isInteger(days) || days <= 0 || days > 365) {
    return fail(400, "invalid days (1-365)");
  }
  const signature = body.signature;
  if (typeof signature !== "string" || !signature) return fail(400, "missing signature");

  return withWriteLock(async () => {
    const current = await getBoardPixel(boardId, index);
    if (!current) return fail(404, "spot not found");
    if (current.rentPriceSol === undefined && current.rentPricePixel98 === undefined) {
      return fail(400, "spot is not listed for rent");
    }
    if (current.owner === actor) return fail(400, "you already own this spot");
    const owner = current.owner;

    if (current.rentPriceSol !== undefined) {
      const minLamports = solRequiredLamportsWithTolerance(current.rentPriceSol * days);
      const verified = await verifySolTransfer({ signature, fromOwner: actor, toOwner: owner, minLamports });
      if (!verified.ok) return fail(402, `payment not verified: ${verified.error}`);
    } else {
      if (!PIXEL98_MINT) return fail(503, "$PIXEL98 not live yet — this listing can't be paid until launch");
      const minRaw = await tokenAmountToRaw(PIXEL98_MINT, (current.rentPricePixel98 ?? 0) * days);
      const verified = await verifyTokenTransfer({ signature, fromOwner: actor, toOwner: owner, mint: PIXEL98_MINT, minRawAmount: minRaw });
      if (!verified.ok) return fail(402, `payment not verified: ${verified.error}`);
    }

    const firstUse = await claimSignature(signature);
    if (!firstUse) return fail(409, "this transaction signature was already used");

    const result = await updateBoardPixel(boardId, index, owner, (existing) => ({
      ...existing,
      isRented: true,
      rentedTo: actor,
      rentedUntil: Date.now() + days * 24 * 60 * 60 * 1000,
      rentPriceSol: undefined,
      rentPricePixel98: undefined,
    }));
    if (!result.ok) {
      await releaseSignature(signature);
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
  const boardId = parseBoardId(body.boardId);
  if (!boardId) return fail(400, "missing or invalid boardId");
  const index = body.index;
  if (!isValidBoardIndex(index)) return fail(400, "invalid index");

  const target = await getBoardPixel(boardId, index);
  if (!target) return fail(404, "nothing to hijack there yet");
  if (target.owner === actor) return fail(400, "you already own this spot");

  const burnedFraction = await getBurnedFraction();
  const hijackCost = hijackCostInTokens(burnedFraction);
  const split = splitHijackBurn(hijackCost);
  const tokenLive = Boolean(PIXEL98_MINT);

  if (tokenLive) {
    if (isRateLimited(`boards-hijack:${ip}`, 20, 60_000)) return fail(429, "Too many hijack attempts — slow down.");
    const signature = body.signature;
    if (typeof signature !== "string" || !signature) return fail(400, "missing hijack transaction signature");

    return withWriteLock(async () => {
      const burnRaw = await tokenAmountToRaw(PIXEL98_MINT, split.burnedTokens);
      const ownerRaw = await tokenAmountToRaw(PIXEL98_MINT, split.ownerTokens);

      const burnVerified = await verifyBurn({ signature, owner: actor, mint: PIXEL98_MINT, minRawAmount: burnRaw });
      if (!burnVerified.ok) return fail(402, `burn not verified: ${burnVerified.error}`);

      const transferVerified = await verifyTokenTransfer({
        signature,
        fromOwner: actor,
        toOwner: target.owner,
        mint: PIXEL98_MINT,
        minRawAmount: ownerRaw,
      });
      if (!transferVerified.ok) return fail(402, `owner compensation not verified: ${transferVerified.error}`);

      const firstUse = await claimSignature(signature);
      if (!firstUse) return fail(409, "this hijack transaction signature was already used");

      const result = await hijackBoardPixel(boardId, index, (current) => applyHijack(current, actor));
      if (!result.ok) {
        await releaseSignature(signature);
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

  // Simulated (pre-launch) — free, wallet-signed + rate-limited.
  if (isRateLimited(`boards-hijack-sim:${actor}`, 5, 10 * 60_000)) {
    return fail(429, "Too many simulated hijacks from this wallet — try again later.");
  }
  const authCheck = readAuth(body, "board-hijack", index, actor);
  if (!authCheck.ok) return fail(401, authCheck.error);

  const result = await hijackBoardPixel(boardId, index, (current) => applyHijack(current, actor));
  if (!result.ok) return fail(409, "that spot changed hands — please retry");
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
    isRented: false,
    rentedTo: undefined,
    rentedUntil: undefined,
    listingPriceSol: undefined,
    rentPriceSol: undefined,
    listingPricePixel98: undefined,
    rentPricePixel98: undefined,
  };
}
