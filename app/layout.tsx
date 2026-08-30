import type { Metadata, Viewport } from "next";
import "./globals.css";

import { SolanaWalletProvider } from "@/components/solana-wallet-provider";

export const metadata: Metadata = {
  title: "SOL-98: The On-Chain Pixel Board",
  description:
    "A Windows 98 style on-chain pixel board on Solana. 10,000 blocks, one mission.",
  manifest: "/manifest.json",
  icons: { icon: "/icon.svg", apple: "/icon.svg" },
};

export const viewport: Viewport = {
  themeColor: "#008080",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <link rel="manifest" href="/manifest.json" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="SOL-98" />
      </head>
      <body>
        <SolanaWalletProvider>{children}</SolanaWalletProvider>
      </body>
    </html>
  );
}
