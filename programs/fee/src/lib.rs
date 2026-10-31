//! The fee program (spec 5.2): the partner and fee claimer on every config, forever, so it should rarely change.
//! It holds Heat's settings (`FeeConfig`) and the on-chain list of Heat coins: one `CoinRecord` per coin our launch key
//! co-signed or a Fair Open opened. It pays out every curve fee by ADR 0003's rules: the window claim sends a pool's Tax
//! window fees to the treasury, and every later claim splits the pool's partner fees 50/50 between whoever holds its DBC
//! creator role and the treasury. DBC pays each share straight from the pool to its owner's quote account, so no fee
//! ever rests here.
use anchor_lang::{
    prelude::*,
    solana_program::{
        bpf_loader_upgradeable,
        instruction::{AccountMeta, Instruction},
        program::invoke_signed,
    },
};

declare_id!("HeatFEzySQiaWqxR7cDza9WP2B15AxMfsgSS5p6Bdn97");

/// The seed of the `fee_claimer` PDA: the partner, fee claimer and leftover receiver every Heat config names, so it can
/// never change (`@top-pad/chain`).
pub const FEE_CLAIMER_SEED: &[u8] = b"fee_claimer";
/// The `fee_claimer` PDA itself and its bump, kept as constants so no instruction pays for its derivation; the tests
/// derive both.
pub const FEE_CLAIMER: Pubkey = pubkey!("4Garg7N38ShAr8z38ZKkHrgP9Lj5nRKiy3HGtNDqTpko");
pub const FEE_CLAIMER_BUMP: u8 = 255;
/// The seed of the one `FeeConfig`.
pub const FEE_CONFIG_SEED: &[u8] = b"fee_config";
/// The seed of a coin's `CoinRecord`, followed by its mint.
pub const COIN_RECORD_SEED: &[u8] = b"coin_record";
/// The seed of a `WindowClaim`, followed by its pool.
pub const WINDOW_CLAIM_SEED: &[u8] = b"window_claim";
/// The seed of the Fair Open program's coin registrar, a PDA of that program alone: its signature is how a CPI proves it
/// comes from the Fair Open program's open.
pub const COIN_REGISTRAR_SEED: &[u8] = b"coin_registrar";
/// The Tax window (spec 3.2, 12): Heat's configs charge the sniper tax for 60 one-second periods from a pool's activation
/// point, so the window's fees are those of its first 60 seconds. `@top-pad/chain` checks it against the configs' tax.
#[constant]
pub const TAX_WINDOW_SECONDS: i64 = 60;

/// The Associated Token Account program: every share is paid to its owner's associated quote account.
pub const ASSOCIATED_TOKEN_PROGRAM: Pubkey = pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

/// Meteora's DBC program and the parts of its accounts this program reads, from the IDL of release 0.2.2 that the
/// generated clients use (`packages/clients/idl/dbc.json`). Both accounts are zero-copy, so their layout is fixed for
/// every pool and config DBC has ever made; `packages/chain` checks these offsets against the generated decoders.
pub mod dbc {
    use {super::FeeError, anchor_lang::prelude::*};

    pub const PROGRAM_ID: Pubkey = pubkey!("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");
    /// DBC's pool authority, which owns every pool's vaults and signs what DBC pays out of them.
    pub const POOL_AUTHORITY: Pubkey = pubkey!("FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM");
    /// DBC's event authority, the PDA its `emit_cpi!` events are signed by.
    pub const EVENT_AUTHORITY: Pubkey = pubkey!("8Ks12pbrD6PXxfty1hVQiE9sc289zgU1zHkvXhrSdriF");

    pub const VIRTUAL_POOL_DISCRIMINATOR: [u8; 8] = [213, 224, 5, 209, 98, 69, 119, 92];
    /// `VirtualPool`: the discriminator, the 64-byte volatility tracker, then `config`, `creator` and `base_mint`; the
    /// partner's accrued quote fee and the activation point further on.
    pub const POOL_CONFIG_OFFSET: usize = 72;
    pub const POOL_CREATOR_OFFSET: usize = 104;
    pub const POOL_BASE_MINT_OFFSET: usize = 136;
    pub const POOL_PARTNER_QUOTE_FEE_OFFSET: usize = 272;
    pub const POOL_ACTIVATION_POINT_OFFSET: usize = 296;

