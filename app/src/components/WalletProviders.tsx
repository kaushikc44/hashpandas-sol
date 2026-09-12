"use client";

import { useMemo } from "react";
import { Buffer } from "buffer";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { DEVNET_RPC_ENDPOINT } from "@/lib/constants";

import "@solana/wallet-adapter-react-ui/styles.css";

// @solana/web3.js and friends expect a global `Buffer`, which Node provides
// but browsers don't. Next.js's bundler doesn't auto-polyfill Node core
// modules, so this does it explicitly, once, client-side only.
if (typeof window !== "undefined") {
  window.Buffer = window.Buffer ?? Buffer;
}

export default function WalletProviders({ children }: { children: React.ReactNode }) {
  const endpoint = DEVNET_RPC_ENDPOINT;
  // No explicit wallet adapters: Phantom, Solflare, Backpack etc. are all
  // Wallet Standard compliant and get auto-detected by
  // @solana/wallet-adapter-react without needing a legacy adapter per wallet.
  const wallets = useMemo(() => [], []);

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
