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

import { useHijackBurn, useSendSolTransfer, useSignAuthMessage } from "./use-solana-tx";
import { PIXEL98_MINT, getTreasuryPublicKey } from "./solana";
import { hijackCostInTokens, splitHijackBurn } from "./token";
import { createPurchaseIntent, postJson, type IntentActionType } from "./purchase-intent";
import { nextBoardFilePrice, type BoardFile, type BoardPixel } from "./board-types";
import type { AdContent } from "./pixel-types";

export type { BoardFile, BoardPixel } from "./board-types";
export type ListingCurrency = "SOL" | "PIXEL98";

/** SOL-98 Phase 4 (GÖREV 1) — mirrors lib/pixel-store.tsx's ActiveIntent. */
export interface ActiveIntent {
  intentId: string;
  actionType: IntentActionType;
  expiresAt: number;
}

interface BoardContextValue {
  files: BoardFile[];
  pixels: Record<string, BoardPixel>;
  burnedFraction: number;
  /** Live (pre-click) hijack cost estimate — same shape/derivation as
   * pixel-store.tsx's, driven off the polled `burnedFraction`. The
   * authoritative figure used at wallet-confirmation time comes from the
   * purchase intent's own preview (see GÖREV 3 in
   * docs/production-readiness/PHASE-4-FRONTEND-TOKEN-PREP.md). */
  hijackCostTokens: number;
  hijackSplit: { burnedTokens: number; ownerTokens: number };
  txPhase: "creating_intent" | "awaiting_signature" | "processing" | null;
  activeIntent: ActiveIntent | null;
  nextFilePriceSol: number;
  buyBoard: (name: string) => Promise<BoardFile>;
  renameBoard: (boardId: string, newName: string) => Promise<BoardFile>;
  editPixel: (boardId: string, index: number, ad: Partial<AdContent>) => Promise<BoardPixel>;
  listForSale: (boardId: string, index: number, price: number, currency: ListingCurrency) => Promise<BoardPixel>;
  listForRent: (boardId: string, index: number, pricePerDay: number, currency: ListingCurrency) => Promise<BoardPixel>;
  unlist: (boardId: string, index: number) => Promise<BoardPixel>;
  buyListing: (boardId: string, index: number) => Promise<BoardPixel>;
  rentPixel: (boardId: string, index: number, days: number) => Promise<BoardPixel>;
  hijackPixel: (boardId: string, index: number) => Promise<{ pixel: BoardPixel; simulated: boolean }>;
}

const API_URL = process.env.NEXT_PUBLIC_BOARDS_API_URL || "/api/boards";
const POLL_MS = 20_000;

const BoardContext = createContext<BoardContextValue | null>(null);

// SOL-98 Phase 4 (GÖREV 1) — see lib/pixel-store.tsx's postAction doc
// comment; identical reasoning, routed through the same shared postJson().
async function postAction<T>(action: string, payload: Record<string, unknown>): Promise<T> {
  return postJson<T>(API_URL, { action, ...payload });
}