    pub const POOL_CONFIG_DISCRIMINATOR: [u8; 8] = [26, 108, 14, 123, 116, 230, 129, 43];
    /// `PoolConfig`: the discriminator, `quote_mint`, then `fee_claimer`.
    pub const CONFIG_FEE_CLAIMER_OFFSET: usize = 40;

    /// `claim_trading_fee(max_amount_a, max_amount_b)`: the partner's accrued fees, the coin's then the quote's, each up to
    /// its maximum, paid to `token_a_account` and `token_b_account`. Only the config's fee claimer may sign it.
    pub const CLAIM_TRADING_FEE_DISCRIMINATOR: [u8; 8] = [8, 236, 89, 49, 152, 125, 177, 81];

    /// The 32-byte address at `offset`, if the data holds one there.
    pub fn address_at(data: &[u8], offset: usize) -> Option<Pubkey> {
        let bytes: [u8; 32] = data.get(offset..offset + 32)?.try_into().ok()?;
        Some(Pubkey::new_from_array(bytes))
    }

    /// The little-endian `u64` at `offset`, if the data holds one there.
    pub fn u64_at(data: &[u8], offset: usize) -> Option<u64> {
        Some(u64::from_le_bytes(data.get(offset..offset + 8)?.try_into().ok()?))
    }

    /// What this program reads from a DBC pool.
    pub struct Pool {
        pub config: Pubkey,
        /// Whoever holds the pool's creator role now: `transfer_pool_creator` moves it.
        pub creator: Pubkey,
        pub base_mint: Pubkey,
        /// The partner's fees in the quote, accrued and not yet claimed, in raw units.
        pub partner_quote_fee: u64,
        /// When trading opened, a Unix timestamp on Heat's configs (`activation_type` 1): the sniper tax counts from it.
        pub activation_point: u64,
    }

    impl Pool {
        /// Reads a pool; the caller has checked DBC owns the account, so only the discriminator is left to check.
        pub fn read(account: &AccountInfo) -> Result<Pool> {
            let data = account.try_borrow_data()?;
            require!(data.get(..8) == Some(&VIRTUAL_POOL_DISCRIMINATOR[..]), FeeError::NotADbcPool);
            let address = |offset| address_at(&data, offset).ok_or(FeeError::NotADbcPool);
            let number = |offset| u64_at(&data, offset).ok_or(FeeError::NotADbcPool);
            Ok(Pool {
                config: address(POOL_CONFIG_OFFSET)?,
                creator: address(POOL_CREATOR_OFFSET)?,
                base_mint: address(POOL_BASE_MINT_OFFSET)?,
                partner_quote_fee: number(POOL_PARTNER_QUOTE_FEE_OFFSET)?,
                activation_point: number(POOL_ACTIVATION_POINT_OFFSET)?,
            })
        }
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
    /// Instant launch's creation transaction (spec 2.2). The pool must be a DBC pool on a config that names our
    /// `fee_claimer`, so a record can only ever describe a pool whose fees this program splits.
    pub fn register_coin(ctx: Context<RegisterCoin>) -> Result<()> {
        let a = &ctx.accounts;
        let pool = heat_pool(&a.pool, &a.config, &a.mint)?;
        ctx.accounts.coin_record.set_inner(CoinRecord {
            mint: pool.base_mint,
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
            mint: pool.base_mint,
            pool: ctx.accounts.pool.key(),
            config: pool.config,
            creator: pool.creator,
            launch_mode: LaunchMode::Instant,
        });
        Ok(())
    }

    /// Puts a Fair Open's coin on the list of Heat coins, by CPI from the Fair Open program's open, the last instruction of
    /// the coin's creation transaction (spec 2.1 step 10): its record names the launch the coin opened from and the pot's
    /// own fee, which is split 50/50 like any trade's rather than joining the launch's Tax Share (spec 4). Only the Fair
    /// Open program can sign for its coin registrar, so no one else can register a coin as a Fair Open's.
    pub fn register_fair_open_coin(ctx: Context<RegisterFairOpenCoin>, launch: Pubkey, pot_fee: u64) -> Result<()> {
        let a = &ctx.accounts;
        let (registrar, _) = Pubkey::find_program_address(&[COIN_REGISTRAR_SEED], &a.fee_config.fair_open_program);
        require_keys_eq!(a.registrar.key(), registrar, FeeError::NotTheFairOpenProgram);
        let pool = heat_pool(&a.pool, &a.config, &a.mint)?;
        ctx.accounts.coin_record.set_inner(CoinRecord {
            mint: pool.base_mint,
            pool: ctx.accounts.pool.key(),
            launch_mode: LaunchMode::FairOpen,
            fair_open_launch: Some(launch),
            pot_fee,
            window_claimed: false,
            earnings_recipient: None,
            registered_at: Clock::get()?.unix_timestamp,
            bump: ctx.bumps.coin_record,
        });
        emit_cpi!(CoinRegistered {
            mint: pool.base_mint,
            pool: ctx.accounts.pool.key(),
            config: pool.config,
            creator: pool.creator,
            launch_mode: LaunchMode::FairOpen,
        });
        Ok(())
    }

