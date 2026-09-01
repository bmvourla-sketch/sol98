"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";

import { areaPrice, nextSpotPrice, TOTAL_SPOTS, totalRaisedSol } from "./pricing";
import { airdropFor, hijackCostInTokens, splitHijackBurn } from "./token";
import { PIXEL98_MINT } from "./solana";
import { useHijackBurn, useSendSolTransfer, useSignAuthMessage } from "./use-solana-tx";
import { createPurchaseIntent, postJson, type IntentActionType } from "./purchase-intent";
import type { AdContent, PixelData } from "./pixel-types";

export type { AdContent, NeonTemplate, PixelData } from "./pixel-types";

export type SyncState = "loading" | "live" | "offline";

/** Creating-intent / awaiting-signature / confirming — surfaced so dialogs can show progress. */
export type TxPhase = "creating_intent" | "awaiting_signature" | "processing" | null;

/** Which currency a market listing is priced in. */
export type ListingCurrency = "SOL" | "PIXEL98";

/**
 * SOL-98 Phase 4 (GÖREV 1) — the purchase intent currently reserved for a
 * buy-listing / rent / hijack flow, if any. Surfaced so dialogs can show the
 * "complete within Xm Ys" UX (see components/intent-countdown.tsx).
 */
export interface ActiveIntent {
  intentId: string;
  actionType: IntentActionType;
  expiresAt: number;
}

interface PixelContextValue {
  pixels: Record<number, PixelData>;
  soldCount: number;
  nextPriceSol: number;
  totalRaisedSol: number;
  firstFreeIndex: number;
  syncState: SyncState;
  connectedOwner: string;
  txPhase: TxPhase;
  activeIntent: ActiveIntent | null;
  areaPriceFor: (count: number) => number;
  /** Current hijack burn tier inputs (driven by cumulative burned supply). */
  burnedFraction: number;
  hijackCostTokens: number;
  hijackSplit: { burnedTokens: number; ownerTokens: number };
  hijackCostFor: (index: number) => number;

  buyPixel: (index: number, ad: AdContent) => Promise<PixelData>;
  /** Buy a rectangular area of blocks as ONE banner (bigger area = bigger ad). */
  buyArea: (indices: number[], ad: AdContent) => Promise<PixelData[]>;
  /** Overtake a spot. Real verified burn once $PIXEL98 is live, simulated (rate-limited) before. */
  hijackPixel: (index: number) => Promise<{ pixel: PixelData; simulated: boolean }>;
  editPixel: (index: number, ad: Partial<AdContent>) => Promise<PixelData>;
  /** Apply an ad/banner to every block in a banner group. */
  editArea: (groupId: string, ad: Partial<AdContent>) => Promise<PixelData[]>;
  listForSale: (index: number, price: number, currency: ListingCurrency) => Promise<PixelData>;
  /** Pays the CURRENT owner directly (peer-to-peer), then transfers ownership. */
  buyListing: (index: number) => Promise<PixelData>;
  listForRent: (index: number, pricePerDay: number, currency: ListingCurrency) => Promise<PixelData>;
  /** Pays the CURRENT owner directly for `days`. */
  rentPixel: (index: number, days: number) => Promise<PixelData>;
  unlist: (index: number) => Promise<PixelData>;
  spotsOwnedBy: (owner: string) => number;
  airdropForOwner: (owner: string) => number;
}

// localStorage now acts as an offline CACHE only — the server API is the
// source of truth so every user sees the same global board.
const PIXEL_CACHE_KEY = "sol98-pixels-cache-v4";
const API_URL = process.env.NEXT_PUBLIC_PIXELS_API_URL || "/api/pixels";
const POLL_MS = 20_000;

const PixelContext = createContext<PixelContextValue | null>(null);

function loadCache(): Record<number, PixelData> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(PIXEL_CACHE_KEY);
    return raw ? (JSON.parse(raw) as Record<number, PixelData>) : {};
  } catch {
    return {};
  }
}

