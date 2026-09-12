use anchor_lang::prelude::*;
use crate::economics::MAX_EPOCH;
use crate::errors::HashpandasError;

/// Singleton. PDA seeds: [b"config"].
///
/// Everything that makes a mint valid and everything that prices it lives in
/// this one account, so a mint touches exactly one writable global. That is
/// also the bottleneck: Solana serialises writes to this account, so mints are
/// effectively one-at-a-time. That is fine -- it IS the "one panda per slot"
/// rule, enforced for free by the runtime rather than by a check.
#[account]
pub struct Config {
    pub authority: Pubkey,
    pub treasury: Pubkey,          // the "hook": buyback + project split
    pub vault: Pubkey,             // PDA holding unclaimed holder rent
    pub collection: Pubkey,        // Metaplex Core collection
    pub panda_mint: Pubkey,         // $PANDA SPL mint, authority = config PDA

    // -- pricing ----------------------------------------------------------
    pub step_lamports: u64,        // must be a multiple of 5 (see rent_step)
    pub epoch0_flat_lamports: u64, // MUST exceed Core asset rent + fees

    // -- supply / epoch ---------------------------------------------------
    pub supply: u64,               // pandas ever minted
    pub epoch: u8,

    // -- rent accumulator -------------------------------------------------
    /// Cumulative lamports owed per LIVING eligible panda, ACC_SCALE-scaled.
    pub acc: u128,
    /// snapshot[e] = `acc` at the moment epoch e opened.
    /// A panda minted in epoch E uses snapshot[E + 1] as its rent cursor, which
    /// is what implements "your own epoch does not pay you".
    /// Fixed array, not a Vec: reallocating a hot global account mid-run is a
    /// failure mode you do not want.
    pub epoch_acc_snapshot: [u128; MAX_EPOCH as usize + 2],

    /// Eligible pandas still alive, and eligible pandas that have been burned.
    /// INVARIANT: eligible_living + eligible_burned == epoch_start_supply(epoch)
    pub eligible_living: u64,
    pub eligible_burned: u64,
    /// Burns of pandas whose epoch has not closed yet, indexed by mint epoch.
    /// Folded into the two counters above at the epoch rollover.
    pub pending_burns: [u32; MAX_EPOCH as usize + 2],

    // -- proof of work ----------------------------------------------------
    pub last_winning_hash: [u8; 32], // chained into the next panda's preimage
    pub base_difficulty: u8,         // leading zero bits, before the streak
    pub last_mint_slot: u64,
    pub last_mint_unix: i64,
    pub retarget_window_start_unix: i64,
    pub mints_since_retarget: u8,
    pub streak: u8,                  // doubles required work per recent mint
    pub streak_last_cool_unix: i64,

    // -- accounting totals (for invariant checks in tests) ----------------
    pub lifetime_to_holders: u64,
    pub lifetime_to_hook: u64,
    pub lifetime_claimed: u64,

    pub bump: u8,
    pub vault_bump: u8,
    /// Needed so the treasury crank (step 9) can `invoke_signed` a spend out
    /// of the treasury PDA the same way claims sign out of the vault PDA.
    pub treasury_bump: u8,

    // -- treasury crank (build order step 9) -------------------------------
    /// The ONLY program the buyback crank may CPI into. This is a keeper, not
    /// a protocol guarantee: whatever this program does with the forwarded
    /// instruction data is trusted at the "which AMM to point this at" level
    /// once, at initialize. See docs/TOKENOMICS.md 5.3.
    pub buyback_amm_program: Pubkey,
    /// Config-owned $PANDA token account the crank buys into.
    pub buyback_dest_token_account: Pubkey,
    /// Hard ceiling on lamports spent by a single crank call.
    pub crank_spend_cap_lamports: u64,
    /// Max allowed shortfall (in bps) of tokens received vs. the caller's
    /// declared reference price -- NOT a real oracle price, see crank.rs.
    pub max_price_impact_bps: u16,
    pub last_crank_slot: u64,
    pub lifetime_buyback_spent_lamports: u64,
    pub lifetime_buyback_tokens_bought: u64,
}