    /// The window claim of a Heat coin (spec 4, 5.2): the first claim of its pool's partner fees once its Tax window has
    /// ended, which anyone may send and Heat's keeper sends at 60 s. Whatever the pool holds by then counts as the
    /// window's fees, so a claim sent late also moves the normal fees of the seconds it was late by (ADR 0003). An
    /// Instant launch's window fees go to the treasury; a Fair Open's go to its Tax Share, which comes with the Creator
    /// lock and Tax Share ticket, so until then its window claim is refused.
    pub fn claim_window_fees(ctx: Context<ClaimWindowFees>) -> Result<()> {
        let record = &mut ctx.accounts.coin_record;
        require!(!record.window_claimed, FeeError::WindowAlreadyClaimed);
        require!(record.launch_mode == LaunchMode::Instant, FeeError::TaxShareNotBuilt);
        record.window_claimed = true;
        let a = &ctx.accounts;
        let claim = DbcClaim {
            fee_claimer: &a.fee_claimer,
            fee_claimer_token_account: &a.fee_claimer_token_account,
            pool_authority: &a.pool_authority,
            config: &a.config,
            pool: &a.pool,
            base_vault: &a.base_vault,
            quote_vault: &a.quote_vault,
            mint: &a.mint,
            quote_mint: &a.quote_mint,
            token_base_program: &a.token_base_program,
            token_quote_program: &a.token_quote_program,
            dbc_event_authority: &a.dbc_event_authority,
            dbc_program: &a.dbc_program,
        };
        let claimed = claim.window(&a.fee_config, &a.treasury_token_account)?;
        emit_cpi!(claimed.event(true));
        Ok(())
    }

    /// The window claim of a pool made around Heat's flow (spec 2.4): one on Heat's configs that no `CoinRecord` lists.
    /// Its window's fees go to the treasury, and a `WindowClaim`, paid for by whoever sends it, remembers it ran.
    pub fn claim_unlisted_window_fees(ctx: Context<ClaimUnlistedWindowFees>) -> Result<()> {
        ctx.accounts
            .window_claim
            .set_inner(WindowClaim { pool: ctx.accounts.pool.key(), bump: ctx.bumps.window_claim });
        let a = &ctx.accounts;
        let claim = DbcClaim {
            fee_claimer: &a.fee_claimer,
            fee_claimer_token_account: &a.fee_claimer_token_account,
            pool_authority: &a.pool_authority,
            config: &a.config,
            pool: &a.pool,
            base_vault: &a.base_vault,
            quote_vault: &a.quote_vault,
            mint: &a.mint,
            quote_mint: &a.quote_mint,
            token_base_program: &a.token_base_program,
            token_quote_program: &a.token_quote_program,
            dbc_event_authority: &a.dbc_event_authority,
            dbc_program: &a.dbc_program,
        };
        let claimed = claim.window(&a.fee_config, &a.treasury_token_account)?;
        emit_cpi!(claimed.event(false));
        Ok(())
    }