function saveCache(value: Record<number, PixelData>): void {
  try {
    window.localStorage.setItem(PIXEL_CACHE_KEY, JSON.stringify(value));
  } catch {
    // ignore quota/private-mode errors
  }
}

/** Shallow value-equality for one pixel record (cheap — flat-ish object). */
function pixelsEqual(a: PixelData | undefined, b: PixelData | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const keysA = Object.keys(a) as (keyof PixelData)[];
  const keysB = Object.keys(b) as (keyof PixelData)[];
  if (keysA.length !== keysB.length) return false;
  return keysA.every((key) => a[key] === b[key]);
}

/**
 * Merges a freshly-fetched (full) board snapshot into `prev`. Two levels of
 * "don't re-render for nothing":
 *  1. Per-pixel: a key whose value is unchanged keeps `prev`'s OBJECT
 *     REFERENCE (not the new-but-equal one from `incoming`), so React.memo
 *     on PixelCell can actually skip re-rendering that one cell.
 *  2. Whole-board: if NO key changed at all, returns `prev` itself unchanged
 *     — the 20s poll used to always produce a brand-new top-level object
 *     (and therefore a new `pixels` reference), forcing all 10,000 board
 *     cells to re-render on a timer even when nothing had moved.
 */
function mergePixels(
  prev: Record<number, PixelData>,
  incoming: Record<number, PixelData>
): Record<number, PixelData> {
  let anyChanged = false;
  const next: Record<number, PixelData> = {};
  for (const key in incoming) {
    const index = Number(key);
    const incomingPixel = incoming[index];
    const prevPixel = prev[index];
    if (pixelsEqual(prevPixel, incomingPixel)) {
      next[index] = prevPixel;
    } else {
      next[index] = incomingPixel;
      anyChanged = true;
    }
  }
  if (!anyChanged && Object.keys(prev).length === Object.keys(next).length) {
    return prev;
  }
  return next;
}

// SOL-98 Phase 4 (GÖREV 1) — routed through lib/purchase-intent.ts's shared
// postJson() so the thrown error preserves the HTTP status (410 expired
// intent / 403 foreign wallet's intent / 409 listing changed or intent
// already consumed — see that module's friendlyIntentError) and so this is
// the SAME code path tests/integration/phase4-frontend-intent-staging.test.ts
// exercises against real staging.
async function postAction<T>(action: string, payload: Record<string, unknown>): Promise<T> {
  return postJson<T>(API_URL, { action, ...payload });
}

