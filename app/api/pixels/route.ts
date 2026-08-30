import { NextResponse } from "next/server";

import { readPixels, writePixel } from "@/lib/server/pixel-db";

// Board state changes constantly — never statically optimize this route.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

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

/** POST /api/pixels — upsert one pixel. Body: `{ pixel: PixelData }`. */
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { pixel?: unknown };
    if (!body || !body.pixel) {
      return NextResponse.json({ error: "missing pixel" }, { status: 400 });
    }
    await writePixel(body.pixel);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "write failed" },
      { status: 500 }
    );
  }
}