    /// Creator Earnings (spec 4): anyone may send it once the pool's window claim has run. It claims up to `max_amount`
    /// of the pool's partner fees and pays half, rounded down as DBC rounds a creator's share, to whoever holds the
    /// pool's DBC creator role at this moment, and the rest to the treasury. A creator page passes the amount it showed,
    /// so the claim pays exactly that while fees keep accruing; nothing left to claim pays nothing.
    pub fn claim_fees(ctx: Context<ClaimFees>, max_amount: u64) -> Result<()> {
        let a = &ctx.accounts;
        let pool = dbc::Pool::read(&a.pool)?;
        require!(window_claimed(&a.window, &a.pool.key())?, FeeError::WindowNotClaimed);
        // The fee claimer's own quote account stands in DBC's base fee slot below, so it cannot also be the creator's.
        require_keys_neq!(pool.creator, FEE_CLAIMER, FeeError::CreatorRoleHeldByFeeClaimer);
        let quote = QuoteAccounts::new(&a.quote_mint, &a.token_quote_program);
        quote.check(&a.creator_token_account, &pool.creator, FeeError::NotTheCreatorsAccount)?;
        quote.check(&a.treasury_token_account, &a.fee_config.treasury, FeeError::NotTheTreasurysAccount)?;
        quote.check(&a.fee_claimer_token_account, &FEE_CLAIMER, FeeError::NotTheFeeClaimersAccount)?;

        let amount = pool.partner_quote_fee.min(max_amount);
        if amount == 0 {
            msg!("Nothing to claim");
            return Ok(());
        }
        let creator_amount = amount / 2;
        let treasury_amount = amount - creator_amount;
        let claim = DbcClaim {
            fee_claimer: &a.fee_claimer,
            fee_claimer_token_account: &a.fee_claimer_token_account,
            pool_authority: &a.pool_authority,
            config: &a.config,
            pool: &a.pool,
            base_vault: &a.base_vault,
            quote_vault: &a.quote_vault,
            mint: &a.mint,
            quote_mint: &a.quote_mint,
            token_base_program: &a.token_base_program,
            token_quote_program: &a.token_quote_program,
            dbc_event_authority: &a.dbc_event_authority,
            dbc_program: &a.dbc_program,
        };
        if creator_amount > 0 {
            claim.pay(&a.creator_token_account, creator_amount)?;
        }
        claim.pay(&a.treasury_token_account, treasury_amount)?;
        emit_cpi!(FeesClaimed {
            pool: a.pool.key(),
            mint: pool.base_mint,
            config: pool.config,
            creator: pool.creator,
            creator_amount,
            treasury_amount,
        });
        Ok(())
    }
}

/// The pool a coin's record describes: a DBC pool of the mint, on a config that names our `fee_claimer`, so a record
/// can only ever describe a pool whose fees this program splits.
fn heat_pool(pool: &AccountInfo, config: &AccountInfo, mint: &AccountInfo) -> Result<dbc::Pool> {
    let read = dbc::Pool::read(pool)?;
    require_keys_eq!(read.config, config.key(), FeeError::PoolConfigMismatch);
    require_keys_eq!(read.base_mint, mint.key(), FeeError::PoolMintMismatch);
    let config_data = config.try_borrow_data()?;
    require!(config_data.get(..8) == Some(&dbc::POOL_CONFIG_DISCRIMINATOR[..]), FeeError::NotADbcConfig);
    let fee_claimer = dbc::address_at(&config_data, dbc::CONFIG_FEE_CLAIMER_OFFSET).ok_or(FeeError::NotADbcConfig)?;
    require_keys_eq!(fee_claimer, FEE_CLAIMER, FeeError::NotAHeatConfig);
    Ok(read)
}

/// Whether a pool's window claim has run, by the account that remembers it: the pool's `CoinRecord`, or its
/// `WindowClaim` if no record lists it. Only this program writes either, each naming its pool, and a pool has one or the
/// other, never both: a Heat coin's record exists from the transaction that creates its pool.
fn window_claimed(window: &AccountInfo, pool: &Pubkey) -> Result<bool> {
    if window.owner != &crate::ID {
        return Ok(false);
    }
    let data = window.try_borrow_data()?;
    if data.starts_with(CoinRecord::DISCRIMINATOR) {
        let record = CoinRecord::try_deserialize(&mut &data[..])?;
        require_keys_eq!(record.pool, *pool, FeeError::PoolMismatch);
        Ok(record.window_claimed)
    } else if data.starts_with(WindowClaim::DISCRIMINATOR) {
        let claim = WindowClaim::try_deserialize(&mut &data[..])?;
        require_keys_eq!(claim.pool, *pool, FeeError::PoolMismatch);
        Ok(true)
    } else {
        Ok(false)
    }
}

/// The quote's associated token accounts, where every share is paid: one owner's, under the quote's token program.
struct QuoteAccounts {
    mint: Pubkey,
    token_program: Pubkey,
}

impl QuoteAccounts {
    fn new(mint: &AccountInfo, token_program: &AccountInfo) -> Self {
        QuoteAccounts { mint: mint.key(), token_program: token_program.key() }
    }

