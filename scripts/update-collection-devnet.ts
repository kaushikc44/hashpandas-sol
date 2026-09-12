/**
 * Fixes the collection's on-chain URI, which was a placeholder at
 * initialize time, to point at the real GitHub-hosted metadata.
 * Run once, after the program upgrade that adds update_collection_metadata
 * has landed on devnet.
 */
import { readFileSync } from "node:fs";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import anchorPkg from "@coral-xyz/anchor";
import type { Idl } from "@coral-xyz/anchor";
import idl from "../target/idl/hashpandas.json" with { type: "json" };

const { AnchorProvider, Program, Wallet } = anchorPkg;

const DEVNET_RPC = "https://api.devnet.solana.com";
const MPL_CORE_PROGRAM_ID = new PublicKey("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
const REAL_COLLECTION_URI =
  "https://raw.githubusercontent.com/kaushikc44/hashpandas-sol/main/metadata/collection.json";

function loadKeypair(path: string): Keypair {
  const raw = JSON.parse(readFileSync(path, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

async function main() {
  const deployer = loadKeypair(`${process.env.HOME}/.config/solana/deployer.json`);
  const connection = new Connection(DEVNET_RPC, "confirmed");
  const wallet = new Wallet(deployer);
  const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
  const program = new Program(idl as Idl, provider);
  const programId = program.programId;

  const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], programId);
  const configInfo = await connection.getAccountInfo(config);
  if (!configInfo) throw new Error("config not found");

  const { BorshAccountsCoder } = anchorPkg;
  const coder = new BorshAccountsCoder(idl as Idl);
  const configDecoded = coder.decode("Config", configInfo.data) as { collection: PublicKey };

  console.log("collection:", configDecoded.collection.toBase58());
  console.log("new uri:", REAL_COLLECTION_URI);

  const sig = await program.methods
    .updateCollectionMetadata({
      newName: null,
      newUri: REAL_COLLECTION_URI,
    })
    .accountsStrict({
      authority: deployer.publicKey,
      config,
      collection: configDecoded.collection,
      mplCoreProgram: MPL_CORE_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log("update OK:", sig);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
