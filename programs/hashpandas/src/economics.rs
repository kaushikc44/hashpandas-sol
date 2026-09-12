//! Pure, panic-free economics. No Anchor types, no accounts, no I/O.
//!
//! This module mirrors `sim/economics.py` line for line. That Python file is
//! verified against the original Hashpandas published figures; if you change a
//! formula in one place, change it in the other and re-run both test suites.
//!
//! EVERYTHING HERE IS INTEGER MATH IN LAMPORTS. There are no floats anywhere
//! in this program, and there must never be.

use anchor_lang::prelude::*;

use crate::errors::HashpandasError;

// ---------------------------------------------------------------------------
// Structural constants
// ---------------------------------------------------------------------------

/// Epoch 0 holds 8 pandas; every later epoch is twice the size of the one before.
pub const FIRST_EPOCH_SIZE: u64 = 8;

/// Share of every mint that accrues to earlier pandas, in basis points.
pub const HOLDER_BPS: u64 = 7_000;
/// Share of every mint that funds the buyback/treasury, in basis points.
pub const HOOK_BPS: u64 = 3_000;
pub const BPS_DENOM: u64 = 10_000;

/// Tokens returned for a panda burned during its own epoch. Halves per epoch waited.
pub const BURN_BASE_UNITS: u64 = 1_000;

/// Hard cap on epochs. 8 * (2^24 - 1) is ~134M pandas -- far past any real run,
/// and it keeps `1u64 << e` provably safe.
pub const MAX_EPOCH: u8 = 24;

/// Fixed-point scale for the rent accumulator.
///
/// The accumulator stores "lamports owed per living eligible panda" and is
/// divided by the live holder count on every mint, so it needs sub-lamport
/// resolution or rounding dust compounds over 16k mints. u128 with 1e12 scale
/// leaves enormous headroom: the largest realistic acc value is well under 1e30.
pub const ACC_SCALE: u128 = 1_000_000_000_000;

// ---------------------------------------------------------------------------
// Supply / epoch geometry
// ---------------------------------------------------------------------------

/// Pandas that already existed when epoch `e` opened: 8 * (2^e - 1).
///
/// This single number is BOTH the price multiplier AND the exact count of rent
/// recipients. That coincidence is the whole design -- see `rent_step`.
pub fn epoch_start_supply(e: u8) -> Result<u64> {
    require!(e <= MAX_EPOCH, HashpandasError::EpochOverflow);
    Ok(FIRST_EPOCH_SIZE * ((1u64 << e) - 1))
}

/// Number of pandas in epoch `e`.
pub fn epoch_size(e: u8) -> Result<u64> {
    require!(e <= MAX_EPOCH, HashpandasError::EpochOverflow);
    Ok(FIRST_EPOCH_SIZE << e)
}

/// The epoch a 1-based panda index belongs to.
pub fn epoch_of_cat(index_1based: u64) -> Result<u8> {
    let mut e: u8 = 0;
    while e < MAX_EPOCH && index_1based > epoch_start_supply(e + 1)? {
        e += 1;
    }
    Ok(e)
}

// ---------------------------------------------------------------------------
// Price
// ---------------------------------------------------------------------------

/// Entry price in lamports. Flat inside an epoch, fixed at the epoch boundary.
///
///   price(e) = epoch_start_supply(e) * step
///
/// Epoch 0 is the exception: there is nobody to pay rent to yet, so it is a
/// flat price and 100% of it funds the hook.
///
/// SOLANA-SPECIFIC CONSTRAINT: `epoch0_flat` must comfortably exceed the
/// rent-exemption cost of the Metaplex Core asset account (~0.0029 SOL) plus
/// transaction fees, or the protocol subsidises every mint in epoch 0 and
/// loses money. See docs/TOKENOMICS.md.
pub fn entry_price(e: u8, step: u64, epoch0_flat: u64) -> Result<u64> {
    if e == 0 {
        return Ok(epoch0_flat);
    }
    epoch_start_supply(e)?
        .checked_mul(step)
        .ok_or_else(|| error!(HashpandasError::Overflow))
}

