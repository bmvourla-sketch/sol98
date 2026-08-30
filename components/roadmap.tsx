const ROADMAP = `SOL-98 — ROADMAP.EXE
================================================================================

PHASE 1 — BOOT SEQUENCE
    - Board goes live (100x100 grid)
    - 0.2 SOL initial sales open (real on-chain transfers)
    - Wallet connect (Phantom / Solflare)
    - Buy / Rent / Sell marketplace (Market.exe)
    - PWA install ("Install SOL-98")

PHASE 2 — BLUE SCREEN OF FOMO
    - Reach 1,000 spots sold (10% of board)
    - Launch $PIXEL98 on Pump.fun
    - Airdrop to pixel owners (proportional to spots)
    - Pixel Hijack goes live (real token burn)

PHASE 3 — CYBER WAR
    - Pixel Hijack fully on-chain (burn $PIXEL98 to overtake)
    - PWA release + Mobile "Win98" emulator (touch-friendly)
    - On-chain indexer for live board state
    - Neon banner template gallery

PHASE 4 — PIXEL DAO
    - Pixel Holders DAO
    - Community curation + treasury votes
    - Hijack mechanics tuned by governance
    - The board becomes its own operating system.

================================================================================
10,000 blocks. One mission.
`;

export function Roadmap() {
  return <div className="win98-notepad h-full">{ROADMAP}</div>;
}
