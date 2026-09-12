//! Lets the project authority fix up collection metadata after the fact --
//! added because `initialize`'s `collection_uri` is easy to get wrong once
//! (a placeholder, a URL that later moves) and there was otherwise no way
//! to correct it without redeploying the whole program.

use anchor_lang::prelude::*;

use mpl_core::instructions::UpdateCollectionV1CpiBuilder;

use crate::errors::HashpandasError;
use crate::state::Config;

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct UpdateCollectionMetadataArgs {
    pub new_name: Option<String>,
    pub new_uri: Option<String>,
}

#[derive(Accounts)]
pub struct UpdateCollectionMetadata<'info> {
    #[account(mut, address = config.authority)]
    pub authority: Signer<'info>,

    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,

    /// CHECK: identity pinned to `config.collection`.
    #[account(mut, address = config.collection)]
    pub collection: UncheckedAccount<'info>,

    /// CHECK: address-constrained to the real Metaplex Core program.
    #[account(address = mpl_core::ID)]
    pub mpl_core_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handle_update_collection_metadata(
    ctx: Context<UpdateCollectionMetadata>,
    args: UpdateCollectionMetadataArgs,
) -> Result<()> {
    require!(
        args.new_name.is_some() || args.new_uri.is_some(),
        HashpandasError::NothingToUpdate
    );

    let config_bump = ctx.accounts.config.bump;
    let config_seeds: &[&[u8]] = &[b"config", &[config_bump]];

    let mpl_core_program = ctx.accounts.mpl_core_program.to_account_info();
    let collection = ctx.accounts.collection.to_account_info();
    let payer = ctx.accounts.authority.to_account_info();
    let config_ai = ctx.accounts.config.to_account_info();
    let system_program = ctx.accounts.system_program.to_account_info();

    let mut builder = UpdateCollectionV1CpiBuilder::new(&mpl_core_program);
    builder
        .collection(&collection)
        .payer(&payer)
        .authority(Some(&config_ai))
        .system_program(&system_program);
    if let Some(new_name) = args.new_name {
        builder.new_name(new_name);
    }
    if let Some(new_uri) = args.new_uri {
        builder.new_uri(new_uri);
    }
    builder.invoke_signed(&[config_seeds])?;

    Ok(())
}