    fn check(&self, account: &AccountInfo, owner: &Pubkey, error: FeeError) -> Result<()> {
        let (expected, _) = Pubkey::find_program_address(
            &[owner.as_ref(), self.token_program.as_ref(), self.mint.as_ref()],
            &ASSOCIATED_TOKEN_PROGRAM,
        );
        require_keys_eq!(account.key(), expected, error);
        Ok(())
    }
}

/// The accounts of DBC's `claim_trading_fee`, which this program signs as the partner's fee claimer. DBC checks every
/// one against the pool and its config, and pays out of the pool's quote vault; Heat's configs collect every fee in the
/// quote (`collect_fee_mode` 0), so each claim asks for none of the coin and names the fee claimer's own quote account
/// in DBC's slot for it, where nothing is ever paid.
struct DbcClaim<'a, 'info> {
    fee_claimer: &'a UncheckedAccount<'info>,
    fee_claimer_token_account: &'a UncheckedAccount<'info>,
    pool_authority: &'a UncheckedAccount<'info>,
    config: &'a UncheckedAccount<'info>,
    pool: &'a UncheckedAccount<'info>,
    base_vault: &'a UncheckedAccount<'info>,
    quote_vault: &'a UncheckedAccount<'info>,
    mint: &'a UncheckedAccount<'info>,
    quote_mint: &'a UncheckedAccount<'info>,
    token_base_program: &'a UncheckedAccount<'info>,
    token_quote_program: &'a UncheckedAccount<'info>,
    dbc_event_authority: &'a UncheckedAccount<'info>,
    dbc_program: &'a UncheckedAccount<'info>,
}

/// What a window claim paid, for its event.
struct WindowClaimed {
    pool: Pubkey,
    mint: Pubkey,
    config: Pubkey,
    destination: Pubkey,
    amount: u64,
    window_ended_at: i64,
    claimed_at: i64,
}

impl WindowClaimed {
    fn event(&self, heat: bool) -> WindowFeesClaimed {
        WindowFeesClaimed {
            pool: self.pool,
            mint: self.mint,
            config: self.config,
            heat,
            destination: self.destination,
            amount: self.amount,
            window_ended_at: self.window_ended_at,
            claimed_at: self.claimed_at,
        }
    }
}

impl<'info> DbcClaim<'_, 'info> {
    /// Pays everything the pool's partner fees hold to the treasury, once the pool's Tax window has ended.
    fn window(&self, fee_config: &FeeConfig, treasury_token_account: &AccountInfo<'info>) -> Result<WindowClaimed> {
        let pool = dbc::Pool::read(self.pool)?;
        require_keys_eq!(pool.base_mint, self.mint.key(), FeeError::PoolMintMismatch);
        let window_ended_at = i64::try_from(pool.activation_point)
            .ok()
            .and_then(|activation| activation.checked_add(TAX_WINDOW_SECONDS))
            .ok_or(FeeError::NotADbcPool)?;
        let claimed_at = Clock::get()?.unix_timestamp;
        require_gte!(claimed_at, window_ended_at, FeeError::TaxWindowOpen);
        let quote = QuoteAccounts::new(self.quote_mint, self.token_quote_program);
        quote.check(treasury_token_account, &fee_config.treasury, FeeError::NotTheTreasurysAccount)?;
        quote.check(self.fee_claimer_token_account, &FEE_CLAIMER, FeeError::NotTheFeeClaimersAccount)?;
        if pool.partner_quote_fee > 0 {
            self.pay(treasury_token_account, pool.partner_quote_fee)?;
        }
        Ok(WindowClaimed {
            pool: self.pool.key(),
            mint: pool.base_mint,
            config: pool.config,
            destination: treasury_token_account.key(),
            amount: pool.partner_quote_fee,
            window_ended_at,
            claimed_at,
        })
    }

