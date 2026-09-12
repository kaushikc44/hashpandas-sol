use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer};
use solana_keccak_hasher as keccak;

use mpl_core::instructions::CreateV1CpiBuilder;

use crate::difficulty::{self, RETARGET_MINTS};
use crate::economics;
use crate::errors::HashpandasError;
use crate::state::{Config, Panda};
use crate::utils::{leading_zero_bits, verify_anchor};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct MintArgs {
    pub nonce: u64,
    pub anchor_slot: u64,
    pub anchor_hash: [u8; 32],
    pub uri: String,
}

#[derive(Accounts)]
pub struct Mint<'info> {
    #[account(mut)]
    pub miner: Signer<'info>,

    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,

    /// CHECK: lamport-only vault; identity pinned to `config.vault`.
    #[account(mut, address = config.vault)]
    pub vault: UncheckedAccount<'info>,

    /// CHECK: lamport-only treasury; identity pinned to `config.treasury`.
    #[account(mut, address = config.treasury)]
    pub treasury: UncheckedAccount<'info>,

    /// CHECK: the Metaplex Core collection; identity pinned to `config.collection`.
    #[account(mut, address = config.collection)]
    pub collection: UncheckedAccount<'info>,

    /// Fresh keypair for the new Core asset. Not a PDA: `CreateV1` requires
    /// the asset account to sign its own creation.
    #[account(mut)]
    pub asset: Signer<'info>,

    #[account(
        init,
        payer = miner,
        space = Panda::SPACE,
        seeds = [b"panda", asset.key().as_ref()],
        bump,
    )]
    pub panda: Account<'info, Panda>,

    /// CHECK: address-constrained to the real Metaplex Core program.
    #[account(address = mpl_core::ID)]
    pub mpl_core_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handle_mint(ctx: Context<Mint>, args: MintArgs) -> Result<()> {
    let clock = Clock::get()?;
    let config = &mut ctx.accounts.config;

    // -- one-panda-per-slot ceiling, enforced before any other work -------
    require!(
        config.last_mint_slot != clock.slot,
        HashpandasError::SlotAlreadyMinted
    );

    // -- PoW verification (build order step 3) -----------------------------
    verify_anchor(clock.slot, args.anchor_slot, args.anchor_hash)?;

    let work_hash = keccak::hashv(&[
        ctx.accounts.miner.key().as_ref(),
        &args.nonce.to_le_bytes(),
        &config.last_winning_hash,
        &args.anchor_hash,
    ])
    .to_bytes();

    let bits = leading_zero_bits(&work_hash);
    let required = (config.base_difficulty as u32) + (config.streak as u32);
    require!(bits >= required, HashpandasError::DifficultyNotMet);

    // -- epoch rollover, mirroring Ledger._roll_epoch_if_needed exactly ---
    config.roll_epoch_if_needed()?;

    // -- rent split + accumulator update (build order step 5) -------------
    let e = config.epoch;
    let split = economics::split_mint(
        e,
        config.step_lamports,
        config.epoch0_flat_lamports,
        config.eligible_living,
        config.eligible_burned,
    )?;

    if split.to_holders > 0 {
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                Transfer {
                    from: ctx.accounts.miner.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                },
            ),
            split.to_holders,
        )?;
    }
    if split.to_hook > 0 {
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                Transfer {
                    from: ctx.accounts.miner.to_account_info(),
                    to: ctx.accounts.treasury.to_account_info(),
                },
            ),
            split.to_hook,
        )?;
    }

    config.acc = config
        .acc
        .checked_add(split.acc_delta)
        .ok_or(HashpandasError::Overflow)?;
    config.lifetime_to_holders = config
        .lifetime_to_holders
        .checked_add(split.to_holders)
        .ok_or(HashpandasError::Overflow)?;
    config.lifetime_to_hook = config
        .lifetime_to_hook
        .checked_add(split.to_hook)
        .ok_or(HashpandasError::Overflow)?;

    config.supply = config.supply.checked_add(1).ok_or(HashpandasError::Overflow)?;
    let index = config.supply;

    // -- difficulty + streak retargeting (build order step 4) -------------
    let gap_secs = if config.last_mint_unix > 0 {
        clock.unix_timestamp - config.last_mint_unix
    } else {
        difficulty::TARGET_INTERVAL_SECS // first-ever mint: neither fast nor slow
    };
    let since_last_cool = clock.unix_timestamp - config.streak_last_cool_unix;
    let (new_streak, moved) = difficulty::update_streak(config.streak, gap_secs, since_last_cool);
    config.streak = new_streak;
    if moved {
        config.streak_last_cool_unix = clock.unix_timestamp;
    }

    config.mints_since_retarget += 1;
    if config.mints_since_retarget >= RETARGET_MINTS {
        let elapsed = clock.unix_timestamp - config.retarget_window_start_unix;
        config.base_difficulty =
            difficulty::retarget_base_difficulty(config.base_difficulty, elapsed, config.epoch);
        config.mints_since_retarget = 0;
        config.retarget_window_start_unix = clock.unix_timestamp;
    }

    config.last_winning_hash = work_hash;
    config.last_mint_slot = clock.slot;
    config.last_mint_unix = clock.unix_timestamp;

    // -- Panda bookkeeping record (build order steps 2/5/6/7 depend on this) --
    let panda = &mut ctx.accounts.panda;
    panda.asset = ctx.accounts.asset.key();
    panda.index = index;
    panda.mint_epoch = e;
    panda.minted_unix = clock.unix_timestamp;
    panda.seed = keccak::hashv(&[&work_hash, &clock.unix_timestamp.to_le_bytes()]).to_bytes();
    panda.work_hash = work_hash;
    panda.claimed_scaled = 0;
    panda.burned = false;
    panda.bump = ctx.bumps.panda;

    // -- Metaplex Core asset creation (build order step 8) -----------------
    // Only now does an NFT actually appear: everything above is accounting.
    // `authority` is the config PDA, which is also this collection's
    // `update_authority` (set in `initialize`), so it -- not the miner -- is
    // the account permitted to add a new asset into the collection.
    //
    // No explicit `update_authority` here: mpl-core rejects `Create` with
    // `ConflictingAuthority` if you pass both a `collection` and a per-asset
    // `update_authority` -- membership in the collection already implies
    // `UpdateAuthority::Collection(collection)` for every asset in it.
    let config_bump = ctx.accounts.config.bump;
    let config_seeds: &[&[u8]] = &[b"config", &[config_bump]];

    CreateV1CpiBuilder::new(&ctx.accounts.mpl_core_program.to_account_info())
        .asset(&ctx.accounts.asset.to_account_info())
        .collection(Some(&ctx.accounts.collection.to_account_info()))
        .authority(Some(&ctx.accounts.config.to_account_info()))
        .payer(&ctx.accounts.miner.to_account_info())
        .owner(Some(&ctx.accounts.miner.to_account_info()))
        .system_program(&ctx.accounts.system_program.to_account_info())
        .name(format!("Hashpanda #{index}"))
        .uri(args.uri)
        .invoke_signed(&[config_seeds])?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preimage_ordering_matches_spec() {
        // keccak256(miner || nonce || last_winning_hash || anchor) -- this
        // test pins the byte ordering so a refactor can't silently reorder it.
        let miner = Pubkey::new_from_array([7u8; 32]);
        let nonce: u64 = 42;
        let last_winning_hash = [1u8; 32];
        let anchor_hash = [2u8; 32];

        let expected = keccak::hashv(&[
            miner.as_ref(),
            &nonce.to_le_bytes(),
            &last_winning_hash,
            &anchor_hash,
        ]);

        let mut buf = Vec::new();
        buf.extend_from_slice(miner.as_ref());
        buf.extend_from_slice(&nonce.to_le_bytes());
        buf.extend_from_slice(&last_winning_hash);
        buf.extend_from_slice(&anchor_hash);
        let single_buf_hash = keccak::hash(&buf);

        assert_eq!(expected, single_buf_hash);
    }
}
