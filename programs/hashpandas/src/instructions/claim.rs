use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer};

use mpl_core::accounts::BaseAssetV1;

use crate::errors::HashpandasError;
use crate::state::{Config, Panda};

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(mut)]
    pub claimant: Signer<'info>,

    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,

    /// CHECK: lamport-only vault; identity pinned to `config.vault`.
    #[account(mut, address = config.vault)]
    pub vault: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [b"panda", panda.asset.as_ref()],
        bump = panda.bump,
    )]
    pub panda: Account<'info, Panda>,

    /// The Metaplex Core asset itself. Its CURRENT owner, not whoever
    /// minted it, is who is allowed to claim -- the rent follows the panda
    /// through a sale.
    /// CHECK: address pinned to `panda.asset`; ownership of the *asset* is
    /// verified by deserializing its data below, not by this constraint.
    #[account(address = panda.asset, owner = mpl_core::ID)]
    pub asset: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handle_claim(ctx: Context<Claim>) -> Result<()> {
    require!(!ctx.accounts.panda.burned, HashpandasError::PandaBurned);

    let asset = BaseAssetV1::try_from(&ctx.accounts.asset.to_account_info())
        .map_err(|_| error!(HashpandasError::AssetDeserializeFailed))?;
    require_keys_eq!(
        asset.owner,
        ctx.accounts.claimant.key(),
        HashpandasError::NotAssetOwner
    );

    let config = &mut ctx.accounts.config;
    let panda = &mut ctx.accounts.panda;

    let claim_lamports = config.settle_panda_rent(panda);
    require!(claim_lamports > 0, HashpandasError::NothingToClaim);

    let vault_bump = config.vault_bump;
    let vault_seeds: &[&[u8]] = &[b"vault", &[vault_bump]];

    system_program::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.system_program.key(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.claimant.to_account_info(),
            },
            &[vault_seeds],
        ),
        claim_lamports,
    )?;

    Ok(())
}
