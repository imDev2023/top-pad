//! The fee program (spec 5.2): the partner and fee claimer on every config, forever, so it should rarely change.
//! It holds Heat's settings (`FeeConfig`) and the on-chain list of Heat coins: one `CoinRecord` per coin our launch key
//! co-signed. The fee claims of ADR 0003 join it in "Fee claims: the window claim and the 50/50 Creator Earnings split".
use anchor_lang::{prelude::*, solana_program::bpf_loader_upgradeable};

declare_id!("HeatFEzySQiaWqxR7cDza9WP2B15AxMfsgSS5p6Bdn97");

/// The seed of the `fee_claimer` PDA: the partner, fee claimer and leftover receiver every Heat config names, so it can
/// never change (`@top-pad/chain`).
pub const FEE_CLAIMER_SEED: &[u8] = b"fee_claimer";
/// The `fee_claimer` PDA itself, kept as a constant so no instruction pays for its derivation; the tests derive it.
pub const FEE_CLAIMER: Pubkey = pubkey!("4Garg7N38ShAr8z38ZKkHrgP9Lj5nRKiy3HGtNDqTpko");
/// The seed of the one `FeeConfig`.
pub const FEE_CONFIG_SEED: &[u8] = b"fee_config";
/// The seed of a coin's `CoinRecord`, followed by its mint.
pub const COIN_RECORD_SEED: &[u8] = b"coin_record";

/// Meteora's DBC program and the parts of its accounts `register_coin` reads, from the IDL of release 0.2.2 that the
/// generated clients use (`packages/clients/idl/dbc.json`). Both accounts are zero-copy, so their layout is fixed for
/// every pool and config DBC has ever made; `packages/chain` checks these offsets against the generated decoders.
pub mod dbc {
    use anchor_lang::prelude::*;

    pub const PROGRAM_ID: Pubkey = pubkey!("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");

    pub const VIRTUAL_POOL_DISCRIMINATOR: [u8; 8] = [213, 224, 5, 209, 98, 69, 119, 92];
    /// `VirtualPool`: the discriminator, the 64-byte volatility tracker, then `config`, `creator` and `base_mint`.
    pub const POOL_CONFIG_OFFSET: usize = 72;
    pub const POOL_CREATOR_OFFSET: usize = 104;
    pub const POOL_BASE_MINT_OFFSET: usize = 136;

    pub const POOL_CONFIG_DISCRIMINATOR: [u8; 8] = [26, 108, 14, 123, 116, 230, 129, 43];
    /// `PoolConfig`: the discriminator, `quote_mint`, then `fee_claimer`.
    pub const CONFIG_FEE_CLAIMER_OFFSET: usize = 40;

    /// The 32-byte address at `offset`, if the data holds one there.
    pub fn address_at(data: &[u8], offset: usize) -> Option<Pubkey> {
        let bytes: [u8; 32] = data.get(offset..offset + 32)?.try_into().ok()?;
        Some(Pubkey::new_from_array(bytes))
    }
}

#[cfg(not(feature = "no-entrypoint"))]
solana_security_txt::security_txt! {
    name: "Heat fee program",
    project_url: "https://github.com/imDev2023/top-pad",
    contacts: "link:https://github.com/imDev2023/top-pad/security/advisories/new",
    policy: "https://github.com/imDev2023/top-pad/blob/main/SECURITY.md",
    preferred_languages: "en",
    source_code: "https://github.com/imDev2023/top-pad"
}

#[program]
pub mod fee {
    use super::*;

    /// Creates the `FeeConfig`. Only the program's upgrade authority may, so whoever controls upgrades also controls
    /// the treasury and the launch key: a plain offline key on devnet, Squads behind a 7-day timelock on mainnet
    /// (spec 5.1).
    pub fn initialize(ctx: Context<Initialize>, settings: FeeSettings) -> Result<()> {
        settings.check()?;
        let fee_config = &mut ctx.accounts.fee_config;
        fee_config.set_inner(FeeConfig { bump: ctx.bumps.fee_config, ..settings.into() });
        let changed = FeeConfigChanged::from(&**fee_config);
        emit_cpi!(changed);
        Ok(())
    }

    /// Replaces the `FeeConfig`'s settings, again only by the upgrade authority: how a lost launch key is rotated.
    pub fn update_fee_config(ctx: Context<UpdateFeeConfig>, settings: FeeSettings) -> Result<()> {
        settings.check()?;
        let fee_config = &mut ctx.accounts.fee_config;
        let bump = fee_config.bump;
        fee_config.set_inner(FeeConfig { bump, ..settings.into() });
        let changed = FeeConfigChanged::from(&**fee_config);
        emit_cpi!(changed);
        Ok(())
    }

