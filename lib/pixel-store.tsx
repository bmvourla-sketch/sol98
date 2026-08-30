"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { nextSpotPrice, totalRaisedSol } from "./pricing";
import { airdropFor, HIJACK_VALUATION_DECAY } from "./token";

export type NeonTemplate = "none" | "cyberpunk-pulse" | "matrix" | "flashing" | "glitch";

/** The ad payload attached to a spot. */
export interface AdContent {
  destination: string; // destination link
  imageUrl: string; // image / neon GIF
  message: string; // tooltip message
  neon: NeonTemplate; // neon banner template
}

export interface PixelData extends AdContent {
  index: number; // 0-based board index
  owner: string; // wallet public key (base58)
  valuationSol: number; // current SOL valuation (decays on hijack)
  purchasedAt: number; // epoch ms
  isRented: boolean;
  rentedTo?: string;
  rentedUntil?: number;
  listingPriceSol?: number; // set → for sale
  rentPriceSol?: number; // set → for rent (per day)
}

export type SyncState = "loading" | "live" | "offline";

interface PixelContextValue {
  pixels: Record<number, PixelData>;
  soldCount: number;
  nextPriceSol: number;
  totalRaisedSol: number;
  firstFreeIndex: number;
  pixel98Balance: number;
  syncState: SyncState;
  buyPixel: (index: number, owner: string, ad: AdContent) => void;
  /** Overtake a spot after a (real or simulated) burn. False if the spot vanished. */
  hijackPixel: (index: number, hijacker: string) => boolean;
  /** Deduct the mock $PIXEL98 balance (simulated-burn path only). */
  spendPixel98: (amount: number) => boolean;
  editPixel: (index: number, ad: Partial<AdContent>) => void;
  listForSale: (index: number, priceSol: number) => void;
  buyListing: (index: number, buyer: string) => void;
  listForRent: (index: number, priceSolPerDay: number) => void;
  rentPixel: (index: number, renter: string, days: number) => void;
  unlist: (index: number) => void;
  claimPixel98: (amount: number) => void;
  spotsOwnedBy: (owner: string) => number;
  airdropForOwner: (owner: string) => number;
}

// localStorage now acts as an offline CACHE only — the server API is the
// source of truth so every user sees the same global board.
const PIXEL_CACHE_KEY = "sol98-pixels-cache-v3";
const BALANCE_STORAGE_KEY = "sol98-pixel98-balance-v1";
const API_URL = process.env.NEXT_PUBLIC_PIXELS_API_URL || "/api/pixels";
const POLL_MS = 20_000;

const PixelContext = createContext<PixelContextValue | null>(null);

function load<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function save(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore quota/private-mode errors
  }
}

