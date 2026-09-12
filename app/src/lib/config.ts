import { BorshAccountsCoder } from "@coral-xyz/anchor";
import type { Connection } from "@solana/web3.js";
import idl from "./idl.json";
import { configPda } from "./pda";

const coder = new BorshAccountsCoder(idl as ConstructorParameters<typeof BorshAccountsCoder>[0]);

export interface ConfigAccount {
  authority: string;
  treasury: string;
  vault: string;
  collection: string;
  pandaMint: string;
  stepLamports: bigint;
  epoch0FlatLamports: bigint;
  supply: bigint;
  epoch: number;
  acc: bigint;
  eligibleLiving: bigint;
  eligibleBurned: bigint;
  baseDifficulty: number;
  streak: number;
  lastWinningHash: Uint8Array;
  lastMintSlot: bigint;
  epochAccSnapshot: bigint[];
}

/** ACC_SCALE from economics.rs -- the accumulator's fixed-point scale. */
export const ACC_SCALE = 1_000_000_000_000n;

/** claimable_lamports, mirrored from economics.rs exactly. */
export function claimableLamports(
  config: ConfigAccount,
  mintEpoch: number,
  claimedScaled: bigint,
): bigint {
  const target = mintEpoch + 1;
  if (target >= config.epochAccSnapshot.length || target > config.epoch) return 0n;
  const cursor = config.epochAccSnapshot[target];
  const gross = config.acc > cursor ? config.acc - cursor : 0n;
  const net = gross > claimedScaled ? gross - claimedScaled : 0n;
  return net / ACC_SCALE;
}

function big(v: unknown): bigint {
  return BigInt((v as { toString(): string }).toString());
}

/** Reads and decodes the singleton Config account. Works without a
 * connected wallet -- this is a read, not a transaction. */
export async function fetchConfig(connection: Connection): Promise<ConfigAccount | null> {
  const [pda] = configPda();
  const info = await connection.getAccountInfo(pda);
  if (!info) return null;
  const raw = coder.decode("Config", info.data) as Record<string, unknown>;
  return {
    authority: (raw.authority as { toString(): string }).toString(),
    treasury: (raw.treasury as { toString(): string }).toString(),
    vault: (raw.vault as { toString(): string }).toString(),
    collection: (raw.collection as { toString(): string }).toString(),
    pandaMint: (raw.panda_mint as { toString(): string }).toString(),
    stepLamports: big(raw.step_lamports),
    epoch0FlatLamports: big(raw.epoch0_flat_lamports),
    supply: big(raw.supply),
    epoch: raw.epoch as number,
    acc: big(raw.acc),
    eligibleLiving: big(raw.eligible_living),
    eligibleBurned: big(raw.eligible_burned),
    baseDifficulty: raw.base_difficulty as number,
    streak: raw.streak as number,
    lastWinningHash: Uint8Array.from(raw.last_winning_hash as number[]),
    lastMintSlot: big(raw.last_mint_slot),
    epochAccSnapshot: (raw.epoch_acc_snapshot as unknown[]).map(big),
  };
}

/** epoch_start_supply(e) = 8 * (2^e - 1), mirrored from economics.rs. */
export function epochStartSupply(epoch: number): bigint {
  return 8n * ((1n << BigInt(epoch)) - 1n);
}

/** entry_price(epoch), mirrored client-side for display, matching
 * economics.rs::entry_price exactly (epoch 0 flat, else start_supply*step). */
export function priceAtEpoch(config: ConfigAccount, epoch: number): bigint {
  if (epoch === 0) return config.epoch0FlatLamports;
  return epochStartSupply(epoch) * config.stepLamports;
}

export function entryPriceLamports(config: ConfigAccount): bigint {
  return priceAtEpoch(config, config.epoch);
}

/** What the price becomes the moment the current epoch closes. Not always
 * higher than the current price across the epoch-0 boundary specifically --
 * epoch0_flat_lamports is set independently (it has to cover Solana rent
 * costs with nobody yet to pay rent to), so it can start above or below
 * where the epoch-1 formula price lands. From epoch 1 onward it's strictly
 * increasing, since epoch_start_supply always is. */
export function nextEntryPriceLamports(config: ConfigAccount): bigint {
  return priceAtEpoch(config, config.epoch + 1);
}