/// What ONE mint owes ONE eligible panda. A constant, by construction:
///
///   70% of price / recipients
///     = 0.70 * (epoch_start_supply * step) / epoch_start_supply
///     = 0.70 * step
///
/// The supply term cancels. That cancellation is precisely why the price can
/// stay flat across a whole epoch while the per-panda rate never moves.
///
/// Choose `step` so that step * HOLDER_BPS is divisible by BPS_DENOM, i.e. a
/// multiple of 5 lamports, so this is exact with no truncation.
pub fn rent_step(step: u64) -> Result<u64> {
    step.checked_mul(HOLDER_BPS)
        .map(|v| v / BPS_DENOM)
        .ok_or_else(|| error!(HashpandasError::Overflow))
}

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

/// A panda is paid by mints of LATER epochs only, never by its own neighbours.
/// It starts earning once total supply reaches the next epoch's opening supply.
pub fn eligibility_supply(mint_epoch: u8) -> Result<u64> {
    epoch_start_supply(mint_epoch + 1)
}

// ---------------------------------------------------------------------------
// Burn returns
// ---------------------------------------------------------------------------

/// Token units returned on burn: 1000 in the panda's own epoch, halving per
/// epoch waited, flooring to zero once the shift exhausts the base.
pub fn burn_units(epochs_waited: u8) -> u64 {
    if epochs_waited >= 10 {
        0
    } else {
        BURN_BASE_UNITS >> epochs_waited
    }
}

/// Arbitrage ceiling on the token: entry price / 1000.
///
/// Above this, minting a panda and burning it is cheaper than buying the tokens
/// on the open market, so the trade pins the price down. The ceiling doubles
/// every epoch, driven by nothing but the cost of making the next panda.
pub fn token_price_ceiling(current_epoch: u8, step: u64, epoch0_flat: u64) -> Result<u64> {
    Ok(entry_price(current_epoch, step, epoch0_flat)? / BURN_BASE_UNITS)
}

// ---------------------------------------------------------------------------
// The mint split -- the one function where a bug loses real money
// ---------------------------------------------------------------------------

pub struct MintSplit {
    /// Lamports that must STAY in the vault as claimable holder rent.
    pub to_holders: u64,
    /// Lamports transferred to the hook/treasury immediately.
    pub to_hook: u64,
    /// Amount to add to the global accumulator, already ACC_SCALE-scaled.
    pub acc_delta: u128,
    pub price: u64,
}

/// Split one mint.
///
/// `eligible_living` + `eligible_burned` MUST equal `epoch_start_supply(e)`.
/// The caller (the mint instruction) is responsible for that invariant and
/// should assert it; this function re-checks it as a last line of defence.
///
/// Burned pandas keep their slot in the recipient count, but their share is
/// re-split by the same 70/30 rule -- 70% to the pandas still alive, 30% to the
/// hook. So every burn permanently raises the rate for everyone still holding,
/// and permanently raises the hook's effective take above 30%.
///
///   at 50% burned: survivors earn 1.70x, and the hook takes 40.5% per mint.
pub fn split_mint(
    e: u8,
    step: u64,
    epoch0_flat: u64,
    eligible_living: u64,
    eligible_burned: u64,
) -> Result<MintSplit> {
    let price = entry_price(e, step, epoch0_flat)?;
    let recipients = epoch_start_supply(e)?;

    // Epoch 0: no recipients exist, so the whole payment funds the hook.
    if recipients == 0 {
        return Ok(MintSplit { to_holders: 0, to_hook: price, acc_delta: 0, price });
    }

    require!(
        eligible_living
            .checked_add(eligible_burned)
            .ok_or_else(|| error!(HashpandasError::Overflow))?
            == recipients,
        HashpandasError::Overflow
    );
    require!(eligible_living > 0, HashpandasError::NoLivingHolders);

    let rs = rent_step(step)?;
    let living_share = eligible_living
        .checked_mul(rs)
        .ok_or_else(|| error!(HashpandasError::Overflow))?;
    let dead_share = eligible_burned
        .checked_mul(rs)
        .ok_or_else(|| error!(HashpandasError::Overflow))?;

    let dead_to_living = dead_share * HOLDER_BPS / BPS_DENOM;
    let to_holders = living_share
        .checked_add(dead_to_living)
        .ok_or_else(|| error!(HashpandasError::Overflow))?;

    // The hook gets its flat 30% plus 30% of what the dead pandas gave up.
    // Computed as a remainder so that to_holders + to_hook == price EXACTLY,
    // with no rounding dust stranded in the vault.
    let to_hook = price
        .checked_sub(to_holders)
        .ok_or_else(|| error!(HashpandasError::Overflow))?;

    let acc_delta = (to_holders as u128)
        .checked_mul(ACC_SCALE)
        .ok_or_else(|| error!(HashpandasError::Overflow))?
        / (eligible_living as u128);

    Ok(MintSplit { to_holders, to_hook, acc_delta, price })
}