export function PixelProvider({ children }: { children: ReactNode }) {
  const [pixels, setPixels] = useState<Record<number, PixelData>>({});
  const [balance, setBalance] = useState(0);
  const [syncState, setSyncState] = useState<SyncState>("loading");

  // Hydrate the offline cache immediately (instant paint), then let the server
  // board overwrite/merge it below.
  useEffect(() => setPixels(load(PIXEL_CACHE_KEY, {})), []);
  useEffect(() => setBalance(load(BALANCE_STORAGE_KEY, 0)), []);

  // Fetch the global board: on mount, every POLL_MS, and on window focus.
  const fetchPixels = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}?t=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { pixels?: Record<number, PixelData> };
      setPixels((prev) => ({ ...prev, ...(data.pixels ?? {}) }));
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

  // Keep the offline cache warm.
  useEffect(() => save(PIXEL_CACHE_KEY, pixels), [pixels]);
  useEffect(() => save(BALANCE_STORAGE_KEY, balance), [balance]);

  // Push a single changed pixel to the server (fire-and-forget; the poll
  // reconciles on the next round if it fails).
  const syncPixel = useCallback(async (pixel: PixelData) => {
    try {
      await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pixel }),
      });
    } catch {
      // offline — stays in the local cache until the next successful fetch
    }
  }, []);

  const upsert = useCallback(
    (pixel: PixelData) => {
      setPixels((prev) => ({ ...prev, [pixel.index]: pixel }));
      void syncPixel(pixel);
    },
    [syncPixel]
  );

  const buyPixel = useCallback(
    (index: number, owner: string, ad: AdContent) => {
      const price = nextSpotPrice(Object.keys(pixels).length);
      upsert({
        index,
        owner,
        destination: ad.destination,
        imageUrl: ad.imageUrl,
        message: ad.message,
        neon: ad.neon,
        valuationSol: price,
        purchasedAt: Date.now(),
        isRented: false,
      });
    },
    [pixels, upsert]
  );

  const hijackPixel = useCallback(
    (index: number, hijacker: string): boolean => {
      const target = pixels[index];
      if (!target) return false;
      upsert({
        ...target,
        owner: hijacker,
        valuationSol: target.valuationSol * (1 - HIJACK_VALUATION_DECAY),
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
      });
      return true;
    },
    [pixels, upsert]
  );

  const spendPixel98 = useCallback(
    (amount: number): boolean => {
      if (balance < amount) return false;
      setBalance((prev) => prev - amount);
      return true;
    },
    [balance]
  );

  const editPixel = useCallback(
    (index: number, ad: Partial<AdContent>) => {
      const cur = pixels[index];
      if (!cur) return;
      upsert({ ...cur, ...ad });
    },
    [pixels, upsert]
  );

  const listForSale = useCallback(
    (index: number, priceSol: number) => {
      const cur = pixels[index];
      if (!cur) return;
      upsert({ ...cur, listingPriceSol: priceSol, rentPriceSol: undefined });
    },
    [pixels, upsert]
  );

  const buyListing = useCallback(
    (index: number, buyer: string) => {
      const cur = pixels[index];
      if (!cur) return;
      upsert({
        ...cur,
        owner: buyer,
        destination: "",
        imageUrl: "",
        message: "",
        neon: "none",
        purchasedAt: Date.now(),
        isRented: false,
        listingPriceSol: undefined,
        rentPriceSol: undefined,
        valuationSol: cur.listingPriceSol ?? cur.valuationSol,
      });
    },
    [pixels, upsert]
  );

  const listForRent = useCallback(
    (index: number, priceSolPerDay: number) => {
      const cur = pixels[index];
      if (!cur) return;
      upsert({ ...cur, rentPriceSol: priceSolPerDay, listingPriceSol: undefined });
    },
    [pixels, upsert]
  );

  const rentPixel = useCallback(
    (index: number, renter: string, days: number) => {
      const cur = pixels[index];
      if (!cur) return;
      upsert({
        ...cur,
        isRented: true,
        rentedTo: renter,
        rentedUntil: Date.now() + days * 24 * 60 * 60 * 1000,
        rentPriceSol: undefined,
      });
    },
    [pixels, upsert]
  );

  const unlist = useCallback(
    (index: number) => {
      const cur = pixels[index];
      if (!cur) return;
      upsert({ ...cur, listingPriceSol: undefined, rentPriceSol: undefined });
    },
    [pixels, upsert]
  );

  const claimPixel98 = useCallback((amount: number) => {
    setBalance((prev) => prev + amount);
  }, []);

  const soldCount = Object.keys(pixels).length;

  const firstFreeIndex = useMemo(() => {
    for (let i = 0; i < 10_000; i++) {
      if (!pixels[i]) return i;
    }
    return -1;
  }, [pixels]);

  const spotsOwnedBy = useCallback(
    (owner: string) => {
      if (!owner) return 0;
      let n = 0;
      for (const key in pixels) {
        if (pixels[key].owner === owner) n++;
      }
      return n;
    },
    [pixels]
  );

  const airdropForOwner = useCallback(
    (owner: string) => airdropFor(spotsOwnedBy(owner)),
    [spotsOwnedBy]
  );

  const value = useMemo<PixelContextValue>(
    () => ({
      pixels,
      soldCount,
      nextPriceSol: nextSpotPrice(soldCount),
      totalRaisedSol: totalRaisedSol(soldCount),
      firstFreeIndex,
      pixel98Balance: balance,
      syncState,
      buyPixel,
      hijackPixel,
      spendPixel98,
      editPixel,
      listForSale,
      buyListing,
      listForRent,
      rentPixel,
      unlist,
      claimPixel98,
      spotsOwnedBy,
      airdropForOwner,
    }),
    [
      pixels,
      soldCount,
      firstFreeIndex,
      balance,
      syncState,
      buyPixel,
      hijackPixel,
      spendPixel98,
      editPixel,
      listForSale,
      buyListing,
      listForRent,
      rentPixel,
      unlist,
      claimPixel98,
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
