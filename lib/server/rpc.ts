// Server-only Solana RPC connection, used to independently VERIFY that a
// transaction the client claims to have sent actually landed on-chain and
// does what it says. Never trust a client-submitted signature without this.
import "server-only";
import { Connection } from "@solana/web3.js";

import { getServerSolanaRpcEndpoint } from "@/lib/solana";

let cached: Connection | null = null;

export function getServerConnection(): Connection {
  if (!cached) {
    cached = new Connection(getServerSolanaRpcEndpoint(), "confirmed");
  }
  return cached;
}