/// One per panda. PDA seeds: [b"panda", asset.key().as_ref()].
///
/// Deliberately NOT stored in the Core asset's Attributes plugin: rent
/// accounting is hot, mutable, and must be writable by this program without
/// a CPI round-trip on every claim.
///
/// The rent claim follows the PANDA, not the address that mined it -- this
/// account is keyed by the asset, so selling the panda transfers the unclaimed
/// rent with it automatically. Claim authority is checked against the Core
/// asset's current owner at claim time.
#[account]
pub struct Panda {
    pub asset: Pubkey,
    pub index: u64,          // 1-based
    pub mint_epoch: u8,
    pub minted_unix: i64,
    pub seed: [u8; 32],      // keccak(work_hash, time_bucket) -- the picture
    pub work_hash: [u8; 32],
    /// Rent already withdrawn, ACC_SCALE-scaled. Kept scaled so that repeated
    /// partial claims cannot lose sub-lamport remainders.
    pub claimed_scaled: u128,
    pub burned: bool,
    pub bump: u8,
}

/// Number of slots in the two fixed arrays. One slot per possible epoch,
/// plus one because `cursor_for`/`_roll_epoch_if_needed` index at `epoch + 1`,
/// plus one so `epoch == MAX_EPOCH` still has a valid `epoch + 1` slot.
pub const EPOCH_SLOTS: usize = MAX_EPOCH as usize + 2;

impl Config {
    /// Account size in bytes, INCLUDING the 8-byte Anchor discriminator.
    ///
    /// Computed field-by-field rather than guessed: the two fixed arrays
    /// (`epoch_acc_snapshot: [u128; EPOCH_SLOTS]`, `pending_burns: [u32; EPOCH_SLOTS]`)
    /// dominate the account and must never be under-allocated, since this
    /// account can never be resized (see CLAUDE.md: no `Vec` in `Config`).
    pub const SPACE: usize = 8 // discriminator
        + 32 // authority
        + 32 // treasury
        + 32 // vault
        + 32 // collection
        + 32 // panda_mint
        + 8  // step_lamports
        + 8  // epoch0_flat_lamports
        + 8  // supply
        + 1  // epoch
        + 16 // acc
        + (16 * EPOCH_SLOTS) // epoch_acc_snapshot: [u128; EPOCH_SLOTS]
        + 8  // eligible_living
        + 8  // eligible_burned
        + (4 * EPOCH_SLOTS) // pending_burns: [u32; EPOCH_SLOTS]
        + 32 // last_winning_hash
        + 1  // base_difficulty
        + 8  // last_mint_slot
        + 8  // last_mint_unix
        + 8  // retarget_window_start_unix
        + 1  // mints_since_retarget
        + 1  // streak
        + 8  // streak_last_cool_unix
        + 8  // lifetime_to_holders
        + 8  // lifetime_to_hook
        + 8  // lifetime_claimed
        + 1  // bump
        + 1  // vault_bump
        + 1  // treasury_bump
        + 32 // buyback_amm_program
        + 32 // buyback_dest_token_account
        + 8  // crank_spend_cap_lamports
        + 2  // max_price_impact_bps
        + 8  // last_crank_slot
        + 8  // lifetime_buyback_spent_lamports
        + 8; // lifetime_buyback_tokens_bought

    /// Rent baseline for a panda: `acc` as it stood when the panda became eligible.
    /// Returns None while the panda's own epoch is still open (it earns nothing).
    pub fn cursor_for(&self, mint_epoch: u8) -> Option<u128> {
        let target = (mint_epoch as usize) + 1;
        if target > self.epoch as usize {
            None
        } else {
            Some(self.epoch_acc_snapshot[target])
        }
    }

