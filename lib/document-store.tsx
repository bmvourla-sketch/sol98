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

export interface DocumentData {
  id: string;
  name: string; // user-chosen document name
  content: string; // user-chosen content
  owner: string; // wallet public key (base58)
  purchasedAt: number;
}

interface DocumentContextValue {
  documents: DocumentData[];
  buyDocument: (name: string, content: string, owner: string) => void;
}

const STORAGE_KEY = "sol98-documents-v1";

const DocumentContext = createContext<DocumentContextValue | null>(null);

/**
 * The "document sale" ad-tool store (Board.exe). Separate from the pixel
 * board: each document is a named file with user content, sold as an ad.
 * Persisted to localStorage (client-side) for now.
 */
export function DocumentProvider({ children }: { children: ReactNode }) {
  const [documents, setDocuments] = useState<DocumentData[]>([]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) setDocuments(JSON.parse(raw) as DocumentData[]);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(documents));
    } catch {
      // ignore quota/private-mode errors
    }
  }, [documents]);

  const buyDocument = useCallback((name: string, content: string, owner: string) => {
    setDocuments((prev) => [
      ...prev,
      {
        id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        name: name.trim() || "Untitled",
        content,
        owner,
        purchasedAt: Date.now(),
      },
    ]);
  }, []);

  const value = useMemo<DocumentContextValue>(
    () => ({ documents, buyDocument }),
    [documents, buyDocument]
  );

  return <DocumentContext.Provider value={value}>{children}</DocumentContext.Provider>;
}

export function useDocuments(): DocumentContextValue {
  const ctx = useContext(DocumentContext);
  if (!ctx) throw new Error("useDocuments must be used within a DocumentProvider");
  return ctx;
}
