// SOL-98 Phase 4 (FRONTEND INTENT INTEGRATION) — unit coverage for
// lib/purchase-intent.ts, the client-side half of the Purchase Intent flow
// Phase 3 made mandatory server-side. This is the SAME module
// lib/pixel-store.tsx / lib/board-store.tsx call for both intent creation
// (createPurchaseIntent) and redemption (postJson) — see those files' own
// doc comments.
//
// This file mocks `global.fetch` and asserts the exact request SHAPE this
// module sends and the exact error CLASSIFICATION it produces from a
// server response — i.e. "does the client build the right request, and
// does it correctly turn a 410/403/409/404/503 into something the UI can
// show the user". The real end-to-end proof (this same code talking to the
// real route handlers and real Postgres) is in
// tests/integration/phase4-frontend-intent-staging.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ApiError,
  createPurchaseIntent,
  formatCountdown,
  friendlyIntentError,
  msUntil,
  postJson,
} from "../lib/purchase-intent";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createPurchaseIntent", () => {
  it("POSTs actor/actionType/boardId/index to /api/purchase-intents and maps a buy-listing (SOL) response", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        ok: true,
        intentId: "intent-123",
        expiresAt: 1_700_000_900_000,
        currency: "SOL",
        price: 2.5,
        sellerWallet: "SellerWalletBase58",
      })
    );

    const result = await createPurchaseIntent({ actor: "BuyerWallet", actionType: "buy-listing", index: 42 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/purchase-intents");
    expect(init.method).toBe("POST");
    const sentBody = JSON.parse(init.body as string);
    expect(sentBody).toEqual({ actor: "BuyerWallet", actionType: "buy-listing", boardId: null, index: 42 });

    expect(result).toEqual({
      intentId: "intent-123",
      expiresAt: 1_700_000_900_000,
      currency: "SOL",
      sellerWallet: "SellerWalletBase58",
      priceSol: 2.5,
      pricePixel98: undefined,
      days: undefined,
      hijackCostTokensPreview: undefined,
      burnedTokensPreview: undefined,
      ownerTokensPreview: undefined,
    });
  });

  it("includes boardId and days when provided (board sub-block rent)", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        ok: true,
        intentId: "intent-rent",
        expiresAt: 1_700_000_900_000,
        currency: "SOL",
        price: 3,
        days: 10,
        sellerWallet: "SellerWalletBase58",
      })
    );

    const result = await createPurchaseIntent({ actor: "BuyerWallet", actionType: "rent", boardId: "b-1", index: 7, days: 10 });

    const [, init] = fetchMock.mock.calls[0];
    const sentBody = JSON.parse(init.body as string);
    expect(sentBody).toEqual({ actor: "BuyerWallet", actionType: "rent", boardId: "b-1", index: 7, days: 10 });
    expect(result.days).toBe(10);
    expect(result.priceSol).toBe(3);
  });

  it("maps a hijack response's preview fields without treating them as a locked-in price", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        ok: true,
        intentId: "intent-hijack",
        expiresAt: 1_700_000_900_000,
        currency: "PIXEL98",
        hijackCostTokensPreview: 100000,
        burnedTokensPreview: 50000,
        ownerTokensPreview: 50000,
        sellerWallet: "SellerWalletBase58",
        note: "hijack cost is recomputed fresh from the live burned fraction when you redeem this intent — this figure is a preview only",
      })
    );

    const result = await createPurchaseIntent({ actor: "Hijacker", actionType: "hijack", index: 4 });
    expect(result.currency).toBe("PIXEL98");
    expect(result.hijackCostTokensPreview).toBe(100000);
    expect(result.burnedTokensPreview).toBe(50000);
    expect(result.ownerTokensPreview).toBe(50000);
    // No priceSol/pricePixel98 — hijack never locks in a price (Phase 3 decision).
    expect(result.priceSol).toBeUndefined();
    expect(result.pricePixel98).toBeUndefined();
  });

  it("throws an ApiError carrying the server's status AND message on failure", async () => {
    fetchMock.mockResolvedValue(jsonResponse(410, { error: "this purchase intent has expired — create a new one" }));

    await expect(createPurchaseIntent({ actor: "BuyerWallet", actionType: "buy-listing", index: 1 })).rejects.toMatchObject({
      status: 410,
      message: "this purchase intent has expired — create a new one",
    });
  });
});

describe("postJson (the shared redemption-call helper)", () => {
  it("resolves with the parsed JSON body on a 2xx response", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, pixel: { index: 1 } }));
    const result = await postJson<{ ok: boolean; pixel: { index: number } }>("/api/pixels", { action: "buy-listing", intentId: "x" });
    expect(result.pixel.index).toBe(1);
  });

  it("throws ApiError with the response status on a non-2xx response", async () => {
    fetchMock.mockResolvedValue(jsonResponse(403, { error: "this purchase intent belongs to a different wallet" }));
    const err = await postJson("/api/pixels", { action: "buy-listing", intentId: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(403);
    expect((err as ApiError).message).toBe("this purchase intent belongs to a different wallet");
  });

  it("falls back to a generic message when the server response has no JSON body", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 500 }));
    const err = await postJson("/api/pixels", {}).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(500);
    expect((err as ApiError).message).toMatch(/request failed \(500\)/);
  });
});

describe("friendlyIntentError — status → user-facing message mapping", () => {
  it("maps every status the intent system's red-team checklist cares about", () => {
    expect(friendlyIntentError(new ApiError("x", 410))).toMatch(/expired/i);
    expect(friendlyIntentError(new ApiError("x", 403))).toMatch(/wallet/i);
    expect(friendlyIntentError(new ApiError("x", 409))).toMatch(/changed/i);
    expect(friendlyIntentError(new ApiError("x", 404))).toMatch(/available/i);
  });

  it("passes the server's own message through for 503 ($PIXEL98 not live)", () => {
    expect(friendlyIntentError(new ApiError("$PIXEL98 not live yet — hijack can't be paid until launch", 503))).toBe(
      "$PIXEL98 not live yet — hijack can't be paid until launch"
    );
  });

  it("falls back to the plain Error message for anything else, and a generic string for non-Errors", () => {
    expect(friendlyIntentError(new Error("Wallet not connected"))).toBe("Wallet not connected");
    expect(friendlyIntentError("not even an Error")).toMatch(/went wrong/i);
  });
});

describe("countdown helpers", () => {
  it("msUntil floors at 0 for an already-past expiry", () => {
    expect(msUntil(Date.now() - 5000)).toBe(0);
  });

  it("formatCountdown renders mm:ss", () => {
    const expiresAt = Date.now() + 90 * 1000; // 1:30
    expect(formatCountdown(expiresAt)).toBe("1:30");
  });
});
