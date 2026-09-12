import { PublicKey } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, PROGRAM_ID, TOKEN_PROGRAM_ID } from "./constants";

export function configPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("config")], PROGRAM_ID);
}

export function vaultPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("vault")], PROGRAM_ID);
}

export function treasuryPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("treasury")], PROGRAM_ID);
}

export function pandaMintPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("panda_mint")], PROGRAM_ID);
}

export function pandaPda(asset: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("panda"), asset.toBuffer()], PROGRAM_ID);
}

export function associatedTokenAddress(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
}
