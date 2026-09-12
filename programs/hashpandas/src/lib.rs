pub mod difficulty;
pub mod economics;
pub mod errors;
pub mod instructions;
pub mod state;
pub mod utils;

use anchor_lang::prelude::*;

pub use instructions::*;

declare_id!("97c5ZbrrVVJa8jY1vVHX1tpKtZXrUBp7YyfpfhKnxpmK");

#[program]
pub mod hashpandas {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, args: InitializeArgs) -> Result<()> {
        instructions::initialize::handle_initialize(ctx, args)
    }

    pub fn mint(ctx: Context<Mint>, args: MintArgs) -> Result<()> {
        instructions::mint::handle_mint(ctx, args)
    }

    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        instructions::claim::handle_claim(ctx)
    }

    pub fn burn(ctx: Context<Burn>) -> Result<()> {
        instructions::burn::handle_burn(ctx)
    }

    pub fn crank_buyback<'info>(
        ctx: Context<'info, CrankBuyback<'info>>,
        args: CrankBuybackArgs,
    ) -> Result<()> {
        instructions::crank::handle_crank_buyback(ctx, args)
    }
}
