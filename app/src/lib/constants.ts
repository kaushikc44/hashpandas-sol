import { PublicKey } from "@solana/web3.js";
import idl from "./idl.json";

export const PROGRAM_ID = new PublicKey(idl.address);
export const MPL_CORE_PROGRAM_ID = new PublicKey("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);

export const DEVNET_RPC_ENDPOINT = "https://api.devnet.solana.com";

export { idl };
