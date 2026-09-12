import { BorshAccountsCoder } from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import idl from "./idl.json";
import { PROGRAM_ID } from "./constants";

const coder = new BorshAccountsCoder(idl as ConstructorParameters<typeof BorshAccountsCoder>[0]);

const PANDA_DISCRIMINATOR = Buffer.from(
  (idl.accounts.find((a) => a.name === "Panda") as { discriminator: number[] }).discriminator,
);

export interface PandaAccount {
  address: PublicKey;
  asset: PublicKey;
  index: bigint;
  mintEpoch: number;
  mintedUnix: bigint;
  seed: Uint8Array;
  workHash: Uint8Array;
  claimedScaled: bigint;
  burned: boolean;
}

function decodePanda(address: PublicKey, data: Buffer): PandaAccount {
  const raw = coder.decode("Panda", data) as Record<string, unknown>;
  return {
    address,
    asset: raw.asset as PublicKey,
    index: BigInt((raw.index as { toString(): string }).toString()),
    mintEpoch: raw.mint_epoch as number,
    mintedUnix: BigInt((raw.minted_unix as { toString(): string }).toString()),
    seed: Uint8Array.from(raw.seed as number[]),
    workHash: Uint8Array.from(raw.work_hash as number[]),
    claimedScaled: BigInt((raw.claimed_scaled as { toString(): string }).toString()),
    burned: raw.burned as boolean,
  };
}

/** All Panda accounts this program has ever created (fine at devnet-demo
 * scale; a production gallery would paginate or use an indexer). */
export async function fetchAllPandas(connection: Connection): Promise<PandaAccount[]> {
  const accounts = await connection.getProgramAccounts(PROGRAM_ID, {
    filters: [{ memcmp: { offset: 0, bytes: bs58.encode(PANDA_DISCRIMINATOR) } }],
  });
  return accounts.map(({ pubkey, account }) => decodePanda(pubkey, account.data));
}

/** Reads just the `owner` field (byte 1..33) out of a raw Metaplex Core
 * BaseAssetV1 account -- `key: Key` (1-byte enum) is the discriminator,
 * `owner: Pubkey` immediately follows it. */
export function readAssetOwners(
  infos: ({ data: Buffer } | null)[],
): (PublicKey | null)[] {
  return infos.map((info) => {
    if (!info || info.data.length < 33) return null;
    return new PublicKey(info.data.subarray(1, 33));
  });
}

/** Fetches every panda owned by `owner`, batching the asset-ownership
 * lookups. */
export async function fetchPandasOwnedBy(
  connection: Connection,
  owner: PublicKey,
): Promise<PandaAccount[]> {
  const all = await fetchAllPandas(connection);
  if (all.length === 0) return [];

  const assetInfos = await connection.getMultipleAccountsInfo(all.map((p) => p.asset));
  const owners = readAssetOwners(assetInfos.map((i) => (i ? { data: i.data } : null)));

  return all.filter((_, idx) => owners[idx]?.equals(owner));
}
