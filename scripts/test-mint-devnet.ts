/**
 * Exercises the exact same mint-args encoding the frontend uses
 * (BN-wrapped nonce/anchorSlot), for real, against devnet, using the
 * deployer keypair as the miner. This is here to verify the "e.toArrayLike
 * is not a function" fix without needing a browser wallet.
 */
import { readFileSync } from "node:fs";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import anchorPkg from "@coral-xyz/anchor";
import type { Idl } from "@coral-xyz/anchor";
import idl from "../target/idl/hashpandas.json" with { type: "json" };
import { keccak256v, leadingZeroBits } from "../app/src/lib/keccak.ts";

const { AnchorProvider, BN, BorshAccountsCoder, Program, Wallet } = anchorPkg;
const accountsCoder = new BorshAccountsCoder(idl as Idl);

const DEVNET_RPC = "https://api.devnet.solana.com";
const MPL_CORE_PROGRAM_ID = new PublicKey("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
const SLOT_HASHES_SYSVAR = new PublicKey("SysvarS1otHashes111111111111111111111111111");

function loadKeypair(path: string): Keypair {
  const raw = JSON.parse(readFileSync(path, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function u64ToLeBytes(v: bigint): Uint8Array {
  const out = new Uint8Array(8);
  let x = v;
  for (let i = 0; i < 8; i++) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

async function main() {
  const deployer = loadKeypair(`${process.env.HOME}/.config/solana/deployer.json`);
  const connection = new Connection(DEVNET_RPC, "confirmed");
  const wallet = new Wallet(deployer);
  const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
  const program = new Program(idl as Idl, provider);
  const programId = program.programId;

  const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], programId);
  const [vault] = PublicKey.findProgramAddressSync([Buffer.from("vault")], programId);
  const [treasury] = PublicKey.findProgramAddressSync([Buffer.from("treasury")], programId);

  const configInfo = await connection.getAccountInfo(config);
  if (!configInfo) throw new Error("config not found -- run initialize-devnet.ts first");
  const configDecoded = accountsCoder.decode("Config", configInfo.data) as {
    base_difficulty: number;
    streak: number;
    last_winning_hash: number[];
    collection: PublicKey;
  };
  const targetBits = configDecoded.base_difficulty + configDecoded.streak;
  console.log("target bits:", targetBits);

  const slotHashesInfo = await connection.getAccountInfo(SLOT_HASHES_SYSVAR);
  if (!slotHashesInfo) throw new Error("SlotHashes sysvar missing");
  const anchorSlot = slotHashesInfo.data.readBigUInt64LE(8);
  const anchorHash = new Uint8Array(slotHashesInfo.data.subarray(16, 48));
  console.log("anchor slot:", anchorSlot.toString());

  const lastWinningHash = Uint8Array.from(configDecoded.last_winning_hash);
  const minerBytes = deployer.publicKey.toBytes();

  console.log("mining...");
  let nonce = 0n;
  let hash: Uint8Array;
  for (;;) {
    hash = keccak256v([minerBytes, u64ToLeBytes(nonce), lastWinningHash, anchorHash]);
    if (leadingZeroBits(hash) >= targetBits) break;
    nonce++;
  }
  console.log("found nonce", nonce.toString());

  const asset = Keypair.generate();
  const [panda] = PublicKey.findProgramAddressSync(
    [Buffer.from("panda"), asset.publicKey.toBuffer()],
    programId,
  );

  const sig = await program.methods
    .mint({
      nonce: new BN(nonce.toString()),
      anchorSlot: new BN(anchorSlot.toString()),
      anchorHash: Array.from(anchorHash),
      uri: "https://hashpandas.example/metadata/pending.json",
    })
    .accountsStrict({
      miner: deployer.publicKey,
      config,
      vault,
      treasury,
      collection: configDecoded.collection,
      asset: asset.publicKey,
      panda,
      mplCoreProgram: MPL_CORE_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([asset])
    .rpc();

  console.log("mint OK:", sig);
  console.log("asset:", asset.publicKey.toBase58());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
