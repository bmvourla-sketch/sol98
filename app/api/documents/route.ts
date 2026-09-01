import { PublicKey } from "@solana/web3.js";
import { NextResponse } from "next/server";

import { createDocument, readAllDocuments } from "@/lib/server/document-db";
import { claimSignature, releaseSignature } from "@/lib/server/used-signatures";
import { solRequiredLamportsWithTolerance, verifySolTransfer } from "@/lib/server/verify-tx";
import { isRateLimited, requestIp } from "@/lib/server/rate-limit";
import { recordPaymentTransaction } from "@/lib/server/payment-ledger";
import { logAudit } from "@/lib/server/audit-log";
import { TREASURY_ADDRESS } from "@/lib/solana";
import { DOCUMENT_PRICE_SOL, isDocumentValidationError, sanitizeDocumentInput, type DocumentData } from "@/lib/document-types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function fail(status: number, error: string) {
  return NextResponse.json({ error }, { status });
}

/** GET /api/documents — every purchased document, shared across all users. */
export async function GET() {
  try {
    const documents = await readAllDocuments();
    return NextResponse.json({ documents });
  } catch (error) {
    return fail(500, error instanceof Error ? error.message : "read failed");
  }
}

/** POST /api/documents — buy one, paid at a fixed price to the treasury. */
export async function POST(request: Request) {
  const ip = requestIp(request);
  if (isRateLimited(`documents:${ip}`, 20, 60_000)) {
    return fail(429, "Too many requests — slow down and try again in a minute.");
  }
  if (!TREASURY_ADDRESS) return fail(500, "Treasury not configured — set NEXT_PUBLIC_TREASURY_ADDRESS");

  let body: Record<string, unknown>;
  try {
    const text = await request.text();
    if (text.length > 100_000) return fail(413, "payload too large");
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return fail(400, "invalid JSON body");
  }

  let actorKey: PublicKey;
  try {
    actorKey = new PublicKey(String(body.actor ?? ""));
  } catch {
    return fail(400, "missing or invalid actor pubkey");
  }
  const actor = actorKey.toBase58();

  const signature = body.signature;
  if (typeof signature !== "string" || !signature) return fail(400, "missing signature");

  const sanitized = sanitizeDocumentInput(body.name, body.content);
  if (isDocumentValidationError(sanitized)) return fail(400, `${sanitized.field}: ${sanitized.reason}`);

  try {
    const minLamports = solRequiredLamportsWithTolerance(DOCUMENT_PRICE_SOL);
    const verified = await verifySolTransfer({
      signature,
      fromOwner: actor,
      toOwner: TREASURY_ADDRESS,
      minLamports,
    });
    if (!verified.ok) {
      logAudit("payment_verification_failed", { action: "buy-document", wallet: actor, reason: verified.error });
      return fail(402, `payment not verified: ${verified.error}`);
    }
    logAudit("payment_verified", { action: "buy-document", wallet: actor });

    const firstUse = await claimSignature(signature);
    if (!firstUse) {
      logAudit("duplicate_transaction_detected", { action: "buy-document", wallet: actor, where: "used_signatures" });
      return fail(409, "this transaction signature was already used");
    }

    const doc: DocumentData = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      name: sanitized.name,
      content: sanitized.content,
      owner: actor,
      purchasedAt: Date.now(),
    };
    try {
      const created = await createDocument(doc);
      await recordPaymentTransaction({ signature, wallet: actor, action: "buy-document", amountSol: DOCUMENT_PRICE_SOL });
      return NextResponse.json({ ok: true, document: created });
    } catch (writeError) {
      await releaseSignature(signature);
      logAudit("db_failure", { where: "createDocument", error: writeError instanceof Error ? writeError.message : String(writeError) });
      throw writeError;
    }
  } catch (error) {
    return fail(500, error instanceof Error ? error.message : "purchase failed");
  }
}