    /// Has DBC pay `amount` of the partner's quote fees from the pool to `to`, signed by the fee claimer.
    fn pay(&self, to: &AccountInfo<'info>, amount: u64) -> Result<()> {
        let mut data = Vec::with_capacity(24);
        data.extend_from_slice(&dbc::CLAIM_TRADING_FEE_DISCRIMINATOR);
        data.extend_from_slice(&0u64.to_le_bytes());
        data.extend_from_slice(&amount.to_le_bytes());
        let instruction = Instruction {
            program_id: dbc::PROGRAM_ID,
            accounts: vec![
                AccountMeta::new_readonly(self.pool_authority.key(), false),
                AccountMeta::new_readonly(self.config.key(), false),
                AccountMeta::new(self.pool.key(), false),
                AccountMeta::new(self.fee_claimer_token_account.key(), false),
                AccountMeta::new(to.key(), false),
                AccountMeta::new(self.base_vault.key(), false),
                AccountMeta::new(self.quote_vault.key(), false),
                AccountMeta::new_readonly(self.mint.key(), false),
                AccountMeta::new_readonly(self.quote_mint.key(), false),
                AccountMeta::new_readonly(FEE_CLAIMER, true),
                AccountMeta::new_readonly(self.token_base_program.key(), false),
                AccountMeta::new_readonly(self.token_quote_program.key(), false),
                AccountMeta::new_readonly(self.dbc_event_authority.key(), false),
                AccountMeta::new_readonly(dbc::PROGRAM_ID, false),
            ],
            data,
        };
        let infos = [
            self.pool_authority.to_account_info(),
            self.config.to_account_info(),
            self.pool.to_account_info(),
            self.fee_claimer_token_account.to_account_info(),
            to.clone(),
            self.base_vault.to_account_info(),
            self.quote_vault.to_account_info(),
            self.mint.to_account_info(),
            self.quote_mint.to_account_info(),
            self.fee_claimer.to_account_info(),
            self.token_base_program.to_account_info(),
            self.token_quote_program.to_account_info(),
            self.dbc_event_authority.to_account_info(),
            self.dbc_program.to_account_info(),
        ];
        invoke_signed(&instruction, &infos, &[&[FEE_CLAIMER_SEED, &[FEE_CLAIMER_BUMP]]])?;
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

/// One per pool made around Heat's flow whose window claim has run, at the PDA of its pool: what a `CoinRecord`'s
/// `window_claimed` remembers for a Heat coin, for a pool no record lists (spec 2.4).
#[account]
#[derive(InitSpace, Debug)]
pub struct WindowClaim {
    pub pool: Pubkey,
    pub bump: u8,
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

#[event_cpi]
#[derive(Accounts)]
pub struct RegisterFairOpenCoin<'info> {
    #[account(seeds = [FEE_CONFIG_SEED], bump = fee_config.bump)]
    pub fee_config: Account<'info, FeeConfig>,
    /// The Fair Open program's coin registrar, checked in the handler against the program the `FeeConfig` names.
    pub registrar: Signer<'info>,
    /// Pays the record's rent: our keeper, which the open pays back from the creator's prepaid rent.
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

#[event_cpi]
#[derive(Accounts)]
pub struct ClaimWindowFees<'info> {
    #[account(seeds = [FEE_CONFIG_SEED], bump = fee_config.bump)]
    pub fee_config: Account<'info, FeeConfig>,
    #[account(
        mut,
        seeds = [COIN_RECORD_SEED, mint.key().as_ref()],
        bump = coin_record.bump,
        has_one = pool @ FeeError::PoolMismatch,
    )]
    pub coin_record: Account<'info, CoinRecord>,
    /// CHECK: the treasury's associated quote account, checked in the handler; the window's fees go here.
    #[account(mut)]
    pub treasury_token_account: UncheckedAccount<'info>,
    /// CHECK: the fee program's `fee_claimer` PDA, which signs DBC's claim.
    #[account(address = FEE_CLAIMER)]
    pub fee_claimer: UncheckedAccount<'info>,
    /// CHECK: the fee claimer's own associated quote account, checked in the handler; DBC never pays into it.
    #[account(mut)]
    pub fee_claimer_token_account: UncheckedAccount<'info>,
    /// CHECK: DBC's pool authority, owner of the pool's vaults.
    #[account(address = dbc::POOL_AUTHORITY)]
    pub pool_authority: UncheckedAccount<'info>,
    /// CHECK: the pool's config; DBC checks it.
    pub config: UncheckedAccount<'info>,
    /// CHECK: owned by DBC; its discriminator and base mint are checked in the handler, the rest by DBC.
    #[account(mut, owner = dbc::PROGRAM_ID @ FeeError::NotADbcPool)]
    pub pool: UncheckedAccount<'info>,
    /// CHECK: the pool's coin vault; DBC checks it.
    #[account(mut)]
    pub base_vault: UncheckedAccount<'info>,
    /// CHECK: the pool's quote vault, which DBC pays from; DBC checks it.
    #[account(mut)]
    pub quote_vault: UncheckedAccount<'info>,
    /// CHECK: the coin, the pool's base mint; checked in the handler and by DBC.
    pub mint: UncheckedAccount<'info>,
    /// CHECK: the config's quote mint; DBC checks it.
    pub quote_mint: UncheckedAccount<'info>,
    /// CHECK: the coin's token program; DBC checks it.
    pub token_base_program: UncheckedAccount<'info>,
    /// CHECK: the quote's token program; DBC checks it.
    pub token_quote_program: UncheckedAccount<'info>,
    /// CHECK: DBC's event authority.
    #[account(address = dbc::EVENT_AUTHORITY)]
    pub dbc_event_authority: UncheckedAccount<'info>,
    /// CHECK: DBC itself.
    #[account(address = dbc::PROGRAM_ID)]
    pub dbc_program: UncheckedAccount<'info>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct ClaimUnlistedWindowFees<'info> {
    #[account(seeds = [FEE_CONFIG_SEED], bump = fee_config.bump)]
    pub fee_config: Account<'info, FeeConfig>,
    /// The coin's record address, which must hold nothing: a coin our launch key co-signed takes `claim_window_fees`.
    #[account(seeds = [COIN_RECORD_SEED, mint.key().as_ref()], bump)]
    pub coin_record: SystemAccount<'info>,
    #[account(init, payer = payer, space = 8 + WindowClaim::INIT_SPACE, seeds = [WINDOW_CLAIM_SEED, pool.key().as_ref()], bump)]
    pub window_claim: Account<'info, WindowClaim>,
    /// Pays the `WindowClaim`'s rent.
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: the treasury's associated quote account, checked in the handler; the window's fees go here.
    #[account(mut)]
    pub treasury_token_account: UncheckedAccount<'info>,
    /// CHECK: the fee program's `fee_claimer` PDA, which signs DBC's claim.
    #[account(address = FEE_CLAIMER)]
    pub fee_claimer: UncheckedAccount<'info>,
    /// CHECK: the fee claimer's own associated quote account, checked in the handler; DBC never pays into it.
    #[account(mut)]
    pub fee_claimer_token_account: UncheckedAccount<'info>,
    /// CHECK: DBC's pool authority, owner of the pool's vaults.
    #[account(address = dbc::POOL_AUTHORITY)]
    pub pool_authority: UncheckedAccount<'info>,
    /// CHECK: the pool's config; DBC checks it.
    pub config: UncheckedAccount<'info>,
    /// CHECK: owned by DBC; its discriminator and base mint are checked in the handler, the rest by DBC.
    #[account(mut, owner = dbc::PROGRAM_ID @ FeeError::NotADbcPool)]
    pub pool: UncheckedAccount<'info>,
    /// CHECK: the pool's coin vault; DBC checks it.
    #[account(mut)]
    pub base_vault: UncheckedAccount<'info>,
    /// CHECK: the pool's quote vault, which DBC pays from; DBC checks it.
    #[account(mut)]
    pub quote_vault: UncheckedAccount<'info>,
    /// CHECK: the coin, the pool's base mint; checked in the handler and by DBC.
    pub mint: UncheckedAccount<'info>,
    /// CHECK: the config's quote mint; DBC checks it.
    pub quote_mint: UncheckedAccount<'info>,
    /// CHECK: the coin's token program; DBC checks it.
    pub token_base_program: UncheckedAccount<'info>,
    /// CHECK: the quote's token program; DBC checks it.
    pub token_quote_program: UncheckedAccount<'info>,
    /// CHECK: DBC's event authority.
    #[account(address = dbc::EVENT_AUTHORITY)]
    pub dbc_event_authority: UncheckedAccount<'info>,
    /// CHECK: DBC itself.
    #[account(address = dbc::PROGRAM_ID)]
    pub dbc_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct ClaimFees<'info> {
    #[account(seeds = [FEE_CONFIG_SEED], bump = fee_config.bump)]
    pub fee_config: Account<'info, FeeConfig>,
    /// CHECK: what remembers the pool's window claim, its `CoinRecord` or else its `WindowClaim`; read in the handler.
    pub window: UncheckedAccount<'info>,
    /// CHECK: the creator role holder's associated quote account, checked in the handler; half goes here.
    #[account(mut)]
    pub creator_token_account: UncheckedAccount<'info>,
    /// CHECK: the treasury's associated quote account, checked in the handler; the rest goes here.
    #[account(mut)]
    pub treasury_token_account: UncheckedAccount<'info>,
    /// CHECK: the fee program's `fee_claimer` PDA, which signs DBC's claim.
    #[account(address = FEE_CLAIMER)]
    pub fee_claimer: UncheckedAccount<'info>,
    /// CHECK: the fee claimer's own associated quote account, checked in the handler; DBC never pays into it.
    #[account(mut)]
    pub fee_claimer_token_account: UncheckedAccount<'info>,
    /// CHECK: DBC's pool authority, owner of the pool's vaults.
    #[account(address = dbc::POOL_AUTHORITY)]
    pub pool_authority: UncheckedAccount<'info>,
    /// CHECK: the pool's config; DBC checks it.
    pub config: UncheckedAccount<'info>,
    /// CHECK: owned by DBC; its discriminator is checked in the handler, the rest by DBC.
    #[account(mut, owner = dbc::PROGRAM_ID @ FeeError::NotADbcPool)]
    pub pool: UncheckedAccount<'info>,
    /// CHECK: the pool's coin vault; DBC checks it.
    #[account(mut)]
    pub base_vault: UncheckedAccount<'info>,
    /// CHECK: the pool's quote vault, which DBC pays from; DBC checks it.
    #[account(mut)]
    pub quote_vault: UncheckedAccount<'info>,
    /// CHECK: the coin, the pool's base mint; DBC checks it.
    pub mint: UncheckedAccount<'info>,
    /// CHECK: the config's quote mint; DBC checks it.
    pub quote_mint: UncheckedAccount<'info>,
    /// CHECK: the coin's token program; DBC checks it.
    pub token_base_program: UncheckedAccount<'info>,
    /// CHECK: the quote's token program; DBC checks it.
    pub token_quote_program: UncheckedAccount<'info>,
    /// CHECK: DBC's event authority.
    #[account(address = dbc::EVENT_AUTHORITY)]
    pub dbc_event_authority: UncheckedAccount<'info>,
    /// CHECK: DBC itself.
    #[account(address = dbc::PROGRAM_ID)]
    pub dbc_program: UncheckedAccount<'info>,
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

/// A pool's window claim: its Tax window's fees, and any later fees that accrued before the claim ran.
#[event]
pub struct WindowFeesClaimed {
    pub pool: Pubkey,
    pub mint: Pubkey,
    pub config: Pubkey,
    /// Whether our launch key co-signed the coin: false for a pool made around Heat's flow.
    pub heat: bool,
    /// The quote account paid: the treasury's, for an Instant launch and for a pool made around Heat's flow.
    pub destination: Pubkey,
    /// In the quote's raw units.
    pub amount: u64,
    /// When the Tax window ended and when the claim ran, Unix timestamps: it also paid the normal fees of the seconds
    /// between (spec 4).
    pub window_ended_at: i64,
    pub claimed_at: i64,
}

/// A claim of Creator Earnings and Heat's Platform Fee from one pool, split 50/50.
#[event]
pub struct FeesClaimed {
    pub pool: Pubkey,
    pub mint: Pubkey,
    pub config: Pubkey,
    /// Who held the pool's DBC creator role at the claim, and was paid `creator_amount`.
    pub creator: Pubkey,
    /// In the quote's raw units; the treasury's is the creator's, or one more when the claim was odd.
    pub creator_amount: u64,
    pub treasury_amount: u64,
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
    #[msg("The record or window claim is another pool's")]
    PoolMismatch,
    #[msg("The pool's Tax window has not ended")]
    TaxWindowOpen,
    #[msg("The pool's window claim has already run")]
    WindowAlreadyClaimed,
    #[msg("The pool's window claim has not run yet")]
    WindowNotClaimed,
    #[msg("A Fair Open's window fees go to its Tax Share, which this program cannot pay yet")]
    TaxShareNotBuilt,
    #[msg("The creator's half goes to the creator role holder's associated quote account")]
    NotTheCreatorsAccount,
    #[msg("The treasury's share goes to the treasury's associated quote account")]
    NotTheTreasurysAccount,
    #[msg("DBC's coin fee slot takes the fee claimer's associated quote account")]
    NotTheFeeClaimersAccount,
    #[msg("The fee claimer holds the pool's creator role, so its creator's half has nowhere to go")]
    CreatorRoleHeldByFeeClaimer,
    #[msg("Only the Fair Open program's open registers a Fair Open's coin")]
    NotTheFairOpenProgram,
}