    /// Puts a coin on the list of Heat coins (spec 8): creates its `CoinRecord`, with the launch key's signature, in the
    /// Instant launch's creation transaction (spec 2.2). The Fair Open program's `settle` registers its coins by CPI
    /// once it exists. The pool must be a DBC pool on a config that names our `fee_claimer`, so a record can only ever
    /// describe a pool whose fees this program splits.
    pub fn register_coin(ctx: Context<RegisterCoin>) -> Result<()> {
        let pool = ctx.accounts.pool.try_borrow_data()?;
        require!(pool.get(..8) == Some(&dbc::VIRTUAL_POOL_DISCRIMINATOR[..]), FeeError::NotADbcPool);
        let config = dbc::address_at(&pool, dbc::POOL_CONFIG_OFFSET).ok_or(FeeError::NotADbcPool)?;
        let creator = dbc::address_at(&pool, dbc::POOL_CREATOR_OFFSET).ok_or(FeeError::NotADbcPool)?;
        let base_mint = dbc::address_at(&pool, dbc::POOL_BASE_MINT_OFFSET).ok_or(FeeError::NotADbcPool)?;
        drop(pool);
        require_keys_eq!(config, ctx.accounts.config.key(), FeeError::PoolConfigMismatch);
        require_keys_eq!(base_mint, ctx.accounts.mint.key(), FeeError::PoolMintMismatch);

        let config_data = ctx.accounts.config.try_borrow_data()?;
        require!(config_data.get(..8) == Some(&dbc::POOL_CONFIG_DISCRIMINATOR[..]), FeeError::NotADbcConfig);
        let fee_claimer =
            dbc::address_at(&config_data, dbc::CONFIG_FEE_CLAIMER_OFFSET).ok_or(FeeError::NotADbcConfig)?;
        drop(config_data);
        require_keys_eq!(fee_claimer, FEE_CLAIMER, FeeError::NotAHeatConfig);

        let record = &mut ctx.accounts.coin_record;
        record.set_inner(CoinRecord {
            mint: base_mint,
            pool: ctx.accounts.pool.key(),
            launch_mode: LaunchMode::Instant,
            fair_open_launch: None,
            pot_fee: 0,
            window_claimed: false,
            earnings_recipient: None,
            registered_at: Clock::get()?.unix_timestamp,
            bump: ctx.bumps.coin_record,
        });
        emit_cpi!(CoinRegistered {
            mint: base_mint,
            pool: record.pool,
            config,
            creator,
            launch_mode: LaunchMode::Instant,
        });
        Ok(())
    }
}

/// Heat's settings: where Heat's Platform Fee goes, which key co-signs launches, and which program runs Fair Opens.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct FeeSettings {
    /// Receives Heat's half of every fee and the Instant launches' tax windows (spec 4).
    pub treasury: Pubkey,
    /// The keeper key, which co-signs Instant launches and registers their coins (spec 10.3).
    pub launch_key: Pubkey,
    /// The Fair Open program, the only one whose CPI may register a Fair Open's coin.
    pub fair_open_program: Pubkey,
}

impl FeeSettings {
    fn check(&self) -> Result<()> {
        for key in [self.treasury, self.launch_key, self.fair_open_program] {
            require_keys_neq!(key, Pubkey::default(), FeeError::MissingSetting);
        }
        Ok(())
    }
}

impl From<FeeSettings> for FeeConfig {
    fn from(s: FeeSettings) -> Self {
        FeeConfig { treasury: s.treasury, launch_key: s.launch_key, fair_open_program: s.fair_open_program, bump: 0 }
    }
}

#[account]
#[derive(InitSpace, Debug)]
pub struct FeeConfig {
    pub treasury: Pubkey,
    pub launch_key: Pubkey,
    pub fair_open_program: Pubkey,
    pub bump: u8,
}