/// Lamports a panda can currently claim.
///
///   claimable = (acc_now - acc_when_it_became_eligible - already_claimed) / SCALE
///
/// Saturating rather than checked on the subtraction: a cursor above `acc` can
/// only mean the panda is not yet eligible, which is zero, not an error.
pub fn claimable_lamports(acc_now: u128, cursor: u128, claimed_scaled: u128) -> u64 {
    let gross = acc_now.saturating_sub(cursor);
    let net = gross.saturating_sub(claimed_scaled);
    (net / ACC_SCALE) as u64
}

// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // Reference values from the original collection, in wei-equivalents.
    // Here we use lamport-style integers with step = 20_000 "units" so the
    // ratios match the published ETH figures exactly.
    const STEP: u64 = 20_000;
    const E0: u64 = 69_000;

    #[test]
    fn geometry_matches_reference() {
        assert_eq!(epoch_start_supply(6).unwrap(), 504);
        assert_eq!(epoch_start_supply(7).unwrap(), 1016); // trading gate
        assert_eq!(epoch_start_supply(8).unwrap(), 2040);
        assert_eq!(epoch_of_cat(505).unwrap(), 6);
        assert_eq!(epoch_of_cat(64).unwrap(), 3);
    }

    #[test]
    fn price_matches_reference() {
        assert_eq!(entry_price(6, STEP, E0).unwrap(), 10_080_000); // 0.01008
        assert_eq!(entry_price(8, STEP, E0).unwrap(), 40_800_000); // 0.0408
        assert_eq!(entry_price(5, STEP, E0).unwrap(), 4_960_000);  // 0.00496
        assert_eq!(entry_price(3, STEP, E0).unwrap(), 1_120_000);  // 0.00112
    }

    #[test]
    fn the_identity_holds() {
        // 504 recipients * rent_step == exactly 70% of the epoch 6 price.
        let rs = rent_step(STEP).unwrap();
        assert_eq!(rs, 14_000);
        assert_eq!(504 * rs, entry_price(6, STEP, E0).unwrap() * 7 / 10);
    }

    #[test]
    fn burn_curve_matches_reference() {
        assert_eq!(burn_units(0), 1000);
        assert_eq!(burn_units(3), 125);
        // panda #64 burned 3 epochs later, valued at the epoch 6 ceiling
        let ceiling = token_price_ceiling(6, STEP, E0).unwrap();
        assert_eq!(burn_units(3) * ceiling, 1_260_000); // 0.00126
    }

    #[test]
    fn no_burns_splits_seventy_thirty_exactly() {
        let s = split_mint(6, STEP, E0, 504, 0).unwrap();
        assert_eq!(s.to_holders + s.to_hook, s.price);
        assert_eq!(s.to_hook * 10_000 / s.price, 3_000);
    }

    #[test]
    fn half_burned_pays_survivors_1_7x_and_hook_40_5_percent() {
        let clean = split_mint(6, STEP, E0, 504, 0).unwrap();
        let dirty = split_mint(6, STEP, E0, 252, 252).unwrap();
        // survivors earn 1.70x per mint
        assert_eq!(dirty.acc_delta * 10 / clean.acc_delta, 17);
        // hook's effective take rises to 40.5%
        assert_eq!(dirty.to_hook * 10_000 / dirty.price, 4_050);
        // and the split is still exact
        assert_eq!(dirty.to_holders + dirty.to_hook, dirty.price);
    }

    #[test]
    fn split_is_always_exact_across_every_burn_level() {
        for burned in 0..=504u64 {
            if burned == 504 { continue; } // NoLivingHolders is handled upstream
            let s = split_mint(6, STEP, E0, 504 - burned, burned).unwrap();
            assert_eq!(s.to_holders + s.to_hook, s.price, "dust at burned={}", burned);
        }
    }
}
