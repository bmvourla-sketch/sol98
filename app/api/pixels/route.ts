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

/** POST /api/pixels — upsert one pixel, with basic input validation. */
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      pixel?: { index?: unknown; owner?: unknown };
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

    await writePixel(pixel);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "write failed" },
      { status: 500 }
    );
  }
}
