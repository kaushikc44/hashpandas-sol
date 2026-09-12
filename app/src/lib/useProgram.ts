"use client";

import { useMemo } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { getProgram, type AnchorCompatibleWallet } from "./program";

/** Null until a wallet is connected and ready to sign. */
export function useHashpandasProgram() {
  const { connection } = useConnection();
  const wallet = useWallet();

  return useMemo(() => {
    if (!wallet.publicKey || !wallet.signTransaction || !wallet.signAllTransactions) {
      return null;
    }
    const anchorWallet: AnchorCompatibleWallet = {
      publicKey: wallet.publicKey,
      signTransaction: wallet.signTransaction,
      signAllTransactions: wallet.signAllTransactions,
    };
    return getProgram(connection, anchorWallet);
  }, [connection, wallet.publicKey, wallet.signTransaction, wallet.signAllTransactions]);
}
