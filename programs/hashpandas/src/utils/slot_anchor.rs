//! Freshness anchor for the PoW preimage, read from the SlotHashes sysvar.
//!
//! `SlotHashes` is a ~20KB account, and `bincode::deserialize::<SlotHashes>`
//! (a `Vec<(Slot, Hash)>`) would allocate and copy the whole thing on every
//! mint. We never do that. `PodSlotHashes` uses the `sol_get_sysvar` syscall
//! to fetch the sysvar's raw bytes directly (no CPI account even needed) and
//! binary-searches them as plain-old-data -- this is the modern equivalent of
//! hand-parsing the account bytes ourselves.

use anchor_lang::prelude::*;
use solana_sysvar::slot_hashes::PodSlotHashes;

use crate::errors::HashpandasError;

/// How far back a miner may reach for an anchor slot. Generous enough that a
/// card that has been hashing for a couple of minutes doesn't get its
/// submission rejected just for being slow to land, but bounded enough that
/// the anchor cannot be a hash any observer would call "stale".
pub const RECENT_SLOT_WINDOW: u64 = 150;

/// Confirms that `anchor_slot` is recent and that `anchor_hash` is genuinely
/// the hash Solana recorded for that slot.
pub fn verify_anchor(current_slot: u64, anchor_slot: u64, anchor_hash: [u8; 32]) -> Result<()> {
    require_gte!(current_slot, anchor_slot, HashpandasError::AnchorInFuture);
    require!(
        current_slot - anchor_slot <= RECENT_SLOT_WINDOW,
        HashpandasError::AnchorTooOld
    );

    let slot_hashes =
        PodSlotHashes::fetch().map_err(|_| error!(HashpandasError::SysvarReadFailed))?;
    let hash = slot_hashes
        .get(&anchor_slot)
        .map_err(|_| error!(HashpandasError::SysvarReadFailed))?
        .ok_or_else(|| error!(HashpandasError::AnchorNotFound))?;

    require!(
        hash.to_bytes() == anchor_hash,
        HashpandasError::AnchorHashMismatch
    );
    Ok(())
}

/// Bit-level leading-zero count across the full 32-byte hash. Difficulty is
/// specified in bits, not nibbles or bytes, so this can't shortcut on bytes
/// alone.
pub fn leading_zero_bits(hash: &[u8; 32]) -> u32 {
    let mut bits = 0u32;
    for byte in hash.iter() {
        if *byte == 0 {
            bits += 8;
        } else {
            bits += byte.leading_zeros();
            break;
        }
    }
    bits
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn leading_zero_bits_counts_across_byte_boundaries() {
        let mut h = [0xffu8; 32];
        h[0] = 0x00;
        h[1] = 0x00;
        h[2] = 0x0f; // 4 leading zero bits in this byte
        assert_eq!(leading_zero_bits(&h), 20);

        assert_eq!(leading_zero_bits(&[0u8; 32]), 256);
        assert_eq!(leading_zero_bits(&[0xffu8; 32]), 0);
    }

    // `verify_anchor` calls the `sol_get_sysvar` syscall, which is only
    // meaningfully exercised under a real (or litesvm-emulated) runtime --
    // see tests/mint.rs for the integration-level coverage of the freshness
    // and hash-match checks.
}
