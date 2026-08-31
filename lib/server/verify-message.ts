// Verifies the free-action auth proof (edit / list / unlist / simulated
// hijack): a detached ed25519 signature over `buildAuthMessage(...)`,
// produced client-side by the wallet's `signMessage`. No transaction, no
// fee — but the server independently re-derives the exact message and
// checks the signature against the claimed owner's public key, so nobody
// can act as a wallet they don't control.
import "server-only";
import nacl from "tweetnacl";
import { PublicKey } from "@solana/web3.js";

import { buildAuthMessage, isAuthTimestampFresh } from "@/lib/auth-message";
import { base64ToBytes } from "@/lib/bytes";

export interface AuthCheck {
  action: string;
  index: number | number[];
  owner: string;
  timestamp: number;
  signature: string; // base64
}

export type VerifyResult = { ok: true } | { ok: false; error: string };

export function verifyAuthProof({ action, index, owner, timestamp, signature }: AuthCheck): VerifyResult {
  if (!isAuthTimestampFresh(timestamp)) {
    return { ok: false, error: "auth proof expired — please retry" };
  }
  let ownerKey: PublicKey;
  try {
    ownerKey = new PublicKey(owner);
  } catch {
    return { ok: false, error: "invalid owner pubkey" };
  }
  let sigBytes: Uint8Array;
  try {
    sigBytes = base64ToBytes(signature);
  } catch {
    return { ok: false, error: "malformed signature" };
  }
  if (sigBytes.length !== 64) {
    return { ok: false, error: "malformed signature" };
  }
  const message = buildAuthMessage(action, index, owner, timestamp);
  const messageBytes = new TextEncoder().encode(message);
  const valid = nacl.sign.detached.verify(messageBytes, sigBytes, ownerKey.toBytes());
  if (!valid) return { ok: false, error: "signature does not match owner wallet" };
  return { ok: true };
}
