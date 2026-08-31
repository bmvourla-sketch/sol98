import { PublicKey } from "@solana/web3.js";
import { NextResponse } from "next/server";

import { readPixels, writePixel } from "@/lib/server/pixel-db";
import { verifyTransferSignature } from "@/lib/server/verify-purchase";

// Board state changes constantly — never statically optimize this route.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_INDEX = 9_999;

/** GET /api/pixels — the whole board. Every user sees this same global state. */
export async function GET() {
  try {
    const pixels = await readPixels();
    return NextResponse.json({ pixels });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "read failed" },
      { status: 500 }
    );
  }
}

/** POST /api/pixels — upsert one pixel, with basic input validation. */
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      pixel?: { index?: unknown; owner?: unknown };
      signature?: string | null;
      mock?: boolean;
    };
    const pixel = body?.pixel;
    if (!pixel) return NextResponse.json({ error: "missing pixel" }, { status: 400 });

    if (
      typeof pixel.index !== "number" ||
      !Number.isInteger(pixel.index) ||
      pixel.index < 0 ||
      pixel.index > MAX_INDEX
    ) {
      return NextResponse.json({ error: "invalid index" }, { status: 400 });
    }

    if (typeof pixel.owner !== "string" || !pixel.owner) {
      return NextResponse.json({ error: "missing owner" }, { status: 400 });
    }
    try {
      new PublicKey(pixel.owner);
    } catch {
      return NextResponse.json({ error: "invalid owner" }, { status: 400 });
    }

    // Ownership verification: a write that assigns or changes the owner must
    // be backed by a verified SOL transfer (or be an explicit mock action such
    // as SOL98, the simulated hijack burn, or market trades). Same-owner edits
    // (ad content, listing, renting) need no signature.
    const existing = (await readPixels())[pixel.index as number];
    const existingOwner = (existing as { owner?: unknown } | undefined)?.owner;
    if (existingOwner !== pixel.owner && !body.mock) {
      if (!body.signature) {
        return NextResponse.json(
          { error: "purchase signature required" },
          { status: 403 }
        );
      }
      const ok = await verifyTransferSignature(body.signature, pixel.owner as string);
      if (!ok) {
        return NextResponse.json(
          { error: "invalid purchase signature" },
          { status: 403 }
        );
      }
    }

    await writePixel(pixel);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "write failed" },
      { status: 500 }
    );
  }
}
