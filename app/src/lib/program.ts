import { AnchorProvider, Program, type Idl } from "@coral-xyz/anchor";
import type { Connection } from "@solana/web3.js";
import type { WalletContextState } from "@solana/wallet-adapter-react";
import idl from "./idl.json";

/** A minimal wallet shape AnchorProvider needs -- matches what
 * `useWallet()` gives us once `wallet.publicKey` is non-null. */
export interface AnchorCompatibleWallet {
  publicKey: NonNullable<WalletContextState["publicKey"]>;
  signTransaction: NonNullable<WalletContextState["signTransaction"]>;
  signAllTransactions: NonNullable<WalletContextState["signAllTransactions"]>;
}

export function getProgram(connection: Connection, wallet: AnchorCompatibleWallet) {
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  return new Program(idl as Idl, provider);
}

export type HashpandasProgram = ReturnType<typeof getProgram>;
