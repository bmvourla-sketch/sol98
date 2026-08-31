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
import { useConnection, useWallet } from "@solana/wallet-adapter-react";

import { buildTransferTransaction } from "./purchase";
import { getTreasuryPublicKey } from "./solana";
import { DOCUMENT_PRICE_SOL, type DocumentData } from "./document-types";

export type { DocumentData } from "./document-types";

interface DocumentContextValue {
  documents: DocumentData[];
  /** Sends the real 0.2 SOL purchase to the treasury, then registers the document server-side. */
  buyDocument: (name: string, content: string) => Promise<DocumentData>;
}

const API_URL = "/api/documents";
const POLL_MS = 30_000;

const DocumentContext = createContext<DocumentContextValue | null>(null);

/**
 * The "document sale" ad-tool store (Board.exe). Documents are now shared,
 * server-persisted state (like the pixel board) — a previous version kept
 * them in localStorage only, so a paid purchase was invisible to everyone
 * else and vanished if the browser's storage was cleared.
 */
export function DocumentProvider({ children }: { children: ReactNode }) {
  const { publicKey, connected, sendTransaction } = useWallet();
  const { connection } = useConnection();
  const [documents, setDocuments] = useState<DocumentData[]>([]);

  const fetchDocuments = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}?t=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { documents?: DocumentData[] };
      setDocuments(data.documents ?? []);
    } catch {
      // offline — keep whatever we last had
    }
  }, []);

  useEffect(() => {
    void fetchDocuments();
    const id = setInterval(() => void fetchDocuments(), POLL_MS);
    return () => clearInterval(id);
  }, [fetchDocuments]);

  const buyDocument = useCallback(
    async (name: string, content: string): Promise<DocumentData> => {
      if (!connected || !publicKey) throw new Error("Wallet not connected");

      const tx = buildTransferTransaction(publicKey, getTreasuryPublicKey(), DOCUMENT_PRICE_SOL);
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      tx.feePayer = publicKey;
      const signature = await sendTransaction(tx, connection);
      const confirmed = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight });
      if (confirmed.value.err) throw new Error("Transaction failed on-chain");

      const res = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actor: publicKey.toBase58(), name, content, signature }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string; document?: DocumentData };
      if (!res.ok || !json.document) {
        throw new Error(json.error || "Purchase failed");
      }
      setDocuments((prev) => [...prev, json.document as DocumentData]);
      return json.document;
    },
    [connected, publicKey, connection, sendTransaction]
  );

  const value = useMemo<DocumentContextValue>(() => ({ documents, buyDocument }), [documents, buyDocument]);

  return <DocumentContext.Provider value={value}>{children}</DocumentContext.Provider>;
}

export function useDocuments(): DocumentContextValue {
  const ctx = useContext(DocumentContext);
  if (!ctx) throw new Error("useDocuments must be used within a DocumentProvider");
  return ctx;
}
