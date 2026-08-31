"use client";

import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { FileText, X } from "lucide-react";

import { useDocuments, type DocumentData } from "@/lib/document-store";
import { shortenAddress } from "@/lib/solana";
import { useSendSolTransfer } from "@/lib/use-solana-tx";
import { Win98Alert } from "./win98-alert";

const DOCUMENT_PRICE_SOL = 0.2;

type TxStatus = "idle" | "awaiting_signature" | "processing" | "success" | "failed";

/**
 * Board.exe — the "document sale" ad-tool. Buy a named document with custom
 * content; documents appear as files and open in a notepad. This is a separate
 * ad feature from the pixel board.
 */
export function DocumentSale() {
  const { documents, buyDocument } = useDocuments();
  const { publicKey, connected } = useWallet();
  const sendSol = useSendSolTransfer();

  const [buyOpen, setBuyOpen] = useState(false);
  const [viewDoc, setViewDoc] = useState<DocumentData | null>(null);
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const [txStatus, setTxStatus] = useState<TxStatus>("idle");
  const [alert, setAlert] = useState<{ kind: "success" | "error"; title: string; message: string } | null>(null);

  const busy = txStatus === "awaiting_signature" || txStatus === "processing";

  async function handleBuy() {
    if (!connected || !publicKey) {
      setAlert({ kind: "error", title: "Wallet", message: "Connect your wallet first (top bar)." });
      return;
    }
    setTxStatus("awaiting_signature");
    try {
      const signature = await sendSol(DOCUMENT_PRICE_SOL, () => setTxStatus("processing"));
      setTxStatus("success");
      buyDocument(name, content, publicKey.toBase58());
      setAlert({
        kind: "success",
        title: "Document Purchased",
        message: `"${name.trim() || "Untitled"}" is yours.\n\nTx: ${signature}`,
      });
    } catch (error) {
      setTxStatus("failed");
      setAlert({ kind: "error", title: "Purchase Failed", message: error instanceof Error ? error.message : "Transaction failed" });
    }
  }

  return (
    <div className="relative flex h-full flex-col bg-[#c0c0c0]">
      {/* Toolbar */}
      <div className="flex items-center gap-3 p-2">
        <button type="button" className="win98-button" onClick={() => { setName(""); setContent(""); setTxStatus("idle"); setBuyOpen(true); }}>
          Buy Document
        </button>
        <span className="text-xs">
          Price: <b>{DOCUMENT_PRICE_SOL} SOL</b> / document
        </span>
        {!connected && <span className="text-[11px] text-[#800000]">Connect wallet to buy</span>}
      </div>

      {/* Documents (files) */}
      <div className="flex-1 overflow-auto p-2">
        {documents.length === 0 ? (
          <div className="p-4 text-center text-xs text-[#808080]">
            No documents yet. Buy one to name it and fill it with your content.
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-2">
            {documents.map((doc) => (
              <button
                key={doc.id}
                type="button"
                className="win98-desktop-icon"
                style={{ color: "#000", textShadow: "none" }}
                onClick={() => setViewDoc(doc)}
              >
                <span className="icon-glyph">
                  <FileText size={30} strokeWidth={1.5} color="#000" />
                </span>
                <span className="w-full truncate">{doc.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Buy dialog */}
      {buyOpen && (
        <div className="absolute inset-0 z-[200] flex items-center justify-center bg-black/25 p-3">
          <div className="win98-window bevel-out w-[min(360px,calc(100vw-1.5rem))]">
            <div className="win98-titlebar">
              <span className="flex-1 truncate text-[12px]">Buy Document</span>
              <button type="button" className="win98-title-button" onClick={() => setBuyOpen(false)} aria-label="Close">
                <X size={9} strokeWidth={3} />
              </button>
            </div>
            <div className="flex flex-col gap-2 p-3">
              <div className="bevel-in px-2 py-1 text-xs">
                Price: <b>{DOCUMENT_PRICE_SOL} SOL</b>
              </div>
              <label className="text-xs" htmlFor="doc-name">Document Name</label>
              <input id="doc-name" className="win98-field" value={name} onChange={(e) => setName(e.target.value)} placeholder="My Ad" />
              <label className="text-xs" htmlFor="doc-content">Content</label>
              <textarea
                id="doc-content"
                className="win98-field min-h-[120px] resize-none"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="Anything you want — text, links, your message…"
              />
              <div className="mt-1 flex justify-end gap-2">
                <button type="button" className="win98-button" onClick={() => setBuyOpen(false)} disabled={busy}>Cancel</button>
                <button type="button" className="win98-button" onClick={handleBuy} disabled={busy}>
                  {txStatus === "awaiting_signature" ? "Confirm in wallet…" : txStatus === "processing" ? "Confirming…" : "Buy"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* View dialog (notepad) */}
      {viewDoc && (
        <div className="absolute inset-0 z-[200] flex items-center justify-center bg-black/25 p-3">
          <div className="win98-window bevel-out w-[min(420px,calc(100vw-1.5rem))]">
            <div className="win98-titlebar">
              <span className="flex-1 truncate text-[12px]">{viewDoc.name}</span>
              <button type="button" className="win98-title-button" onClick={() => setViewDoc(null)} aria-label="Close">
                <X size={9} strokeWidth={3} />
              </button>
            </div>
            <div className="win98-notepad max-h-[60vh] overflow-auto p-3">{viewDoc.content || "(empty)"}</div>
            <div className="bevel-in m-2 px-2 py-1 text-[10px] text-[#808080]">
              Owner: {shortenAddress(viewDoc.owner, 6)}
            </div>
          </div>
        </div>
      )}

      {alert && (
        <Win98Alert
          kind={alert.kind}
          title={alert.title}
          message={alert.message}
          onOk={() => {
            setAlert(null);
            if (txStatus === "success") setBuyOpen(false);
            else setTxStatus("idle");
          }}
        />
      )}
    </div>
  );
}