export function BoardProvider({ children }: { children: ReactNode }) {
  const { publicKey, connected } = useWallet();
  const sendSol = useSendSolTransfer();
  const signAuthMessage = useSignAuthMessage();
  const hijackBurn = useHijackBurn();

  const [files, setFiles] = useState<BoardFile[]>([]);
  const [pixels, setPixels] = useState<Record<string, BoardPixel>>({});
  const [burnedFraction, setBurnedFraction] = useState(0);
  const [txPhase, setTxPhase] = useState<"creating_intent" | "awaiting_signature" | "processing" | null>(null);
  const [activeIntent, setActiveIntent] = useState<ActiveIntent | null>(null);
  const hydrated = useRef(false);

  const fetchBoards = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}?t=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as {
        files?: BoardFile[];
        pixels?: Record<string, BoardPixel>;
        burnedFraction?: number;
      };
      setFiles(data.files ?? []);
      setPixels(data.pixels ?? {});
      if (typeof data.burnedFraction === "number") setBurnedFraction(data.burnedFraction);
    } catch {
      // offline — keep whatever we last had
    }
  }, []);

  useEffect(() => {
    void fetchBoards();
    const id = setInterval(() => void fetchBoards(), POLL_MS);
    const onFocus = () => void fetchBoards();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(id);
      window.removeEventListener("focus", onFocus);
    };
  }, [fetchBoards]);

  const requireWallet = useCallback((): string => {
    if (!connected || !publicKey) throw new Error("Wallet not connected");
    return publicKey.toBase58();
  }, [connected, publicKey]);

  const signAuth = useCallback(
    async (action: string, index: number | number[]) => {
      const proof = await signAuthMessage(action, index);
      return { authTimestamp: proof.timestamp, authSignature: proof.signature };
    },
    [signAuthMessage]
  );

  const sendTransfer = useCallback(
    async (amountSol: number, recipient?: PublicKey): Promise<string> => {
      setTxPhase("awaiting_signature");
      return sendSol(amountSol, () => setTxPhase("processing"), recipient);
    },
    [sendSol]
  );

  const buyBoard = useCallback(
    async (name: string): Promise<BoardFile> => {
      const actor = requireWallet();
      const price = nextBoardFilePrice(files.length);
      try {
        const signature = await sendTransfer(price, getTreasuryPublicKey());
        const result = await postAction<{ file: BoardFile }>("buy-board", { actor, name, signature });
        setFiles((prev) => [...prev, result.file]);
        return result.file;
      } finally {
        setTxPhase(null);
      }
    },
    [requireWallet, sendTransfer, files.length]
  );

  const renameBoard = useCallback(
    async (boardId: string, newName: string): Promise<BoardFile> => {
      const actor = requireWallet();
      const auth = await signAuth("board-rename", -1);
      const result = await postAction<{ file: BoardFile }>("rename-board", { actor, boardId, name: newName, ...auth });
      setFiles((prev) => prev.map((f) => (f.id === boardId ? result.file : f)));
      return result.file;
    },
    [requireWallet, signAuth]
  );

  const editPixel = useCallback(
    async (boardId: string, index: number, ad: Partial<AdContent>): Promise<BoardPixel> => {
      const actor = requireWallet();
      const auth = await signAuth("board-edit", index);
      const result = await postAction<{ pixel: BoardPixel }>("edit-pixel", { actor, boardId, index, ad, ...auth });
      setPixels((prev) => ({ ...prev, [`${boardId}:${index}`]: result.pixel }));
      return result.pixel;
    },
    [requireWallet, signAuth]
  );

  const listForSale = useCallback(
    async (boardId: string, index: number, price: number, currency: ListingCurrency): Promise<BoardPixel> => {
      const actor = requireWallet();
      const auth = await signAuth("board-list-sale", index);
      const result = await postAction<{ pixel: BoardPixel }>("list-sale", { actor, boardId, index, price, currency, ...auth });
      setPixels((prev) => ({ ...prev, [`${boardId}:${index}`]: result.pixel }));
      return result.pixel;
    },
    [requireWallet, signAuth]
  );

  const listForRent = useCallback(
    async (boardId: string, index: number, pricePerDay: number, currency: ListingCurrency): Promise<BoardPixel> => {
      const actor = requireWallet();
      const auth = await signAuth("board-list-rent", index);
      const result = await postAction<{ pixel: BoardPixel }>("list-rent", { actor, boardId, index, pricePerDay, currency, ...auth });
      setPixels((prev) => ({ ...prev, [`${boardId}:${index}`]: result.pixel }));
      return result.pixel;
    },
    [requireWallet, signAuth]
  );

  const unlist = useCallback(
    async (boardId: string, index: number): Promise<BoardPixel> => {
      const actor = requireWallet();
      const auth = await signAuth("board-unlist", index);
      const result = await postAction<{ pixel: BoardPixel }>("unlist", { actor, boardId, index, ...auth });
      setPixels((prev) => ({ ...prev, [`${boardId}:${index}`]: result.pixel }));
      return result.pixel;
    },
    [requireWallet, signAuth]
  );

  const buyListing = useCallback(
    async (boardId: string, index: number): Promise<BoardPixel> => {
      const actor = requireWallet();
      const current = pixels[`${boardId}:${index}`];
      if (!current || (current.listingPriceSol === undefined && current.listingPricePixel98 === undefined)) {
        throw new Error("Not listed for sale");
      }
      if (current.listingPriceSol === undefined) {
        throw new Error("This listing is priced in $PIXEL98 — available after launch");
      }
      try {
        // SOL-98 Phase 3/4 (fixes P2-F1, GÖREV 1) — mirrors
        // lib/pixel-store.tsx's buyListing exactly: reserve an intent
        // (server re-reads the live sub-block listing itself) before the
        // wallet signs, then pay using the server-returned price + seller.
        setTxPhase("creating_intent");
        const intent = await createPurchaseIntent({ actor, actionType: "buy-listing", boardId, index });
        setActiveIntent({ intentId: intent.intentId, actionType: "buy-listing", expiresAt: intent.expiresAt });
        const priceSol = intent.priceSol ?? current.listingPriceSol;

        const signature = await sendTransfer(priceSol, new PublicKey(intent.sellerWallet));
        const result = await postAction<{ pixel: BoardPixel }>("buy-listing", { actor, boardId, intentId: intent.intentId, signature });
        setPixels((prev) => ({ ...prev, [`${boardId}:${index}`]: result.pixel }));
        return result.pixel;
      } finally {
        setTxPhase(null);
        setActiveIntent(null);
      }
    },
    [requireWallet, pixels, sendTransfer]
  );

  const rentPixel = useCallback(
    async (boardId: string, index: number, days: number): Promise<BoardPixel> => {
      const actor = requireWallet();
      const current = pixels[`${boardId}:${index}`];
      if (!current || (current.rentPriceSol === undefined && current.rentPricePixel98 === undefined)) {
        throw new Error("Not listed for rent");
      }
      if (current.rentPriceSol === undefined) {
        throw new Error("This listing is priced in $PIXEL98 — available after launch");
      }
      try {
        setTxPhase("creating_intent");
        const intent = await createPurchaseIntent({ actor, actionType: "rent", boardId, index, days });
        setActiveIntent({ intentId: intent.intentId, actionType: "rent", expiresAt: intent.expiresAt });
        const priceSol = intent.priceSol ?? current.rentPriceSol * days;

        const signature = await sendTransfer(priceSol, new PublicKey(intent.sellerWallet));
        const result = await postAction<{ pixel: BoardPixel }>("rent", { actor, boardId, intentId: intent.intentId, signature });
        setPixels((prev) => ({ ...prev, [`${boardId}:${index}`]: result.pixel }));
        return result.pixel;
      } finally {
        setTxPhase(null);
        setActiveIntent(null);
      }
    },
    [requireWallet, pixels, sendTransfer]
  );

  const hijackPixel = useCallback(
    async (boardId: string, index: number): Promise<{ pixel: BoardPixel; simulated: boolean }> => {
      const actor = requireWallet();
      const target = pixels[`${boardId}:${index}`];
      if (!target) throw new Error("Nothing to hijack there yet");
      const tokenLive = Boolean(PIXEL98_MINT);

      try {
        if (tokenLive) {
          // SOL-98 Phase 3/4 (fixes P2-F1, GÖREV 1/3) — mirrors
          // lib/pixel-store.tsx's hijackPixel exactly.
          setTxPhase("creating_intent");
          const intent = await createPurchaseIntent({ actor, actionType: "hijack", boardId, index });
          setActiveIntent({ intentId: intent.intentId, actionType: "hijack", expiresAt: intent.expiresAt });
          const burnedTokens = intent.burnedTokensPreview ?? 0;
          const ownerTokens = intent.ownerTokensPreview ?? 0;

          setTxPhase("awaiting_signature");
          const outcome = await hijackBurn(
            { owner: intent.sellerWallet, burnTokens: burnedTokens, transferTokens: ownerTokens },
            () => setTxPhase("processing")
          );
          const result = await postAction<{ pixel: BoardPixel; simulated: boolean }>("hijack", {
            actor,
            boardId,
            intentId: intent.intentId,
            signature: outcome.signature,
          });
          setPixels((prev) => ({ ...prev, [`${boardId}:${index}`]: result.pixel }));
          return result;
        }

        setTxPhase("awaiting_signature");
        const auth = await signAuth("board-hijack", index);
        const result = await postAction<{ pixel: BoardPixel; simulated: boolean }>("hijack", {
          actor,
          boardId,
          index,
          ...auth,
        });
        setPixels((prev) => ({ ...prev, [`${boardId}:${index}`]: result.pixel }));
        return result;
      } finally {
        setTxPhase(null);
        setActiveIntent(null);
      }
    },
    [requireWallet, pixels, hijackBurn, signAuth]
  );

  const value = useMemo<BoardContextValue>(
    () => ({
      files,
      pixels,
      burnedFraction,
      hijackCostTokens: hijackCostInTokens(burnedFraction),
      hijackSplit: splitHijackBurn(hijackCostInTokens(burnedFraction)),
      txPhase,
      activeIntent,
      nextFilePriceSol: nextBoardFilePrice(files.length),
      buyBoard,
      renameBoard,
      editPixel,
      listForSale,
      listForRent,
      unlist,
      buyListing,
      rentPixel,
      hijackPixel,
    }),
    [
      files,
      pixels,
      burnedFraction,
      txPhase,
      activeIntent,
      buyBoard,
      renameBoard,
      editPixel,
      listForSale,
      listForRent,
      unlist,
      buyListing,
      rentPixel,
      hijackPixel,
    ]
  );

  return <BoardContext.Provider value={value}>{children}</BoardContext.Provider>;
}

export function useBoards(): BoardContextValue {
  const ctx = useContext(BoardContext);
  if (!ctx) throw new Error("useBoards must be used within a BoardProvider");
  return ctx;
}