/// One per Heat coin, at the PDA of its mint: what the fee program needs to split the coin's fees, and the on-chain
/// list of coins Heat stands behind (spec 5.2, 8).
#[account]
#[derive(InitSpace, Debug)]
pub struct CoinRecord {
    pub mint: Pubkey,
    pub pool: Pubkey,
    pub launch_mode: LaunchMode,
    /// The Fair Open launch account the coin opened from; none for an Instant launch.
    pub fair_open_launch: Option<Pubkey>,
    /// The Fair Open pot's own fee, in the quote's raw units, split 50/50 rather than going to the Tax Share.
    pub pot_fee: u64,
    /// Whether the first partner-fee claim after the tax window has run.
    pub window_claimed: bool,
    /// Empty: who receives the coin's Creator Earnings if not the creator role holder, kept for holder rewards in the
    /// mainnet effort (spec 4).
    pub earnings_recipient: Option<Pubkey>,
    /// When the coin was registered, as a Unix timestamp.
    pub registered_at: i64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, Debug, PartialEq, Eq)]
pub enum LaunchMode {
    FairOpen,
    Instant,
}

#[event_cpi]
#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = payer, space = 8 + FeeConfig::INIT_SPACE, seeds = [FEE_CONFIG_SEED], bump)]
    pub fee_config: Account<'info, FeeConfig>,
    pub authority: Signer<'info>,
    /// This program's ProgramData, at the address the upgradeable loader derives from the program id.
    #[account(
        seeds = [crate::ID.as_ref()],
        bump,
        seeds::program = bpf_loader_upgradeable::ID,
        constraint = program_data.upgrade_authority_address == Some(authority.key()) @ FeeError::NotUpgradeAuthority,
    )]
    pub program_data: Account<'info, ProgramData>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct UpdateFeeConfig<'info> {
    #[account(mut, seeds = [FEE_CONFIG_SEED], bump = fee_config.bump)]
    pub fee_config: Account<'info, FeeConfig>,
    pub authority: Signer<'info>,
    /// This program's ProgramData, at the address the upgradeable loader derives from the program id.
    #[account(
        seeds = [crate::ID.as_ref()],
        bump,
        seeds::program = bpf_loader_upgradeable::ID,
        constraint = program_data.upgrade_authority_address == Some(authority.key()) @ FeeError::NotUpgradeAuthority,
    )]
    pub program_data: Account<'info, ProgramData>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct RegisterCoin<'info> {
    #[account(seeds = [FEE_CONFIG_SEED], bump = fee_config.bump, has_one = launch_key @ FeeError::NotTheLaunchKey)]
    pub fee_config: Account<'info, FeeConfig>,
    pub launch_key: Signer<'info>,
    /// Pays the record's rent: the creator, in an Instant launch.
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: the coin; it must be the pool's base mint, checked in the handler.
    pub mint: UncheckedAccount<'info>,
    /// CHECK: owned by DBC; its discriminator, config and base mint are checked in the handler.
    #[account(owner = dbc::PROGRAM_ID @ FeeError::NotADbcPool)]
    pub pool: UncheckedAccount<'info>,
    /// CHECK: owned by DBC; its discriminator and fee claimer are checked in the handler.
    #[account(owner = dbc::PROGRAM_ID @ FeeError::NotADbcConfig)]
    pub config: UncheckedAccount<'info>,
    #[account(init, payer = payer, space = 8 + CoinRecord::INIT_SPACE, seeds = [COIN_RECORD_SEED, mint.key().as_ref()], bump)]
    pub coin_record: Account<'info, CoinRecord>,
    pub system_program: Program<'info, System>,
}

#[event]
pub struct FeeConfigChanged {
    pub treasury: Pubkey,
    pub launch_key: Pubkey,
    pub fair_open_program: Pubkey,
}

impl From<&FeeConfig> for FeeConfigChanged {
    fn from(c: &FeeConfig) -> Self {
        FeeConfigChanged { treasury: c.treasury, launch_key: c.launch_key, fair_open_program: c.fair_open_program }
    }
}

#[event]
pub struct CoinRegistered {
    pub mint: Pubkey,
    pub pool: Pubkey,
    pub config: Pubkey,
    /// The pool's creator role holder when the coin was registered: the Creator wallet that signed the launch.
    pub creator: Pubkey,
    pub launch_mode: LaunchMode,
}

#[error_code]
pub enum FeeError {
    #[msg("Only the program's upgrade authority can change Heat's settings")]
    NotUpgradeAuthority,
    #[msg("A setting is the default address")]
    MissingSetting,
    #[msg("The launch key did not sign")]
    NotTheLaunchKey,
    #[msg("The pool is not a DBC pool")]
    NotADbcPool,
    #[msg("The config is not a DBC config")]
    NotADbcConfig,
    #[msg("The pool is on another config")]
    PoolConfigMismatch,
    #[msg("The pool trades another mint")]
    PoolMintMismatch,
    #[msg("The config does not name the fee program's fee claimer")]
    NotAHeatConfig,
}
