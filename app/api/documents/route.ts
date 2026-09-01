import { PublicKey } from "@solana/web3.js";
import { NextResponse } from "next/server";

import { readAllDocuments } from "@/lib/server/document-db";
import { claimSignature, releaseSignatureSafely } from "@/lib/server/used-signatures";
import { solRequiredLamportsWithTolerance, verifySolTransfer } from "@/lib/server/verify-tx";
import { isRateLimited, requestIp } from "@/lib/server/rate-limit";
import { insertDocumentAtomic } from "@/lib/server/document-insert-atomic";
import { logAudit } from "@/lib/server/audit-log";
import { TREASURY_ADDRESS } from "@/lib/solana";
import { DOCUMENT_PRICE_SOL, isDocumentValidationError, sanitizeDocumentInput, type DocumentData } from "@/lib/document-types";

// SOL-98 Phase 6 (RED-TEAM HARDENING — BULGU 2, see
// docs/production-readiness/RED-TEAM-FINDINGS.md): this route used to call
// createDocument() then a SEPARATE best-effort recordPaymentTransaction() —
// the P2-F4-class ledger-completeness gap Phase 3/4 already closed for
// pixel/board purchases, just never applied here. It now goes through
// insertDocumentAtomic (one Postgres transaction covering both the document
// row and the payment_transactions ledger row — see
// supabase/migrations/0006_hardening_price_lock_documents_intent_expiry.up.sql),
// with the same Phase 2.1 (P2-F2) release-on-throw discipline every other
// treasury purchase handler already follows: a thrown error releases the
// signature so a real DB/infra failure doesn't permanently burn a payment
// proof that already reached the treasury.

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
    let created: Awaited<ReturnType<typeof insertDocumentAtomic>>;
    try {
      created = await insertDocumentAtomic({ doc, signature, wallet: actor, action: "buy-document", amountSol: DOCUMENT_PRICE_SOL });
    } catch (error) {
      await releaseSignatureSafely(signature, { action: "buy-document", wallet: actor });
      logAudit("db_failure", {
        where: "insertDocumentAtomic",
        action: "buy-document",
        wallet: actor,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    if (!created.ok) {
      await releaseSignatureSafely(signature, { action: "buy-document", wallet: actor });
      logAudit("ownership_conflict", { action: "buy-document", wallet: actor });
      return fail(409, "that document id was just taken — please retry, your payment proof is still valid");
    }
    return NextResponse.json({ ok: true, document: created.document });
  } catch (error) {
    return fail(500, error instanceof Error ? error.message : "purchase failed");
  }
}