    /// Promotes any finished cohorts into the eligible set, mirroring
    /// `economics.Ledger._roll_epoch_if_needed` exactly. Called at the top
    /// of every mint, before pricing it.
    pub fn roll_epoch_if_needed(&mut self) -> Result<()> {
        while self.supply >= crate::economics::epoch_start_supply(self.epoch + 1)? {
            let closing = self.epoch;
            let cohort = crate::economics::epoch_size(closing)?;
            let idx = closing as usize;
            let burned_in_cohort = self.pending_burns[idx] as u64;
            self.eligible_living = self
                .eligible_living
                .checked_add(cohort - burned_in_cohort)
                .ok_or_else(|| error!(HashpandasError::Overflow))?;
            self.eligible_burned = self
                .eligible_burned
                .checked_add(burned_in_cohort)
                .ok_or_else(|| error!(HashpandasError::Overflow))?;
            self.pending_burns[idx] = 0;
            self.epoch += 1;
            require!((self.epoch as usize) < EPOCH_SLOTS, HashpandasError::Overflow);
            let acc_now = self.acc;
            let new_epoch_idx = self.epoch as usize;
            self.epoch_acc_snapshot[new_epoch_idx] = acc_now;
        }
        Ok(())
    }

    /// Moves a burned panda's slot from the living to the burned side of
    /// its cohort -- immediately if that cohort has already closed,
    /// otherwise deferred into `pending_burns` for `roll_epoch_if_needed`
    /// to fold in once it does.
    pub fn record_burn(&mut self, mint_epoch: u8) -> Result<()> {
        if (mint_epoch as usize) + 1 <= self.epoch as usize {
            self.eligible_living = self
                .eligible_living
                .checked_sub(1)
                .ok_or_else(|| error!(HashpandasError::Overflow))?;
            self.eligible_burned = self
                .eligible_burned
                .checked_add(1)
                .ok_or_else(|| error!(HashpandasError::Overflow))?;
        } else {
            let idx = mint_epoch as usize;
            self.pending_burns[idx] = self.pending_burns[idx]
                .checked_add(1)
                .ok_or_else(|| error!(HashpandasError::Overflow))?;
        }
        Ok(())
    }

    /// Settles a panda's currently-claimable rent into `claimed_scaled`,
    /// returning the lamports owed (0 if nothing is claimable). Shared by
    /// `claim` and `burn`, since burn must settle before marking a panda
    /// burned (CLAUDE.md's build order step 7).
    ///
    /// Saturating rather than checked: these totals are bounded by realistic
    /// lifetime SOL volume through this program, many orders of magnitude
    /// below u64/u128 ceilings, so this can't be where an overflow bug hides.
    pub fn settle_panda_rent(&mut self, panda: &mut Panda) -> u64 {
        let cursor = self.cursor_for(panda.mint_epoch).unwrap_or(self.acc);
        let claim_lamports =
            crate::economics::claimable_lamports(self.acc, cursor, panda.claimed_scaled);
        if claim_lamports > 0 {
            panda.claimed_scaled = panda.claimed_scaled.saturating_add(
                (claim_lamports as u128).saturating_mul(crate::economics::ACC_SCALE),
            );
            self.lifetime_claimed = self.lifetime_claimed.saturating_add(claim_lamports);
        }
        claim_lamports
    }
}

impl Panda {
    /// Account size in bytes, including the 8-byte Anchor discriminator.
    pub const SPACE: usize = 8 // discriminator
        + 32 // asset
        + 8  // index
        + 1  // mint_epoch
        + 8  // minted_unix
        + 32 // seed
        + 32 // work_hash
        + 16 // claimed_scaled
        + 1  // burned
        + 1; // bump
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_space_matches_hand_computed_total() {
        assert_eq!(EPOCH_SLOTS, 26);
        // 7 pubkeys, then scalars, then the two EPOCH_SLOTS-sized arrays.
        let scalars = 8 + 8 + 8 + 1 + 16 + 8 + 8 + 32 + 1 + 8 + 8 + 8 + 1 + 1 + 8 + 8 + 8 + 8 + 1
            + 1 + 1 + 8 + 2 + 8 + 8 + 8;
        let arrays = 16 * EPOCH_SLOTS + 4 * EPOCH_SLOTS;
        assert_eq!(Config::SPACE, 8 + 32 * 7 + scalars + arrays);
        assert_eq!(Config::SPACE, 937);
    }

    #[test]
    fn panda_space_matches_field_sum() {
        assert_eq!(Panda::SPACE, 8 + 32 + 8 + 1 + 8 + 32 + 32 + 16 + 1 + 1);
    }
}
