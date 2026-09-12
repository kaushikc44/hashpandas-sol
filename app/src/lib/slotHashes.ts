import { Connection, PublicKey } from "@solana/web3.js";

const SLOT_HASHES_SYSVAR = new PublicKey("SysvarS1otHashes111111111111111111111111111");

export interface AnchorSlot {
  slot: bigint;
  hash: Uint8Array;
}

/** Reads the most recent (slot, hash) pair straight out of the raw
 * SlotHashes sysvar bytes -- entries are sorted descending by slot, so
 * index 0 is the most recent, matching what the on-chain program's
 * `utils::verify_anchor` will accept. */
export async function fetchRecentAnchor(connection: Connection): Promise<AnchorSlot> {
  const info = await connection.getAccountInfo(SLOT_HASHES_SYSVAR);
  if (!info) throw new Error("SlotHashes sysvar not found");
  const data = info.data;
  const len = data.readBigUInt64LE(0);
  if (len === 0n) throw new Error("SlotHashes sysvar is empty");
  const slot = data.readBigUInt64LE(8);
  const hash = new Uint8Array(data.subarray(16, 48));
  return { slot, hash };
}
