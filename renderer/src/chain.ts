/**
 * Reads a `Panda` account straight from chain data and decodes it using the
 * program's own generated IDL -- the same IDL `anchor build` produces from
 * `programs/hashpandas/src/state.rs` -- so this can never silently drift
 * from the real account layout.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Connection, PublicKey } from "@solana/web3.js";
import { BorshAccountsCoder } from "@coral-xyz/anchor";

const __dirname = dirname(fileURLToPath(import.meta.url));
const idlPath = join(__dirname, "..", "..", "target", "idl", "hashpandas.json");
const idl = JSON.parse(readFileSync(idlPath, "utf-8"));
const coder = new BorshAccountsCoder(idl);

export interface PandaAccount {
  asset: PublicKey;
  index: bigint;
  mintEpoch: number;
  mintedUnix: bigint;
  seed: Uint8Array;
  workHash: Uint8Array;
  claimedScaled: bigint;
  burned: boolean;
  bump: number;
}

export function decodePanda(data: Buffer): PandaAccount {
  const raw = coder.decode("Panda", data);
  return {
    asset: raw.asset as PublicKey,
    index: BigInt(raw.index.toString()),
    mintEpoch: raw.mint_epoch as number,
    mintedUnix: BigInt(raw.minted_unix.toString()),
    seed: Uint8Array.from(raw.seed as number[]),
    workHash: Uint8Array.from(raw.work_hash as number[]),
    claimedScaled: BigInt(raw.claimed_scaled.toString()),
    burned: raw.burned as boolean,
    bump: raw.bump as number,
  };
}

export async function fetchPanda(
  connection: Connection,
  pandaAccountAddress: PublicKey,
): Promise<PandaAccount> {
  const info = await connection.getAccountInfo(pandaAccountAddress);
  if (!info) {
    throw new Error(`no account found at ${pandaAccountAddress.toBase58()}`);
  }
  return decodePanda(info.data);
}

/** Derives the Panda PDA for a given Core asset, mirroring
 * `seeds = [b"panda", asset.key().as_ref()]` in state.rs. */
export function derivePandaAddress(programId: PublicKey, asset: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("panda"), asset.toBuffer()], programId)[0];
}
