import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import { describe, expect, it } from "vitest";

import { AUTH_MESSAGE_MAX_AGE_MS, buildAuthMessage, isAuthTimestampFresh } from "../lib/auth-message";
import { base64ToBytes, bytesToBase64 } from "../lib/bytes";
import { verifyAuthProof } from "../lib/server/verify-message";

function signAuth(keypair: Keypair, action: string, index: number | number[], timestamp: number) {
  const message = buildAuthMessage(action, index, keypair.publicKey.toBase58(), timestamp);
  const signature = nacl.sign.detached(new TextEncoder().encode(message), keypair.secretKey);
  return bytesToBase64(signature);
}

describe("buildAuthMessage", () => {
  it("is deterministic for the same inputs", () => {
    const a = buildAuthMessage("edit", 42, "OwnerPubkey", 1000);
    const b = buildAuthMessage("edit", 42, "OwnerPubkey", 1000);
    expect(a).toBe(b);
  });

  it("differs when any field changes (action/index/owner/timestamp binding)", () => {
    const base = buildAuthMessage("edit", 42, "OwnerPubkey", 1000);
    expect(buildAuthMessage("unlist", 42, "OwnerPubkey", 1000)).not.toBe(base);
    expect(buildAuthMessage("edit", 43, "OwnerPubkey", 1000)).not.toBe(base);
    expect(buildAuthMessage("edit", 42, "OtherPubkey", 1000)).not.toBe(base);
    expect(buildAuthMessage("edit", 42, "OwnerPubkey", 1001)).not.toBe(base);
  });

  it("supports an index array (buy-area / edit-area)", () => {
    expect(buildAuthMessage("edit-area", [1, 2, 3], "Owner", 1000)).toContain("index:1,2,3");
  });
});

describe("isAuthTimestampFresh", () => {
  const now = 1_000_000;
  it("accepts a timestamp right now", () => {
    expect(isAuthTimestampFresh(now, now)).toBe(true);
  });
  it("rejects a timestamp older than the max age", () => {
    expect(isAuthTimestampFresh(now - AUTH_MESSAGE_MAX_AGE_MS - 1, now)).toBe(false);
  });
  it("rejects a timestamp far in the future (clock skew guard)", () => {
    expect(isAuthTimestampFresh(now + 10 * 60_000, now)).toBe(false);
  });
});

describe("verifyAuthProof — end-to-end wallet-ownership proof", () => {
  it("accepts a genuine signature from the claimed owner's keypair", () => {
    const keypair = Keypair.generate();
    const owner = keypair.publicKey.toBase58();
    const timestamp = Date.now();
    const signature = signAuth(keypair, "edit", 5, timestamp);

    const result = verifyAuthProof({ action: "edit", index: 5, owner, timestamp, signature });
    expect(result.ok).toBe(true);
  });

  it("rejects a signature from a DIFFERENT wallet claiming to be the owner", () => {
    const realOwner = Keypair.generate();
    const impersonator = Keypair.generate();
    const timestamp = Date.now();
    // Impersonator signs, but the request claims `realOwner`'s pubkey as owner.
    const signature = signAuth(impersonator, "edit", 5, timestamp);

    const result = verifyAuthProof({
      action: "edit",
      index: 5,
      owner: realOwner.publicKey.toBase58(),
      timestamp,
      signature,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a signature over a DIFFERENT action (can't reuse an 'unlist' signature as 'edit')", () => {
    const keypair = Keypair.generate();
    const timestamp = Date.now();
    const signature = signAuth(keypair, "unlist", 5, timestamp);

    const result = verifyAuthProof({
      action: "edit",
      index: 5,
      owner: keypair.publicKey.toBase58(),
      timestamp,
      signature,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects an expired auth proof", () => {
    const keypair = Keypair.generate();
    const timestamp = Date.now() - AUTH_MESSAGE_MAX_AGE_MS - 1000;
    const signature = signAuth(keypair, "edit", 5, timestamp);

    const result = verifyAuthProof({
      action: "edit",
      index: 5,
      owner: keypair.publicKey.toBase58(),
      timestamp,
      signature,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a garbage/malformed signature", () => {
    const keypair = Keypair.generate();
    const timestamp = Date.now();
    const result = verifyAuthProof({
      action: "edit",
      index: 5,
      owner: keypair.publicKey.toBase58(),
      timestamp,
      signature: bytesToBase64(new Uint8Array(64)), // all-zero, wrong signature
    });
    expect(result.ok).toBe(false);
  });
});

describe("bytes round-trip", () => {
  it("base64 encode/decode preserves arbitrary bytes", () => {
    const original = nacl.randomBytes(64);
    const roundTripped = base64ToBytes(bytesToBase64(original));
    expect(Array.from(roundTripped)).toEqual(Array.from(original));
  });
});
