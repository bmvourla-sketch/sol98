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

import { BOARD_SIZE, bulkBlockPrice, nextSpotPrice, TOTAL_SPOTS, totalRaisedSol } from "./pricing";
import { airdropFor, HIJACK_VALUATION_DECAY } from "./token";

export type NeonTemplate = "none" | "cyberpunk-pulse" | "matrix" | "flashing" | "glitch" | "rainbow" | "sequential";

/** The ad payload attached to a block (or a multi-block banner). */
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
  // Multi-block banner grouping (spanning ad).
  bannerGroupId?: string;
  bannerCols?: number;
  bannerRows?: number;
  bannerX?: number; // 0-based col within the banner
  bannerY?: number; // 0-based row within the banner
}

export type SyncState = "loading" | "live" | "offline";

interface PixelContextValue {
  pixels: Record<number, PixelData>;
  soldCount: number;
  nextPriceSol: number;
  totalRaisedSol: number;
  firstFreeIndex: number;
  pixel98Balance: number;
  sol98Balance: number;
  spendSol98: (amount: number) => boolean;
  claimSol98: (amount: number) => void;
  syncState: SyncState;
  buyPixel: (index: number, owner: string, ad: AdContent) => void;
  /** Buy a rectangular area of blocks as ONE banner (bigger area = bigger ad). */
  buyArea: (indices: number[], owner: string, ad: AdContent, baseOverride?: number) => void;
  /** Overtake a spot after a (real or simulated) burn. False if the spot vanished. */
  hijackPixel: (index: number, hijacker: string) => boolean;
  /** Deduct the mock $PIXEL98 balance (simulated-burn path only). */
  spendPixel98: (amount: number) => boolean;
  editPixel: (index: number, ad: Partial<AdContent>) => void;
  /** Apply an ad/banner to every block in a banner group. */
  editArea: (groupId: string, ad: Partial<AdContent>) => void;
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
  const [sol98Balance, setSol98Balance] = useState(100000);
  const [syncState, setSyncState] = useState<SyncState>("loading");

  useEffect(() => setPixels(load(PIXEL_CACHE_KEY, {})), []);
  useEffect(() => setBalance(load(BALANCE_STORAGE_KEY, 0)), []);

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

  useEffect(() => save(PIXEL_CACHE_KEY, pixels), [pixels]);
  useEffect(() => save(BALANCE_STORAGE_KEY, balance), [balance]);

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

  const buyArea = useCallback(
    (indices: number[], owner: string, ad: AdContent, baseOverride?: number) => {
      const base = baseOverride ?? Object.keys(pixels).length;
      const groupId = `b-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;

      const cols = indices.map((i) => i % BOARD_SIZE);
      const rows = indices.map((i) => Math.floor(i / BOARD_SIZE));
      const minCol = Math.min(...cols);
      const minRow = Math.min(...rows);
      const bannerCols = Math.max(...cols) - minCol + 1;
      const bannerRows = Math.max(...rows) - minRow + 1;

      setPixels((prev) => {
        const next = { ...prev };
        indices.forEach((index, k) => {
          next[index] = {
            index,
            owner,
            destination: ad.destination,
            imageUrl: ad.imageUrl,
            message: ad.message,
            neon: ad.neon,
            valuationSol: bulkBlockPrice(base, k),
            purchasedAt: Date.now(),
            isRented: false,
            bannerGroupId: groupId,
            bannerCols,
            bannerRows,
            bannerX: (index % BOARD_SIZE) - minCol,
            bannerY: Math.floor(index / BOARD_SIZE) - minRow,
          };
        });
        return next;
      });

      indices.forEach((index, k) => {
        void syncPixel({
          index,
          owner,
          destination: ad.destination,
          imageUrl: ad.imageUrl,
          message: ad.message,
          neon: ad.neon,
          valuationSol: bulkBlockPrice(base, k),
          purchasedAt: Date.now(),
          isRented: false,
          bannerGroupId: groupId,
          bannerCols,
          bannerRows,
          bannerX: (index % BOARD_SIZE) - minCol,
          bannerY: Math.floor(index / BOARD_SIZE) - minRow,
        });
      });
    },
    [pixels, syncPixel]
  );

  const buyPixel = useCallback(
    (index: number, owner: string, ad: AdContent) => {
      buyArea([index], owner, ad);
    },
    [buyArea]
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
        bannerGroupId: undefined,
        bannerCols: undefined,
        bannerRows: undefined,
        bannerX: undefined,
        bannerY: undefined,
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

  const editArea = useCallback(
    (groupId: string, ad: Partial<AdContent>) => {
      const updated: PixelData[] = [];
      for (const key in pixels) {
        if (pixels[key].bannerGroupId === groupId) {
          updated.push({ ...pixels[key], ...ad });
        }
      }
      if (updated.length === 0) return;
      setPixels((prev) => {
        const next = { ...prev };
        for (const p of updated) next[p.index] = p;
        return next;
      });
      for (const p of updated) void syncPixel(p);
    },
    [pixels, syncPixel]
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

  const spendSol98 = useCallback((amount: number): boolean => {
    if (sol98Balance < amount) return false;
    setSol98Balance((prev) => prev - amount);
    return true;
  }, [sol98Balance]);

  const claimSol98 = useCallback((amount: number) => {
    setSol98Balance((prev) => prev + amount);
  }, []);

  const soldCount = Object.keys(pixels).length;

  const firstFreeIndex = useMemo(() => {
    for (let i = 0; i < TOTAL_SPOTS; i++) {
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
      sol98Balance,
      spendSol98,
      claimSol98,
      syncState,
      buyPixel,
      buyArea,
      hijackPixel,
      spendPixel98,
      editPixel,
      editArea,
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
      sol98Balance,
      spendSol98,
      claimSol98,
      syncState,
      buyPixel,
      buyArea,
      hijackPixel,
      spendPixel98,
      editPixel,
      editArea,
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