export function PixelProvider({ children }: { children: ReactNode }) {
  const { publicKey, connected } = useWallet();
  const sendSol = useSendSolTransfer();
  const signAuthMessage = useSignAuthMessage();
  const hijackBurn = useHijackBurn();

  const [pixels, setPixels] = useState<Record<number, PixelData>>({});
  const [syncState, setSyncState] = useState<SyncState>("loading");
  const [txPhase, setTxPhase] = useState<TxPhase>(null);
  const [activeIntent, setActiveIntent] = useState<ActiveIntent | null>(null);
  const [burnedFraction, setBurnedFraction] = useState(0);
  const hydrated = useRef(false);

  useEffect(() => {
    setPixels(loadCache());
    hydrated.current = true;
  }, []);

  const fetchPixels = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}?t=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { pixels?: Record<number, PixelData>; burnedFraction?: number };
      setPixels((prev) => mergePixels(prev, data.pixels ?? {}));
      if (typeof data.burnedFraction === "number") setBurnedFraction(data.burnedFraction);
      setSyncState("live");
    } catch {
      setSyncState("offline");
    }
  }, []);

  useEffect(() => {
    void fetchPixels();
    const id = setInterval(() => void fetchPixels(), POLL_MS);
    const onFocus = () => void fetchPixels();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(id);
      window.removeEventListener("focus", onFocus);
    };
  }, [fetchPixels]);

  useEffect(() => {
    if (hydrated.current) saveCache(pixels);
  }, [pixels]);

  const owner = publicKey?.toBase58() ?? "";

  const requireWallet = useCallback((): string => {
    if (!connected || !publicKey) throw new Error("Wallet not connected");
    return publicKey.toBase58();
  }, [connected, publicKey]);

  /** Sends a real SOL transfer (treasury by default) and returns its signature. */
  const sendTransfer = useCallback(
    async (amountSol: number, recipient?: PublicKey): Promise<string> => {
      setTxPhase("awaiting_signature");
      return sendSol(amountSol, () => setTxPhase("processing"), recipient);
    },
    [sendSol]
  );

  /** Signs the free-action auth message — no funds move. */
  const signAuth = useCallback(
    async (action: string, index: number | number[]) => {
      const proof = await signAuthMessage(action, index);
      return { authTimestamp: proof.timestamp, authSignature: proof.signature };
    },
    [signAuthMessage]
  );

  const soldCount = Object.keys(pixels).length;

  const buyArea = useCallback(
    async (indices: number[], ad: AdContent): Promise<PixelData[]> => {
      const actor = requireWallet();
      const price = areaPrice(soldCount, indices.length);
      try {
        const signature = await sendTransfer(price);
        const result = await postAction<{ pixels: PixelData[] }>("buy-area", {
          actor,
          indices,
          signature,
          ad,
        });
        setPixels((prev) => {
          const next = { ...prev };
          for (const p of result.pixels) next[p.index] = p;
          return next;
        });
        return result.pixels;
      } finally {
        setTxPhase(null);
      }
    },
    [requireWallet, sendTransfer, soldCount]
  );

  const buyPixel = useCallback(
    async (index: number, ad: AdContent): Promise<PixelData> => {
      const [pixel] = await buyArea([index], ad);
      return pixel;
    },
    [buyArea]
  );

  const hijackPixel = useCallback(
    async (index: number): Promise<{ pixel: PixelData; simulated: boolean }> => {
      const actor = requireWallet();
      const target = pixels[index];
      if (!target) throw new Error("Nothing to hijack there yet");
      const tokenLive = Boolean(PIXEL98_MINT);

      try {
        if (tokenLive) {
          // SOL-98 Phase 3/4 (fixes P2-F1, GÖREV 1/3): a real burn spends
          // real value, so — exactly like buy-listing/rent — this MUST go
          // through a server-issued purchase intent before the wallet ever
          // signs anything. The intent does not lock in a cost (Phase 3
          // decision — burnedFraction moves continuously); instead the
          // preview it returns IS the freshly-recomputed cost at the moment
          // of signing, which is exactly what GÖREV 3 asks the UI to
          // reflect — closer to redemption-time than a burnedFraction
          // value that could be up to POLL_MS (20s) stale from the last
          // board poll.
          setTxPhase("creating_intent");
          const intent = await createPurchaseIntent({ actor, actionType: "hijack", boardId: null, index });
          setActiveIntent({ intentId: intent.intentId, actionType: "hijack", expiresAt: intent.expiresAt });
          const burnedTokens = intent.burnedTokensPreview ?? 0;
          const ownerTokens = intent.ownerTokensPreview ?? 0;

          setTxPhase("awaiting_signature");
          const outcome = await hijackBurn(
            { owner: intent.sellerWallet, burnTokens: burnedTokens, transferTokens: ownerTokens },
            () => setTxPhase("processing")
          );
          const result = await postAction<{ pixel: PixelData; simulated: boolean }>("hijack", {
            actor,
            intentId: intent.intentId,
            signature: outcome.signature,
          });
          setPixels((prev) => ({ ...prev, [index]: result.pixel }));
          return result;
        }

        // Pre-launch simulated path — free, no payment, so nothing to
        // substitute a payment onto: no intent involved, unchanged from
        // before Phase 3.
        setTxPhase("awaiting_signature");
        const auth = await signAuth("hijack", index);
        const result = await postAction<{ pixel: PixelData; simulated: boolean }>("hijack", {
          actor,
          index,
          ...auth,
        });
        setPixels((prev) => ({ ...prev, [index]: result.pixel }));
        return result;
      } finally {
        setTxPhase(null);
        setActiveIntent(null);
      }
    },
    [requireWallet, pixels, hijackBurn, signAuth]
  );

  const editPixel = useCallback(
    async (index: number, ad: Partial<AdContent>): Promise<PixelData> => {
      const actor = requireWallet();
      const auth = await signAuth("edit", index);
      const result = await postAction<{ pixel: PixelData }>("edit", { actor, index, ad, ...auth });
      setPixels((prev) => ({ ...prev, [index]: result.pixel }));
      return result.pixel;
    },
    [requireWallet, signAuth]
  );

  const editArea = useCallback(
    async (groupId: string, ad: Partial<AdContent>): Promise<PixelData[]> => {
      const actor = requireWallet();
      const auth = await signAuth("edit-area", -1);
      const result = await postAction<{ pixels: PixelData[] }>("edit-area", { actor, groupId, ad, ...auth });
      setPixels((prev) => {
        const next = { ...prev };
        for (const p of result.pixels) next[p.index] = p;
        return next;
      });
      return result.pixels;
    },
    [requireWallet, signAuth]
  );

  const listForSale = useCallback(
    async (index: number, price: number, currency: ListingCurrency): Promise<PixelData> => {
      const actor = requireWallet();
      const auth = await signAuth("list-sale", index);
      const result = await postAction<{ pixel: PixelData }>("list-sale", { actor, index, price, currency, ...auth });
      setPixels((prev) => ({ ...prev, [index]: result.pixel }));
      return result.pixel;
    },
    [requireWallet, signAuth]
  );

  const listForRent = useCallback(
    async (index: number, pricePerDay: number, currency: ListingCurrency): Promise<PixelData> => {
      const actor = requireWallet();
      const auth = await signAuth("list-rent", index);
      const result = await postAction<{ pixel: PixelData }>("list-rent", {
        actor,
        index,
        pricePerDay,
        currency,
        ...auth,
      });
      setPixels((prev) => ({ ...prev, [index]: result.pixel }));
      return result.pixel;
    },
    [requireWallet, signAuth]
  );

  const unlist = useCallback(
    async (index: number): Promise<PixelData> => {
      const actor = requireWallet();
      const auth = await signAuth("unlist", index);
      const result = await postAction<{ pixel: PixelData }>("unlist", { actor, index, ...auth });
      setPixels((prev) => ({ ...prev, [index]: result.pixel }));
      return result.pixel;
    },
    [requireWallet, signAuth]
  );

  const buyListing = useCallback(
    async (index: number): Promise<PixelData> => {
      const actor = requireWallet();
      const current = pixels[index];
      if (!current || (current.listingPriceSol === undefined && current.listingPricePixel98 === undefined)) {
        throw new Error("Not listed for sale");
      }
      if (current.listingPriceSol === undefined) {
        throw new Error("This listing is priced in $PIXEL98 — available after launch");
      }
      try {
        // SOL-98 Phase 3/4 (fixes P2-F1, GÖREV 1): reserve a purchase
        // intent BEFORE the wallet signs anything — the server re-reads the
        // live listing itself and returns the authoritative price + seller,
        // which is what the payment is built from below (never this
        // function's own `current`, which can be up to POLL_MS stale).
        setTxPhase("creating_intent");
        const intent = await createPurchaseIntent({ actor, actionType: "buy-listing", boardId: null, index });
        setActiveIntent({ intentId: intent.intentId, actionType: "buy-listing", expiresAt: intent.expiresAt });
        const priceSol = intent.priceSol ?? current.listingPriceSol;

        const signature = await sendTransfer(priceSol, new PublicKey(intent.sellerWallet));
        const result = await postAction<{ pixel: PixelData }>("buy-listing", { actor, intentId: intent.intentId, signature });
        setPixels((prev) => ({ ...prev, [index]: result.pixel }));
        return result.pixel;
      } finally {
        setTxPhase(null);
        setActiveIntent(null);
      }
    },
    [requireWallet, pixels, sendTransfer]
  );

  const rentPixel = useCallback(
    async (index: number, days: number): Promise<PixelData> => {
      const actor = requireWallet();
      const current = pixels[index];
      if (!current || (current.rentPriceSol === undefined && current.rentPricePixel98 === undefined)) {
        throw new Error("Not listed for rent");
      }
      if (current.rentPriceSol === undefined) {
        throw new Error("This listing is priced in $PIXEL98 — available after launch");
      }
      try {
        setTxPhase("creating_intent");
        const intent = await createPurchaseIntent({ actor, actionType: "rent", boardId: null, index, days });
        setActiveIntent({ intentId: intent.intentId, actionType: "rent", expiresAt: intent.expiresAt });
        const priceSol = intent.priceSol ?? current.rentPriceSol * days;

        const signature = await sendTransfer(priceSol, new PublicKey(intent.sellerWallet));
        const result = await postAction<{ pixel: PixelData }>("rent", { actor, intentId: intent.intentId, signature });
        setPixels((prev) => ({ ...prev, [index]: result.pixel }));
        return result.pixel;
      } finally {
        setTxPhase(null);
        setActiveIntent(null);
      }
    },
    [requireWallet, pixels, sendTransfer]
  );

  const firstFreeIndex = useMemo(() => {
    for (let i = 0; i < TOTAL_SPOTS; i++) {
      if (!pixels[i]) return i;
    }
    return -1;
  }, [pixels]);

  const spotsOwnedBy = useCallback(
    (who: string) => {
      if (!who) return 0;
      let n = 0;
      for (const key in pixels) {
        if (pixels[key].owner === who) n++;
      }
      return n;
    },
    [pixels]
  );

  const airdropForOwner = useCallback((who: string) => airdropFor(spotsOwnedBy(who)), [spotsOwnedBy]);

  const areaPriceFor = useCallback((count: number) => areaPrice(soldCount, count), [soldCount]);
  const hijackCostFor = useCallback(
    (index: number) => (pixels[index] ? hijackCostInTokens(burnedFraction) : 0),
    [pixels, burnedFraction]
  );

  const value = useMemo<PixelContextValue>(
    () => ({
      pixels,
      soldCount,
      nextPriceSol: nextSpotPrice(soldCount),
      totalRaisedSol: totalRaisedSol(soldCount),
      firstFreeIndex,
      syncState,
      connectedOwner: owner,
      txPhase,
      activeIntent,
      areaPriceFor,
      burnedFraction,
      hijackCostTokens: hijackCostInTokens(burnedFraction),
      hijackSplit: splitHijackBurn(hijackCostInTokens(burnedFraction)),
      hijackCostFor,
      buyPixel,
      buyArea,
      hijackPixel,
      editPixel,
      editArea,
      listForSale,
      buyListing,
      listForRent,
      rentPixel,
      unlist,
      spotsOwnedBy,
      airdropForOwner,
    }),
    [
      pixels,
      soldCount,
      firstFreeIndex,
      syncState,
      owner,
      txPhase,
      activeIntent,
      areaPriceFor,
      burnedFraction,
      hijackCostFor,
      buyPixel,
      buyArea,
      hijackPixel,
      editPixel,
      editArea,
      listForSale,
      buyListing,
      listForRent,
      rentPixel,
      unlist,
      spotsOwnedBy,
      airdropForOwner,
    ]
  );

  return <PixelContext.Provider value={value}>{children}</PixelContext.Provider>;
}

export function usePixels(): PixelContextValue {
  const ctx = useContext(PixelContext);
  if (!ctx) throw new Error("usePixels must be used within a PixelProvider");
  return ctx;
}
