/**
 * One-time devnet setup: calls `initialize` for real, using the deployer
 * keypair as both payer and authority. Run after `anchor deploy
 * --provider.cluster devnet` (or `solana program deploy`) has put the
 * program on-chain.
 *
 * Usage:
 *   cd scripts && npm install && node --experimental-strip-types initialize-devnet.ts
 */

import { readFileSync } from "node:fs";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import anchorPkg from "@coral-xyz/anchor";
import type { Idl } from "@coral-xyz/anchor";
import idl from "../target/idl/hashpandas.json" with { type: "json" };

const { AnchorProvider, BN, Program, Wallet } = anchorPkg;

const DEVNET_RPC = "https://api.devnet.solana.com";
const MPL_CORE_PROGRAM_ID = new PublicKey("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);

function loadKeypair(path: string): Keypair {
  const raw = JSON.parse(readFileSync(path, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

async function main() {
  const deployerPath = process.env.HASHPANDAS_DEPLOYER ?? `${process.env.HOME}/.config/solana/deployer.json`;
  const deployer = loadKeypair(deployerPath);
  console.log("authority/payer:", deployer.publicKey.toBase58());

  const connection = new Connection(DEVNET_RPC, "confirmed");
  const wallet = new Wallet(deployer);
  const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
  const program = new Program(idl as Idl, provider);
  const programId = program.programId;

  const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], programId);
  const [vault] = PublicKey.findProgramAddressSync([Buffer.from("vault")], programId);
  const [treasury] = PublicKey.findProgramAddressSync([Buffer.from("treasury")], programId);
  const [pandaMint] = PublicKey.findProgramAddressSync([Buffer.from("panda_mint")], programId);
  const collection = Keypair.generate();
  const [buybackDestTokenAccount] = PublicKey.findProgramAddressSync(
    [config.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), pandaMint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  console.log("program:  ", programId.toBase58());
  console.log("config:   ", config.toBase58());
  console.log("vault:    ", vault.toBase58());
  console.log("treasury: ", treasury.toBase58());
  console.log("panda_mint:", pandaMint.toBase58());
  console.log("collection:", collection.publicKey.toBase58());

  const existing = await connection.getAccountInfo(config);
  if (existing) {
    console.log("Config already exists -- already initialized. Nothing to do.");
    return;
  }

  // Suggested starting values from docs/TOKENOMICS.md 5.1.
  const args = {
    stepLamports: new BN(500_000),
    epoch0FlatLamports: new BN(10_000_000),
    baseDifficulty: 18,
    collectionName: "Hashpandas",
    collectionUri: "https://hashpandas.example/collection.json",
    royaltyBps: 500,
    royaltyCreators: [{ address: deployer.publicKey, percentage: 100 }],
    royaltyRuleSet: { none: {} },
    buybackAmmProgram: SystemProgram.programId, // placeholder until a real AMM is chosen
    crankSpendCapLamports: new BN(5_000_000),
    maxPriceImpactBps: 500,
  };

  const sig = await program.methods
    .initialize(args)
    .accountsStrict({
      payer: deployer.publicKey,
      authority: deployer.publicKey,
      config,
      vault,
      treasury,
      pandaMint,
      collection: collection.publicKey,
      mplCoreProgram: MPL_CORE_PROGRAM_ID,
      buybackDestTokenAccount,
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    })
    .signers([collection])
    .rpc();

  console.log("initialize OK:", sig);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
