import { PublicKey } from "@solana/web3.js";
import { NextResponse } from "next/server";

import {
  createPixels,
  getPixel,
  hijackPixel,
  readAllPixels,
  soldCount,
  updateGroupOwnedPixels,
  updateOwnedPixel,
} from "@/lib/server/pixel-db";
import { claimSignature, releaseSignature } from "@/lib/server/used-signatures";
import { verifyAuthProof } from "@/lib/server/verify-message";
import { solRequiredLamportsWithTolerance, tokenAmountToRaw, verifyBurn, verifySolTransfer } from "@/lib/server/verify-tx";
import { isRateLimited, requestIp } from "@/lib/server/rate-limit";
import { createMutex } from "@/lib/server/mutex";
import { areaPrice, BOARD_SIZE, nextSpotPrice, TOTAL_SPOTS } from "@/lib/pricing";
import { HIJACK_VALUATION_DECAY, hijackCostInTokens } from "@/lib/token";
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
    return NextResponse.json({ pixels });
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
      case "rent":
        return await handleRent(body, actor, ip);
      default:
        return fail(400, `unknown action "${action}"`);
    }
  } catch (error) {
    return fail(500, error instanceof Error ? error.message : "request failed");
  }
}

function readAd(body: Record<string, unknown>) {
  return sanitizeAdContent(body.ad);
}

function requireTreasury(): string | null {
  return TREASURY_ADDRESS || null;
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
    if (!verified.ok) return fail(402, `payment not verified: ${verified.error}`);

    const firstUse = await claimSignature(signature);
    if (!firstUse) return fail(409, "this transaction signature was already used");

    const pixel: PixelData = {
      index,
      owner: actor,
      destination: ad.destination,
      imageUrl: ad.imageUrl,
      message: ad.message,
      neon: ad.neon,
      valuationSol: priceSol,
      purchasedAt: Date.now(),
      isRented: false,
    };

    const created = await createPixels([pixel]);
    if (!created.ok) {
      await releaseSignature(signature);
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
    if (!verified.ok) return fail(402, `payment not verified: ${verified.error}`);

    const firstUse = await claimSignature(signature);
    if (!firstUse) return fail(409, "this transaction signature was already used");

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
      isRented: false,
      bannerGroupId: groupId,
      bannerCols: layout.cols,
      bannerRows: layout.rows,
      ...bannerPosition(index, BOARD_SIZE, layout),
    }));

    const created = await createPixels(pixels);
    if (!created.ok) {
      await releaseSignature(signature);
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
  const index = body.index;
  if (!isValidIndex(index)) return fail(400, "invalid index");

  const target = await getPixel(index);
  if (!target) return fail(404, "nothing to hijack there yet");
  if (target.owner === actor) return fail(400, "you already own this spot");

  const hijackCost = hijackCostInTokens(target.valuationSol);
  const tokenLive = Boolean(PIXEL98_MINT); // server's own env check, never trust the client's claim

  if (tokenLive) {
    if (isRateLimited(`pixels-hijack:${ip}`, 20, 60_000)) return fail(429, "Too many hijack attempts — slow down.");
    const signature = body.signature;
    if (typeof signature !== "string" || !signature) return fail(400, "missing burn signature");

    return withWriteLock(async () => {
      const minRawAmount = await tokenAmountToRaw(PIXEL98_MINT, hijackCost);
      const verified = await verifyBurn({ signature, owner: actor, mint: PIXEL98_MINT, minRawAmount });
      if (!verified.ok) return fail(402, `burn not verified: ${verified.error}`);

      const firstUse = await claimSignature(signature);
      if (!firstUse) return fail(409, "this burn signature was already used");

      const result = await hijackPixel(index, (current) => applyHijack(current, actor));
      if (!result.ok) {
        await releaseSignature(signature);
        return fail(409, "that spot changed hands before your hijack landed — please retry");
      }
      return NextResponse.json({ ok: true, pixel: result.pixel, simulated: false });
    });
  }

  // Simulated (pre-launch) path — free, so require proof of wallet control
  // and hard rate-limit it per actor to blunt casual scripted abuse.
  if (isRateLimited(`pixels-hijack-sim:${actor}`, 5, 10 * 60_000)) {
    return fail(429, "Too many simulated hijacks from this wallet — try again later.");
  }
  const authCheck = readAuth(body, "hijack", index, actor);
  if (!authCheck.ok) return fail(401, authCheck.error);

  const result = await hijackPixel(index, (current) => applyHijack(current, actor));
  if (!result.ok) return fail(409, "that spot changed hands — please retry");
  return NextResponse.json({ ok: true, pixel: result.pixel, simulated: true });
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
    isRented: false,
    rentedTo: undefined,
    rentedUntil: undefined,
    listingPriceSol: undefined,
    rentPriceSol: undefined,
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
    return { ok: false as const, error: "missing auth proof" };
  }
  return verifyAuthProof({ action, index, owner: actor, timestamp, signature });
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
  const priceSol = body.priceSol;
  if (typeof priceSol !== "number" || !Number.isFinite(priceSol) || priceSol <= 0 || priceSol > 1_000_000) {
    return fail(400, "invalid priceSol");
  }

  const result = await updateOwnedPixel(index, actor, (current) => ({
    ...current,
    listingPriceSol: priceSol,
    rentPriceSol: undefined,
  }));
  if (!result.ok) return fail(result.reason === "not_owner" ? 403 : 404, result.reason);
  return NextResponse.json({ ok: true, pixel: result.pixel });
}

