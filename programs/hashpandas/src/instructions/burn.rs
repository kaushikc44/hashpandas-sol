use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer};
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount};

use mpl_core::accounts::BaseAssetV1;
use mpl_core::instructions::BurnV1CpiBuilder;

use crate::economics;
use crate::errors::HashpandasError;
use crate::state::{Config, Panda};

/// Minimum time a panda must have existed before it can be burned.
pub const MIN_SECONDS_BEFORE_BURN: i64 = 10 * 60;

#[derive(Accounts)]
pub struct Burn<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    // Boxed: this Accounts struct carries enough typed accounts that
    // deserializing them all inline blew the 4KB BPF stack-frame limit in
    // `try_accounts`. Boxing moves each account's data onto the heap instead.
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,

    /// CHECK: lamport-only vault; identity pinned to `config.vault`.
    #[account(mut, address = config.vault)]
    pub vault: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [b"panda", panda.asset.as_ref()],
        bump = panda.bump,
    )]
    pub panda: Box<Account<'info, Panda>>,

    /// CHECK: address pinned to `panda.asset`; ownership verified below by
    /// deserializing the asset, and again by mpl-core itself checking that
    /// `owner` is a valid authority (owner or delegate) for it.
    #[account(mut, address = panda.asset, owner = mpl_core::ID)]
    pub asset: UncheckedAccount<'info>,

    /// CHECK: identity pinned to `config.collection`.
    #[account(mut, address = config.collection)]
    pub collection: UncheckedAccount<'info>,

    #[account(mut, address = config.panda_mint)]
    pub panda_mint: Box<Account<'info, Mint>>,

    /// The burner's $PANDA token account. Must already exist -- this
    /// instruction mints the burn reward into it but doesn't create it.
    #[account(
        mut,
        associated_token::mint = panda_mint,
        associated_token::authority = owner,
    )]
    pub reward_token_account: Box<Account<'info, TokenAccount>>,

    /// CHECK: address-constrained to the real Metaplex Core program.
    #[account(address = mpl_core::ID)]
    pub mpl_core_program: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handle_burn(ctx: Context<Burn>) -> Result<()> {
    let clock = Clock::get()?;

    require!(!ctx.accounts.panda.burned, HashpandasError::AlreadyBurned);
    require!(
        ctx.accounts.config.supply > ctx.accounts.panda.index,
        HashpandasError::NoLaterPanda
    );
    require!(
        clock.unix_timestamp - ctx.accounts.panda.minted_unix >= MIN_SECONDS_BEFORE_BURN,
        HashpandasError::TooEarly
    );

    let asset_data = BaseAssetV1::try_from(&ctx.accounts.asset.to_account_info())
        .map_err(|_| error!(HashpandasError::AssetDeserializeFailed))?;
    require_keys_eq!(
        asset_data.owner,
        ctx.accounts.owner.key(),
        HashpandasError::NotAssetOwner
    );

    // 1. Settle accrued rent first.
    let settle_lamports = {
        let config = &mut ctx.accounts.config;
        let panda = &mut ctx.accounts.panda;
        config.settle_panda_rent(panda)
    };
    if settle_lamports > 0 {
        let vault_bump = ctx.accounts.config.vault_bump;
        let vault_seeds: &[&[u8]] = &[b"vault", &[vault_bump]];
        system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.key(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.owner.to_account_info(),
                },
                &[vault_seeds],
            ),
            settle_lamports,
        )?;
    }

    // 2. Mark burned.
    ctx.accounts.panda.burned = true;
    let mint_epoch = ctx.accounts.panda.mint_epoch;

    // 3. Move the cohort counters.
    let config = &mut ctx.accounts.config;
    config.record_burn(mint_epoch)?;

    // 4. Mint $PANDA: 1000 units in the panda's own epoch, halving per
    // epoch waited (see `economics::burn_units`).
    let epochs_waited = config.epoch.saturating_sub(mint_epoch);
    let units = economics::burn_units(epochs_waited);
    if units > 0 {
        let config_bump = config.bump;
        let config_seeds: &[&[u8]] = &[b"config", &[config_bump]];
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                MintTo {
                    mint: ctx.accounts.panda_mint.to_account_info(),
                    to: ctx.accounts.reward_token_account.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                &[config_seeds],
            ),
            units,
        )?;
    }

    // 5. Only now destroy the actual Core asset -- our accounting above is
    // what makes the burn real; this just makes it visible in the wallet.
    BurnV1CpiBuilder::new(&ctx.accounts.mpl_core_program.to_account_info())
        .asset(&ctx.accounts.asset.to_account_info())
        .collection(Some(&ctx.accounts.collection.to_account_info()))
        .payer(&ctx.accounts.owner.to_account_info())
        .authority(Some(&ctx.accounts.owner.to_account_info()))
        .system_program(Some(&ctx.accounts.system_program.to_account_info()))
        .invoke()?;

    Ok(())
}
