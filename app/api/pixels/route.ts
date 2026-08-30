import { ed25519 } from "@noble/curves/ed25519";
import { PublicKey } from "@solana/web3.js";
import { NextResponse } from "next/server";

import { readPixels, writePixel } from "@/lib/server/pixel-db";

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

/**
 * POST /api/pixels — upsert one pixel.
 * Body: `{ pixel, signature }`. The server verifies that `signature` is a valid
 * ed25519 signature of `SOL-98:claim:<index>` by `pixel.owner`, proving the
 * caller controls the wallet they are writing as (prevents spoofing).
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      pixel?: { index?: unknown; owner?: unknown };
      signature?: string | null;
    };
    const pixel = body?.pixel;
    if (!pixel) return NextResponse.json({ error: "missing pixel" }, { status: 400 });

    // Validate index.
    if (
      typeof pixel.index !== "number" ||
      !Number.isInteger(pixel.index) ||
      pixel.index < 0 ||
      pixel.index > MAX_INDEX
    ) {
      return NextResponse.json({ error: "invalid index" }, { status: 400 });
    }

    // Validate owner is a real base58 pubkey.
    if (typeof pixel.owner !== "string" || !pixel.owner) {
      return NextResponse.json({ error: "missing owner" }, { status: 400 });
    }
    let ownerKey: PublicKey;
    try {
      ownerKey = new PublicKey(pixel.owner);
    } catch {
      return NextResponse.json({ error: "invalid owner" }, { status: 400 });
    }

    // Verify the wallet signature.
    const message = `SOL-98:claim:${pixel.index}`;
    if (!body.signature) {
      return NextResponse.json({ error: "missing signature" }, { status: 401 });
    }
    let sig: Uint8Array;
    try {
      sig = Uint8Array.from(Buffer.from(body.signature, "base64"));
    } catch {
      return NextResponse.json({ error: "bad signature" }, { status: 401 });
    }
    const ok = ed25519.verify(sig, new TextEncoder().encode(message), ownerKey.toBytes());
    if (!ok) {
      return NextResponse.json({ error: "invalid signature" }, { status: 401 });
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