async function handleListRent(body: Record<string, unknown>, actor: string) {
  const index = body.index;
  if (!isValidIndex(index)) return fail(400, "invalid index");
  const auth = readAuth(body, "list-rent", index, actor);
  if (!auth.ok) return fail(401, auth.error);
  const priceSolPerDay = body.priceSolPerDay;
  if (
    typeof priceSolPerDay !== "number" ||
    !Number.isFinite(priceSolPerDay) ||
    priceSolPerDay <= 0 ||
    priceSolPerDay > 1_000_000
  ) {
    return fail(400, "invalid priceSolPerDay");
  }

  const result = await updateOwnedPixel(index, actor, (current) => ({
    ...current,
    rentPriceSol: priceSolPerDay,
    listingPriceSol: undefined,
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
    rentPriceSol: undefined,
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
  const index = body.index;
  if (!isValidIndex(index)) return fail(400, "invalid index");
  const signature = body.signature;
  if (typeof signature !== "string" || !signature) return fail(400, "missing signature");

  return withWriteLock(async () => {
    const current = await getPixel(index);
    if (!current) return fail(404, "spot not found");
    if (current.listingPriceSol === undefined) return fail(400, "spot is not listed for sale");
    if (current.owner === actor) return fail(400, "you already own this spot");
    const seller = current.owner;
    const priceSol = current.listingPriceSol;
    const minLamports = solRequiredLamportsWithTolerance(priceSol);

    const verified = await verifySolTransfer({ signature, fromOwner: actor, toOwner: seller, minLamports });
    if (!verified.ok) return fail(402, `payment not verified: ${verified.error}`);

    const firstUse = await claimSignature(signature);
    if (!firstUse) return fail(409, "this transaction signature was already used");

    const result = await updateOwnedPixel(index, seller, (existing) => ({
      ...existing,
      owner: actor,
      destination: "",
      imageUrl: "",
      message: "",
      neon: "none",
      purchasedAt: Date.now(),
      isRented: false,
      listingPriceSol: undefined,
      rentPriceSol: undefined,
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
  if (isRateLimited(`pixels-buy:${ip}`, 20, 60_000)) return fail(429, "Too many purchase attempts — slow down.");
  const index = body.index;
  if (!isValidIndex(index)) return fail(400, "invalid index");
  const days = body.days;
  if (typeof days !== "number" || !Number.isInteger(days) || days <= 0 || days > 365) {
    return fail(400, "invalid days (1-365)");
  }
  const signature = body.signature;
  if (typeof signature !== "string" || !signature) return fail(400, "missing signature");

  return withWriteLock(async () => {
    const current = await getPixel(index);
    if (!current) return fail(404, "spot not found");
    if (current.rentPriceSol === undefined) return fail(400, "spot is not listed for rent");
    if (current.owner === actor) return fail(400, "you already own this spot");
    const owner = current.owner;
    const priceSol = current.rentPriceSol * days;
    const minLamports = solRequiredLamportsWithTolerance(priceSol);

    const verified = await verifySolTransfer({ signature, fromOwner: actor, toOwner: owner, minLamports });
    if (!verified.ok) return fail(402, `payment not verified: ${verified.error}`);

    const firstUse = await claimSignature(signature);
    if (!firstUse) return fail(409, "this transaction signature was already used");

    const result = await updateOwnedPixel(index, owner, (existing) => ({
      ...existing,
      isRented: true,
      rentedTo: actor,
      rentedUntil: Date.now() + days * 24 * 60 * 60 * 1000,
      rentPriceSol: undefined,
    }));
    if (!result.ok) {
      await releaseSignature(signature);
      return fail(409, "this listing changed before your rental landed — your payment proof is still valid to retry");
    }
    return NextResponse.json({ ok: true, pixel: result.pixel });
  });
}
