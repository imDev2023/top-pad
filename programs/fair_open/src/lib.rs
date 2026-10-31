//! The Fair Open program (spec 5.3): holds a Fair Open's deposits as plain SOL through its 10-minute window, one seat per
//! person admitted by our admission server; at the scheduled time opens it in the coin's creation transaction, where the
//! pot's buy is the pool's first swap and every depositor buys at its one price; then delivers every seat its coins and
//! refund. A launch that cannot open fails on chain, after which every depositor takes back their deposit and both rents
//! with no Heat server running (spec 2.1 steps 7 and 9 to 12, and 15). The Creator lock and the Tax Share come with a
//! later slice (spec 14); the launch and seat accounts keep room for what they will record.
use {
    anchor_lang::{
        prelude::*,
        solana_program::{
            bpf_loader_upgradeable,
            instruction::{AccountMeta, Instruction},
            program::invoke_signed,
        },
        system_program,
    },
    solana_instructions_sysvar::{load_current_index_checked, load_instruction_at_checked},
    token::TokenAccount,
};

pub mod admission;
pub mod allocation;
pub mod creation;
pub mod token;

pub use admission::Admission;

declare_id!("HeatPiBAgiwq6VJr8eqyagQiQ2gvaK2y85q26bbBu4bo");

/// The seed of the one `ProgramConfig`.
pub const PROGRAM_CONFIG_SEED: &[u8] = b"program_config";
/// The seed of a `Launch`, followed by its durable nonce account, which only that launch ever uses.
pub const LAUNCH_SEED: &[u8] = b"launch";
/// The seed of a launch's `Vault`, followed by the launch.
pub const VAULT_SEED: &[u8] = b"vault";
/// The seed of a `Seat`, followed by the launch and the person's pseudonym.
pub const SEAT_SEED: &[u8] = b"seat";
/// The seed of the pot's wrapped-SOL account, followed by the launch: made by the open holding exactly the buy, and
/// closed once DBC's swap has spent it, in the same transaction.
pub const POT_SEED: &[u8] = b"pot";
/// The seed of the coin registrar, the PDA whose signature tells the fee program a coin's registration comes from the
/// open (`fee::COIN_REGISTRAR_SEED`).
pub const COIN_REGISTRAR_SEED: &[u8] = b"coin_registrar";

/// The deposit window (spec 2.1 step 4): a fixed 10 minutes, ending at the scheduled open.
#[constant]
pub const WINDOW_SECONDS: i64 = 600;
/// From 15 minutes after the scheduled open, the open is refused and anyone may mark the launch failed (spec 2.1
/// step 15).
#[constant]
pub const LATE_OPEN_SECONDS: i64 = 900;
/// How far ahead a window may start (spec 2.1 step 4): 7 days.
#[constant]
pub const MAX_SCHEDULE_SECONDS: i64 = 7 * 24 * 3600;
/// The deposit step (spec 12): deposits, withdrawals and caps move in 0.01 SOL.
#[constant]
pub const DEPOSIT_STEP: u64 = 10_000_000;
/// Each Depositor tier's cap per Fair Open, in deposit steps (spec 2.1 step 9): Unverified 0.1 SOL, Scored 0.5 SOL,
/// Verified 2 SOL. Our admission server signs each person's cap, and a stolen admission key still admits no one above
/// these.
#[constant]
pub const UNVERIFIED_CAP_STEPS: u64 = 10;
#[constant]
pub const SCORED_CAP_STEPS: u64 = 50;
#[constant]
pub const VERIFIED_CAP_STEPS: u64 = 200;
/// The pot's cap, as a share of the config's Graduation Target (spec 12): 20%.
#[constant]
pub const POT_CAP_PERCENT: u64 = 20;
/// A coin account (an SPL token account), whose rent each depositor prepays for the push to create (spec 2.1 step 9).
pub const TOKEN_ACCOUNT_LEN: usize = 165;
/// Wrapped SOL: the only quote a Fair Open takes until a non-SOL quote's deposits are built (spec 5.1, 11.2).
pub const NATIVE_MINT: Pubkey = pubkey!("So11111111111111111111111111111111111111112");
/// SPL Token: Heat coins and wrapped SOL are classic SPL tokens (spec 3.1).
pub const TOKEN_PROGRAM: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

/// What the open's accounts cost, which the creator prepays at scheduling (spec 2.1 step 7) and our keeper fronts at
/// the open, paid back from the prepayment exactly what they cost it: DBC's mint, pool and two vaults, the coin's
/// Metaplex metadata with Metaplex's creation fee, the pot's coin account, and the coin's record in the fee program.
/// Measured on devnet (2026-10-31): DBC's pool creation cost its payer the metadata's 607 bytes and 0.01 SOL fee on top of
/// its own accounts' rent.
pub mod open_rent {
    pub const MINT_LEN: usize = 82;
    /// DBC's `VirtualPool`, zero-copy: 416 bytes after its discriminator.
    pub const POOL_LEN: usize = 8 + 416;
    pub const METADATA_LEN: usize = 607;
    pub const METAPLEX_CREATE_FEE: u64 = 10_000_000;
    /// The fee program's `CoinRecord`.
    pub const COIN_RECORD_LEN: usize = 157;
}

/// What the open's accounts cost at `rent`, prepaid by the creator (`open_rent`).
pub fn open_rent(rent: &Rent) -> u64 {
    use open_rent::*;
    rent.minimum_balance(MINT_LEN)
        + rent.minimum_balance(POOL_LEN)
        + 3 * rent.minimum_balance(TOKEN_ACCOUNT_LEN)
        + rent.minimum_balance(METADATA_LEN)
        + METAPLEX_CREATE_FEE
        + rent.minimum_balance(COIN_RECORD_LEN)
}

/// Meteora's DBC program and the parts of a config this program reads, from the IDL of release 0.2.2 that the generated
/// clients use: a launch's quote and Graduation Target come from Heat's Fair Open config itself. `packages/chain` checks
/// these offsets against the generated decoder.
pub mod dbc {
    use anchor_lang::prelude::*;

    pub const PROGRAM_ID: Pubkey = pubkey!("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");
    pub const POOL_CONFIG_DISCRIMINATOR: [u8; 8] = [26, 108, 14, 123, 116, 230, 129, 43];
    /// `PoolConfig`: the discriminator, then `quote_mint`; the Graduation Target, `migration_quote_threshold`, further on.
    pub const CONFIG_QUOTE_MINT_OFFSET: usize = 8;
    pub const CONFIG_MIGRATION_QUOTE_THRESHOLD_OFFSET: usize = 264;
    pub const VIRTUAL_POOL_DISCRIMINATOR: [u8; 8] = [213, 224, 5, 209, 98, 69, 119, 92];
    /// `VirtualPool`: the discriminator, the 64-byte volatility tracker, then `config`, `creator` and `base_mint`; the
    /// partner's accrued quote fee further on.
    pub const POOL_CONFIG_OFFSET: usize = 72;
    pub const POOL_BASE_MINT_OFFSET: usize = 136;
    pub const POOL_PARTNER_QUOTE_FEE_OFFSET: usize = 272;
    /// The instructions of the creation transaction (`creation`).
    pub const INITIALIZE_POOL_WITH_SPL_TOKEN: [u8; 8] = [140, 85, 215, 176, 102, 54, 104, 79];
    pub const SWAP2: [u8; 8] = [65, 75, 63, 76, 235, 91, 91, 136];
}

/// The fee program's `register_fair_open_coin(launch, pot_fee)`, which the open calls signed by the coin registrar;
/// the tests check the discriminator against the fee program's own.
pub mod fee {
    pub const REGISTER_FAIR_OPEN_COIN_DISCRIMINATOR: [u8; 8] = [192, 62, 175, 159, 158, 240, 43, 24];
}

/// A durable nonce account as the system program keeps it (`nonce::state::Versions`): the version and state tags, each a
/// `u32`, then the authority, the stored blockhash and its fee.
pub mod nonce {
    pub const ACCOUNT_LEN: usize = 80;
    pub const CURRENT_VERSION: u32 = 1;
    pub const INITIALIZED: u32 = 1;
    pub const AUTHORITY_OFFSET: usize = 8;
}

#[cfg(not(feature = "no-entrypoint"))]
solana_security_txt::security_txt! {
    name: "Heat Fair Open program",
    project_url: "https://github.com/imDev2023/top-pad",
    contacts: "link:https://github.com/imDev2023/top-pad/security/advisories/new",
    policy: "https://github.com/imDev2023/top-pad/blob/main/SECURITY.md",
    preferred_languages: "en",
    source_code: "https://github.com/imDev2023/top-pad"
}

#[program]
pub mod fair_open {
    use super::*;

    /// Creates the `ProgramConfig`. Only the program's upgrade authority may, so whoever controls upgrades also
    /// controls the admission signer and the keeper (spec 5.3): a plain offline key on devnet, Squads behind a 7-day
    /// timelock on mainnet.
    pub fn initialize(ctx: Context<Initialize>, settings: ProgramSettings) -> Result<()> {
        settings.check()?;
        let config = &mut ctx.accounts.program_config;
        config.set_inner(ProgramConfig { bump: ctx.bumps.program_config, ..settings.into() });
        let changed = ProgramConfigChanged::from(&**config);
        emit_cpi!(changed);
        Ok(())
    }

    /// Replaces the settings, again only by the upgrade authority: how a leaked admission or keeper key is rotated.
    pub fn update_program_config(ctx: Context<UpdateProgramConfig>, settings: ProgramSettings) -> Result<()> {
        settings.check()?;
        let config = &mut ctx.accounts.program_config;
        let bump = config.bump;
        config.set_inner(ProgramConfig { bump, ..settings.into() });
        let changed = ProgramConfigChanged::from(&**config);
        emit_cpi!(changed);
        Ok(())
    }

    /// Schedules a Fair Open (spec 2.1 steps 4 to 7): its window, its optional minimum raise and the hash its coin's
    /// identity is sealed behind, on Heat's Fair Open config and with the durable nonce its open will be signed on. The
    /// Creator wallet signs and prepays the rent of the launch and its vault; our keeper co-signs, so every launch is
    /// one Heat scheduled, as every Heat coin is one our launch key co-signed (spec 2.4).
    pub fn create_launch(ctx: Context<CreateLaunch>, params: LaunchParams) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let opens_at = params.deposits_open_at.checked_add(WINDOW_SECONDS).ok_or(FairOpenError::WindowOver)?;
        require_gt!(opens_at, now, FairOpenError::WindowOver);
        require_gte!(now + MAX_SCHEDULE_SECONDS, params.deposits_open_at, FairOpenError::TooFarAhead);
        require!(params.identity_hash != [0; 32], FairOpenError::NoIdentity);

        let config = ctx.accounts.dbc_config.try_borrow_data()?;
        require!(config.get(..8) == Some(&dbc::POOL_CONFIG_DISCRIMINATOR[..]), FairOpenError::NotADbcConfig);
        let quote_mint = address_at(&config, dbc::CONFIG_QUOTE_MINT_OFFSET).ok_or(FairOpenError::NotADbcConfig)?;
        let target =
            u64_at(&config, dbc::CONFIG_MIGRATION_QUOTE_THRESHOLD_OFFSET).ok_or(FairOpenError::NotADbcConfig)?;
        drop(config);
        require_keys_eq!(quote_mint, NATIVE_MINT, FairOpenError::QuoteNotSupported);
        let pot_cap = (target as u128 * POT_CAP_PERCENT as u128 / 100) as u64;
        require_gt!(pot_cap, 0, FairOpenError::NotADbcConfig);
        require_gte!(pot_cap, params.min_raise, FairOpenError::MinRaiseAboveCap);

        // The open is signed in advance on this nonce, which only our keeper may advance, so the creator cannot spoil
        // the signed ladder (spec 2.1 step 6).
        let nonce = ctx.accounts.nonce.try_borrow_data()?;
        let tag = |at: usize| u32_at(&nonce, at);
        require!(
            nonce.len() == nonce::ACCOUNT_LEN
                && tag(0) == Some(nonce::CURRENT_VERSION)
                && tag(4) == Some(nonce::INITIALIZED)
                && address_at(&nonce, nonce::AUTHORITY_OFFSET) == Some(ctx.accounts.keeper.key()),
            FairOpenError::NotOurNonce
        );
        drop(nonce);

        // The open's accounts are paid for now, so neither our keeper nor an empty Creator wallet at the open can stand
        // between the depositors and their coins.
        let open_rent = open_rent(&Rent::get()?);
        transfer_in(&ctx.accounts.creator, &ctx.accounts.vault, &ctx.accounts.system_program, open_rent)?;
        ctx.accounts.vault.set_inner(Vault { launch: ctx.accounts.launch.key() });
        let launch = &mut ctx.accounts.launch;
        launch.set_inner(Launch {
            creator: ctx.accounts.creator.key(),
            dbc_config: ctx.accounts.dbc_config.key(),
            quote_mint,
            nonce: ctx.accounts.nonce.key(),
            identity_hash: params.identity_hash,
            deposits_open_at: params.deposits_open_at,
            opens_at,
            min_raise: params.min_raise,
            pot_cap,
            lowest_rung: allocation::lowest_rung(pot_cap),
            step: DEPOSIT_STEP,
            status: LaunchStatus::Scheduled,
            failure: None,
            failed_at: 0,
            seats: 0,
            unverified_deposits: 0,
            scored_deposits: 0,
            verified_deposits: 0,
            coin_rent: 0,
            counts: [0; 200],
            unverified_counts: [0; 10],
            open_rent,
            mint: Pubkey::default(),
            keeper_lamports: 0,
            spend: 0,
            others_level: 0,
            unverified_level: 0,
            spent: 0,
            coins: 0,
            refunded: 0,
            delivered: 0,
            reserved: [0; 28],
            bump: ctx.bumps.launch,
            vault_bump: ctx.bumps.vault,
        });
        emit_cpi!(LaunchCreated {
            launch: launch.key(),
            creator: launch.creator,
            dbc_config: launch.dbc_config,
            quote_mint,
            nonce: launch.nonce,
            identity_hash: launch.identity_hash,
            deposits_open_at: launch.deposits_open_at,
            opens_at,
            min_raise: launch.min_raise,
            pot_cap,
            lowest_rung: launch.lowest_rung,
            step: launch.step,
        });
        Ok(())
    }

    /// A deposit during the window (spec 2.1 step 9), with our admission server's signature over who may make it, as an
    /// Ed25519 precompile instruction right before this one. The first wallet of a person takes their seat and prepays
    /// its rent and their coin account's; a second wallet of the same person is refused, so one person holds one seat
    /// and one cap. The same wallet may add to its deposit, under the cap of its latest admission. Nothing is ever
    /// revoked inside a window.
    pub fn deposit(ctx: Context<Deposit>, amount: u64, admission: Admission) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let launch = &mut ctx.accounts.launch;
        launch.check_window(now)?;
        require_gte!(now, launch.deposits_open_at, FairOpenError::WindowNotStarted);
        require!(amount > 0 && amount % launch.step == 0, FairOpenError::OffStep);

        let depositor = &ctx.accounts.depositor;
        let message = admission.message(&launch.key(), &depositor.key());
        let instructions = ctx.accounts.instructions.to_account_info();
        let current = load_current_index_checked(&instructions)? as usize;
        let precompile = match current.checked_sub(1) {
            Some(index) => load_instruction_at_checked(index, &instructions)?,
            None => return err!(FairOpenError::NoAdmission),
        };
        admission::check(&precompile, &ctx.accounts.program_config.admission_signer, &message)?;
        require_gt!(admission.expires_at, now, FairOpenError::AdmissionExpired);
        require!(
            admission.cap > 0 && admission.cap % launch.step == 0 && admission.cap <= admission.tier.cap(launch.step),
            FairOpenError::CapOverTier
        );

        let seat = &mut ctx.accounts.seat;
        let new_seat = seat.wallet == Pubkey::default();
        if new_seat {
            let coin_rent = Rent::get()?.minimum_balance(TOKEN_ACCOUNT_LEN);
            seat.set_inner(Seat {
                launch: launch.key(),
                wallet: depositor.key(),
                person: admission.person,
                tier: admission.tier,
                cap: admission.cap,
                deposit: 0,
                coin_rent,
                spent: 0,
                coins: 0,
                refund: 0,
                delivered: false,
                reserved: [0; 23],
                bump: ctx.bumps.seat,
            });
            transfer_in(depositor, &ctx.accounts.vault, &ctx.accounts.system_program, coin_rent)?;
            launch.seats = launch.seats.checked_add(1).ok_or(FairOpenError::TooManySeats)?;
            launch.coin_rent += coin_rent;
        } else {
            require_keys_eq!(seat.wallet, depositor.key(), FairOpenError::SeatHeldByAnotherWallet);
            launch.count_out(seat.tier, seat.deposit)?;
            seat.tier = admission.tier;
            seat.cap = admission.cap;
        }
        let deposit = seat.deposit.checked_add(amount).ok_or(FairOpenError::OverCap)?;
        require_gte!(seat.cap, deposit, FairOpenError::OverCap);
        transfer_in(depositor, &ctx.accounts.vault, &ctx.accounts.system_program, amount)?;
        seat.deposit = deposit;
        launch.count_in(seat.tier, deposit)?;
        check_vault(&ctx.accounts.vault, launch)?;
        emit_cpi!(Deposited {
            launch: launch.key(),
            wallet: depositor.key(),
            person: seat.person,
            tier: seat.tier,
            cap: seat.cap,
            amount,
            deposit,
            new_seat,
            pot: launch.pot(),
            seats: launch.seats,
        });
        Ok(())
    }

    /// Takes back part or all of a deposit while the window is open (spec 2.1 step 9). Taking back everything closes
    /// the seat and returns both rents.
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let launch = &mut ctx.accounts.launch;
        launch.check_window(now)?;
        let seat = &mut ctx.accounts.seat;
        require!(amount > 0 && amount % launch.step == 0, FairOpenError::OffStep);
        require_gte!(seat.deposit, amount, FairOpenError::OverDeposit);

        launch.count_out(seat.tier, seat.deposit)?;
        let deposit = seat.deposit - amount;
        seat.deposit = deposit;
        let mut paid = amount;
        if deposit > 0 {
            launch.count_in(seat.tier, deposit)?;
        } else {
            paid += seat.coin_rent;
            launch.coin_rent -= seat.coin_rent;
            launch.seats -= 1;
        }
        pay(&ctx.accounts.vault, &ctx.accounts.wallet, paid)?;
        check_vault(&ctx.accounts.vault, launch)?;
        let closed = deposit == 0;
        if closed {
            seat.close(ctx.accounts.wallet.to_account_info())?;
        }
        emit_cpi!(Withdrawn {
            launch: launch.key(),
            wallet: ctx.accounts.wallet.key(),
            person: seat.person,
            amount,
            deposit,
            closed,
            pot: launch.pot(),
            seats: launch.seats,
        });
        Ok(())
    }

    /// The open (spec 2.1 step 10): the first of this program's two instructions in the coin's creation transaction, the
    /// rung of the creator's ladder that our keeper sends at the scheduled time. It refuses before the scheduled time and
    /// from 15 minutes after it, a pot that cannot open, any rung but the largest at or below what the pot should spend,
    /// and any transaction but the creation transaction (`creation`). It then wraps exactly the rung into the pot's
    /// wrapped-SOL account and lets our keeper spend exactly that, as the pot's delegate, in DBC's swap.
    pub fn open(ctx: Context<Open>, rung: u64) -> Result<()> {
        // Before anything costs our keeper, so `settle` pays it back exactly what the open's accounts cost it.
        let keeper_lamports = ctx.accounts.keeper.lamports();
        let now = Clock::get()?.unix_timestamp;
        let launch = &mut ctx.accounts.launch;
        require!(launch.status == LaunchStatus::Scheduled, FairOpenError::NotScheduled);
        require_gte!(now, launch.opens_at, FairOpenError::TooEarly);
        require_gt!(launch.opens_at + LATE_OPEN_SECONDS, now, FairOpenError::TooLate);
        let allocation = launch.allocation();
        require!(
            allocation.spend >= launch.lowest_rung && allocation.spend >= launch.min_raise,
            FairOpenError::CannotOpen
        );
        require!(
            allocation::rung_at_or_below(launch.pot_cap, allocation.spend) == Some(rung),
            FairOpenError::WrongRung
        );

        let launch_key = launch.key();
        let pot = ctx.accounts.pot.to_account_info();
        let instructions = ctx.accounts.instructions.to_account_info();
        let open_at = load_current_index_checked(&instructions)? as usize;
        let expect = creation::Expect {
            launch: launch_key,
            dbc_config: launch.dbc_config,
            creator: launch.creator,
            keeper: ctx.accounts.keeper.key(),
            quote_mint: launch.quote_mint,
            pot: pot.key(),
            identity_hash: launch.identity_hash,
            rung,
        };
        let found = creation::check_transaction(&instructions, open_at, &expect)?;

        // The pot's wrapped-SOL account, made at its PDA, which only this program can sign for, and funded from the vault
        // with its rent and the rung, so it holds exactly the rung as wrapped SOL. The vault rides along in the system
        // program's `Allocate`, which ignores it, so the runtime sees both sides of the transfer at the first CPI after it.
        let rent = Rent::get()?.minimum_balance(TOKEN_ACCOUNT_LEN);
        let vault = ctx.accounts.vault.to_account_info();
        pay(&ctx.accounts.vault, &pot, rent.saturating_sub(pot.lamports()) + rung)?;
        let pot_seeds: &[&[u8]] = &[POT_SEED, launch_key.as_ref(), &[ctx.bumps.pot]];
        let mut data = 8u32.to_le_bytes().to_vec();
        data.extend_from_slice(&(TOKEN_ACCOUNT_LEN as u64).to_le_bytes());
        let allocate = Instruction {
            program_id: system_program::ID,
            accounts: vec![AccountMeta::new(pot.key(), true), AccountMeta::new(vault.key(), false)],
            data,
        };
        invoke_signed(&allocate, &[pot.clone(), vault], &[pot_seeds])?;
        let system = ctx.accounts.system_program.key();
        let assign = system_program::Assign { account_to_assign: pot.clone() };
        system_program::assign(CpiContext::new_with_signer(system, assign, &[pot_seeds]), &TOKEN_PROGRAM)?;
        token::initialize_account(&pot, &ctx.accounts.quote_mint, &launch_key)?;
        let nonce = launch.nonce;
        let launch_seeds: &[&[u8]] = &[LAUNCH_SEED, nonce.as_ref(), &[launch.bump]];
        token::approve(&pot, &ctx.accounts.keeper, &launch.to_account_info(), rung, launch_seeds)?;

        launch.status = LaunchStatus::Opening;
        launch.mint = found.mint;
        launch.keeper_lamports = keeper_lamports;
        launch.spend = allocation.spend;
        launch.others_level = allocation.others.level;
        launch.unverified_level = allocation.unverified.level;
        launch.spent = rung;
        Ok(())
    }

    /// The last instruction of the creation transaction (spec 2.1 step 10). DBC's swap has spent exactly the rung, so the
    /// pot's wrapped-SOL account closes back into the vault; the coins it bought are recorded; the pool's partner fee,
    /// at this instant exactly the pot's own fee, is recorded with the coin's registration in the fee program; and our
    /// keeper is paid back what the open's accounts cost it, out of the rent the creator prepaid.
    pub fn settle(ctx: Context<Settle>) -> Result<()> {
        let launch = &mut ctx.accounts.launch;
        require!(launch.status == LaunchStatus::Opening, FairOpenError::NotOpening);
        require_keys_eq!(ctx.accounts.mint.key(), launch.mint, FairOpenError::NotTheCoin);
        require_keys_eq!(*ctx.accounts.pool.owner, dbc::PROGRAM_ID, FairOpenError::NotThePool);
        let launch_key = launch.key();
        // SPL Token clears a delegate once its allowance is spent: the swap spent exactly the rung.
        require!(!TokenAccount::read(&ctx.accounts.pot)?.delegated, FairOpenError::BuyNotSpent);
        let coins = TokenAccount::read(&ctx.accounts.pot_coins)?;
        require!(coins.owner == launch_key && coins.mint == launch.mint, FairOpenError::NotThePotsCoins);
        require_gt!(coins.amount, 0, FairOpenError::NotThePotsCoins);
        let nonce = launch.nonce;
        let launch_seeds: &[&[u8]] = &[LAUNCH_SEED, nonce.as_ref(), &[launch.bump]];
        token::close(
            &ctx.accounts.pot,
            &ctx.accounts.vault.to_account_info(),
            &launch.to_account_info(),
            launch_seeds,
        )?;

        let pool = ctx.accounts.pool.try_borrow_data()?;
        require!(pool.get(..8) == Some(&dbc::VIRTUAL_POOL_DISCRIMINATOR[..]), FairOpenError::NotThePool);
        require!(
            address_at(&pool, dbc::POOL_BASE_MINT_OFFSET) == Some(launch.mint)
                && address_at(&pool, dbc::POOL_CONFIG_OFFSET) == Some(launch.dbc_config),
            FairOpenError::NotThePool
        );
        let pot_fee = u64_at(&pool, dbc::POOL_PARTNER_QUOTE_FEE_OFFSET).ok_or(FairOpenError::NotThePool)?;
        drop(pool);
        register_coin(ctx.accounts, launch_key, pot_fee, ctx.bumps.coin_registrar)?;

        let launch = &mut ctx.accounts.launch;
        let cost = launch.keeper_lamports.saturating_sub(ctx.accounts.keeper.lamports());
        let paid_back = cost.min(launch.open_rent);
        pay(&ctx.accounts.vault, &ctx.accounts.keeper, paid_back)?;
        launch.open_rent -= paid_back;
        launch.keeper_lamports = 0;
        launch.coins = coins.amount;
        launch.status = LaunchStatus::Opened;
        check_vault(&ctx.accounts.vault, launch)?;
        emit_cpi!(LaunchOpened {
            launch: launch_key,
            creator: launch.creator,
            mint: launch.mint,
            pool: ctx.accounts.pool.key(),
            spend: launch.spend,
            spent: launch.spent,
            coins: launch.coins,
            others_level: launch.others_level,
            unverified_level: launch.unverified_level,
            pot_fee,
            rent_paid_back: paid_back,
            seats: launch.seats,
        });
        Ok(())
    }

    /// Delivers seats their coins and refund once the launch has opened (spec 2.1 step 12): anyone may send it, and our
    /// keeper does at once. Each seat comes as three remaining accounts: the seat, its wallet, and the wallet's own
    /// account of the coin, which the push makes from the rent the seat prepaid, or, if it exists already, returns that
    /// rent with the refund. A seat already delivered is passed over, and so is the creator's, whose coins leave the pot
    /// only into the Creator lock (spec 2.1 step 13), so a push sent twice delivers nothing twice.
    pub fn push<'info>(ctx: Context<'info, Push<'info>>) -> Result<()> {
        require!(ctx.accounts.launch.status == LaunchStatus::Opened, FairOpenError::NotOpened);
        if ctx.accounts.launch.delivered == ctx.accounts.launch.seats {
            msg!("Every seat has its coins");
            return Ok(());
        }
        let decimals = check_pot_coins(&ctx.accounts.launch, &ctx.accounts.pot_coins, &ctx.accounts.mint)?;
        // Lamports leave the vault by hand after the last CPI, so no CPI ever sees one side of a transfer and not the other.
        let mut payments: Vec<(&AccountInfo<'info>, u64)> = vec![];
        for accounts in ctx.remaining_accounts.chunks(3) {
            let [seat, wallet, coin_account] = accounts else { return err!(FairOpenError::SeatAccounts) };
            let mut seat: Account<'info, Seat> = Account::try_from(seat)?;
            require_keys_eq!(seat.launch, ctx.accounts.launch.key(), FairOpenError::NotThisLaunchsSeat);
            require_keys_eq!(seat.wallet, wallet.key(), FairOpenError::NotYourSeat);
            if seat.delivered || seat.wallet == ctx.accounts.launch.creator {
                continue;
            }
            // The wallet's own account of the coin: the Associated Token Account program checks its address, and makes it
            // from the seat's prepaid rent when it does not exist yet.
            let made = coin_account.data_is_empty();
            if made {
                pay(&ctx.accounts.vault, coin_account, seat.coin_rent)?;
            }
            create_associated_account(ctx.accounts, coin_account, wallet)?;
            let coin_rent_back = if made { 0 } else { seat.coin_rent };
            let delivered = deliver(
                &mut ctx.accounts.launch,
                &ctx.accounts.pot_coins,
                &ctx.accounts.mint,
                decimals,
                &mut seat,
                coin_account,
                coin_rent_back,
                true,
            )?;
            payments.push((wallet, delivered.refund + delivered.coin_rent));
            seat.exit(&crate::ID)?;
            emit_cpi!(delivered);
        }
        let burnt = finish(&mut ctx.accounts.launch, &ctx.accounts.vault, &ctx.accounts.pot_coins, &ctx.accounts.mint)?;
        if let Some(event) = burnt {
            emit_cpi!(event);
        }
        for (wallet, amount) in payments {
            pay(&ctx.accounts.vault, wallet, amount)?;
        }
        check_vault(&ctx.accounts.vault, &ctx.accounts.launch)
    }

    /// A depositor takes their seat's coins and refund themselves, if no push has (spec 2.1 step 12), into any account of
    /// the coin they own; the coin account's prepaid rent comes back with the refund. The creator's seat is the Creator
    /// lock's alone.
    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        let launch = &ctx.accounts.launch;
        require!(launch.status == LaunchStatus::Opened, FairOpenError::NotOpened);
        let seat = &ctx.accounts.seat;
        require!(!seat.delivered, FairOpenError::AlreadyDelivered);
        require_keys_neq!(seat.wallet, launch.creator, FairOpenError::CreatorsSeat);
        let decimals = check_pot_coins(launch, &ctx.accounts.pot_coins, &ctx.accounts.mint)?;
        let coin_account = TokenAccount::read(&ctx.accounts.coin_account)?;
        require!(
            coin_account.owner == seat.wallet && coin_account.mint == launch.mint,
            FairOpenError::NotYourCoinAccount
        );
        let coin_rent_back = seat.coin_rent;
        let delivered = deliver(
            &mut ctx.accounts.launch,
            &ctx.accounts.pot_coins,
            &ctx.accounts.mint,
            decimals,
            &mut ctx.accounts.seat,
            &ctx.accounts.coin_account,
            coin_rent_back,
            false,
        )?;
        let paid = delivered.refund + delivered.coin_rent;
        emit_cpi!(delivered);
        let burnt = finish(&mut ctx.accounts.launch, &ctx.accounts.vault, &ctx.accounts.pot_coins, &ctx.accounts.mint)?;
        if let Some(event) = burnt {
            emit_cpi!(event);
        }
        // After the last CPI, as in a push.
        pay(&ctx.accounts.vault, &ctx.accounts.wallet, paid)?;
        check_vault(&ctx.accounts.vault, &ctx.accounts.launch)
    }

    /// Marks a launch that cannot open as failed, so no coin is ever created and every deposit comes back (spec 2.1
    /// step 15). Anyone may send it once the window has closed: at once when the pot would spend less than the lowest
    /// rung or the minimum raise, and from 15 minutes after the scheduled open whatever the pot holds.
    pub fn mark_failed(ctx: Context<MarkFailed>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let launch = &mut ctx.accounts.launch;
        require!(launch.status == LaunchStatus::Scheduled, FairOpenError::NotScheduled);
        require_gte!(now, launch.opens_at, FairOpenError::WindowNotClosed);
        let spend = launch.allocation().spend;
        let failure = if spend < launch.lowest_rung {
            Failure::BelowLowestRung
        } else if spend < launch.min_raise {
            Failure::MinRaiseMissed
        } else if now >= launch.opens_at + LATE_OPEN_SECONDS {
            Failure::Late
        } else {
            return err!(FairOpenError::CanStillOpen);
        };
        launch.status = LaunchStatus::Failed;
        launch.failure = Some(failure);
        launch.failed_at = now;
        emit_cpi!(LaunchFailed { launch: launch.key(), failure, spend, pot: launch.pot(), seats: launch.seats });
        Ok(())
    }

    /// Returns a failed launch's deposit and both rents to its depositor's wallet (spec 2.1 step 15). The depositor can
    /// send it alone, with no Heat server running; anyone else may send it too, since it pays only that wallet.
    pub fn withdraw_failed(ctx: Context<WithdrawFailed>) -> Result<()> {
        let launch = &mut ctx.accounts.launch;
        require!(launch.status == LaunchStatus::Failed, FairOpenError::NotFailed);
        let seat = &ctx.accounts.seat;
        let (deposit, coin_rent) = (seat.deposit, seat.coin_rent);
        launch.count_out(seat.tier, deposit)?;
        launch.coin_rent -= coin_rent;
        launch.seats -= 1;
        pay(&ctx.accounts.vault, &ctx.accounts.wallet, deposit + coin_rent)?;
        check_vault(&ctx.accounts.vault, launch)?;
        // The seat's own rent comes back as it closes, when the instruction ends.
        emit_cpi!(FailedDepositReturned {
            launch: launch.key(),
            wallet: seat.wallet,
            person: seat.person,
            deposit,
            coin_rent,
            seat_rent: seat.to_account_info().lamports(),
            seats: launch.seats,
        });
        Ok(())
    }

    /// Closes a failed launch once every seat has been returned, giving the creator back the rent of the launch and its
    /// vault. Anyone may send it; it pays only the creator.
    pub fn close_launch(ctx: Context<CloseLaunch>) -> Result<()> {
        let launch = &ctx.accounts.launch;
        require!(launch.status == LaunchStatus::Failed, FairOpenError::NotFailed);
        require_eq!(launch.seats, 0, FairOpenError::SeatsLeft);
        emit_cpi!(LaunchClosed {
            launch: launch.key(),
            creator: launch.creator,
            rent: launch.to_account_info().lamports() + ctx.accounts.vault.to_account_info().lamports(),
        });
        Ok(())
    }
}

/// The 32-byte address at `offset`, if the data holds one there.
fn address_at(data: &[u8], offset: usize) -> Option<Pubkey> {
    Some(Pubkey::new_from_array(data.get(offset..offset + 32)?.try_into().ok()?))
}

fn u64_at(data: &[u8], offset: usize) -> Option<u64> {
    Some(u64::from_le_bytes(data.get(offset..offset + 8)?.try_into().ok()?))
}

fn u32_at(data: &[u8], offset: usize) -> Option<u32> {
    Some(u32::from_le_bytes(data.get(offset..offset + 4)?.try_into().ok()?))
}

/// Moves `amount` of the depositor's SOL into the vault.
fn transfer_in<'info>(
    from: &Signer<'info>,
    vault: &Account<'info, Vault>,
    system: &Program<'info, System>,
    amount: u64,
) -> Result<()> {
    let accounts = system_program::Transfer { from: from.to_account_info(), to: vault.to_account_info() };
    system_program::transfer(CpiContext::new(system.key(), accounts), amount)
}

/// Pays `amount` out of the vault, which this program owns, to `to`.
fn pay(vault: &Account<Vault>, to: &AccountInfo, amount: u64) -> Result<()> {
    vault.to_account_info().sub_lamports(amount)?;
    to.add_lamports(amount)?;
    Ok(())
}

/// The vault always holds at least what it owes (spec 5.3): every deposit and the coin-account rent prepaid, on top of
/// its own rent.
fn check_vault(vault: &Account<Vault>, launch: &Launch) -> Result<()> {
    let own_rent = Rent::get()?.minimum_balance(8 + Vault::INIT_SPACE);
    let held = vault.to_account_info().lamports().saturating_sub(own_rent);
    require_gte!(held, launch.owed(), FairOpenError::VaultShort);
    Ok(())
}

/// Registers the coin with the fee program, signed by the coin registrar: its record names the launch and the pot's own
/// fee, and our keeper pays its rent, which `settle` pays back.
fn register_coin(a: &Settle, launch: Pubkey, pot_fee: u64, registrar_bump: u8) -> Result<()> {
    let mut data = fee::REGISTER_FAIR_OPEN_COIN_DISCRIMINATOR.to_vec();
    data.extend_from_slice(launch.as_ref());
    data.extend_from_slice(&pot_fee.to_le_bytes());
    let accounts = [
        (a.fee_config.to_account_info(), false, false),
        (a.coin_registrar.to_account_info(), false, true),
        (a.keeper.to_account_info(), true, true),
        (a.mint.to_account_info(), false, false),
        (a.pool.to_account_info(), false, false),
        (a.dbc_config.to_account_info(), false, false),
        (a.coin_record.to_account_info(), true, false),
        (a.system_program.to_account_info(), false, false),
        (a.fee_event_authority.to_account_info(), false, false),
        (a.fee_program.to_account_info(), false, false),
    ];
    let metas = accounts
        .iter()
        .map(|(info, writable, signs)| match writable {
            true => AccountMeta::new(info.key(), *signs),
            false => AccountMeta::new_readonly(info.key(), *signs),
        })
        .collect();
    let infos: Vec<AccountInfo> = accounts.into_iter().map(|(info, _, _)| info).collect();
    let instruction = Instruction { program_id: a.fee_program.key(), accounts: metas, data };
    invoke_signed(&instruction, &infos, &[&[COIN_REGISTRAR_SEED, &[registrar_bump]]])?;
    Ok(())
}

/// Checks the pot's coin account is the launch's own account of its coin, and returns the coin's decimals.
fn check_pot_coins(launch: &Account<Launch>, pot_coins: &AccountInfo, mint: &AccountInfo) -> Result<u8> {
    let pot = TokenAccount::read(pot_coins)?;
    require!(pot.owner == launch.key() && pot.mint == launch.mint, FairOpenError::NotThePotsCoins);
    token::decimals(mint)
}

/// The Associated Token Account program's `CreateIdempotent`: makes `wallet`'s own account of the coin unless it exists,
/// and fails if `account` is not that account. A push's seats prepaid the rent of each account it makes.
fn create_associated_account<'info>(
    a: &Push<'info>,
    account: &AccountInfo<'info>,
    wallet: &AccountInfo<'info>,
) -> Result<()> {
    let instruction = Instruction {
        program_id: creation::ASSOCIATED_TOKEN_PROGRAM,
        accounts: vec![
            AccountMeta::new(a.payer.key(), true),
            AccountMeta::new(account.key(), false),
            AccountMeta::new_readonly(wallet.key(), false),
            AccountMeta::new_readonly(a.mint.key(), false),
            AccountMeta::new_readonly(system_program::ID, false),
            AccountMeta::new_readonly(TOKEN_PROGRAM, false),
            // Ignored by the program: the vault, which may have just paid this account's rent, rides along so the
            // runtime sees both sides of that transfer.
            AccountMeta::new(a.vault.key(), false),
        ],
        data: vec![1],
    };
    let infos = [
        a.payer.to_account_info(),
        account.clone(),
        wallet.clone(),
        a.mint.to_account_info(),
        a.system_program.to_account_info(),
        a.token_program.to_account_info(),
        a.vault.to_account_info(),
        a.associated_token_program.to_account_info(),
    ];
    anchor_lang::solana_program::program::invoke(&instruction, &infos)?;
    Ok(())
}

/// Delivers a seat its part of the open (spec 2.1 steps 11 and 12): moves its coins from the pot's coin account to
/// `coin_account` and records the seat delivered. Its refund, with `coin_rent_back` of its coin account's prepaid rent,
/// is the caller's to pay from the vault to its wallet, once no CPI is left.
#[allow(clippy::too_many_arguments)]
fn deliver<'info>(
    launch: &mut Account<'info, Launch>,
    pot_coins: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    decimals: u8,
    seat: &mut Seat,
    coin_account: &AccountInfo<'info>,
    coin_rent_back: u64,
    pushed: bool,
) -> Result<SeatDelivered> {
    let outcome = launch.outcome(seat.tier, seat.deposit);
    if outcome.coins > 0 {
        let nonce = launch.nonce;
        let seeds: &[&[u8]] = &[LAUNCH_SEED, nonce.as_ref(), &[launch.bump]];
        token::transfer(pot_coins, mint, coin_account, &launch.to_account_info(), outcome.coins, decimals, seeds)?;
    }
    launch.refunded += outcome.refund;
    launch.coin_rent -= seat.coin_rent;
    launch.delivered += 1;
    seat.spent = outcome.spent;
    seat.coins = outcome.coins;
    seat.refund = outcome.refund;
    seat.coin_rent = 0;
    seat.delivered = true;
    Ok(SeatDelivered {
        launch: launch.key(),
        wallet: seat.wallet,
        person: seat.person,
        coin_account: coin_account.key(),
        deposit: seat.deposit,
        fill: outcome.fill,
        spent: outcome.spent,
        coins: outcome.coins,
        refund: outcome.refund,
        coin_rent: coin_rent_back,
        pushed,
        delivered: launch.delivered,
    })
}

/// Once every seat has its coins, burns the coins the rounding left in the pot (spec 12) and closes the pot's coin
/// account into the vault, whose rent was the creator's.
fn finish<'info>(
    launch: &mut Account<'info, Launch>,
    vault: &Account<'info, Vault>,
    pot_coins: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
) -> Result<Option<CoinDustBurnt>> {
    if launch.delivered < launch.seats {
        return Ok(None);
    }
    let nonce = launch.nonce;
    let seeds: &[&[u8]] = &[LAUNCH_SEED, nonce.as_ref(), &[launch.bump]];
    let dust = TokenAccount::read(pot_coins)?.amount;
    if dust > 0 {
        token::burn(pot_coins, mint, &launch.to_account_info(), dust, seeds)?;
    }
    token::close(pot_coins, &vault.to_account_info(), &launch.to_account_info(), seeds)?;
    Ok(Some(CoinDustBurnt { launch: launch.key(), mint: launch.mint, amount: dust }))
}

/// A person's Depositor tier (spec 2.1 step 9, 6.3): how strongly they have shown they are one person.
#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tier {
    Unverified,
    Scored,
    Verified,
}

impl Tier {
    /// The tier's cap per Fair Open, in the quote's raw units.
    pub fn cap(self, step: u64) -> u64 {
        step * match self {
            Tier::Unverified => UNVERIFIED_CAP_STEPS,
            Tier::Scored => SCORED_CAP_STEPS,
            Tier::Verified => VERIFIED_CAP_STEPS,
        }
    }
}

/// Who the program trusts: the admission signer and the keeper, which program its coins register with, and the config
/// its launches run on.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProgramSettings {
    /// Signs each deposit's admission (spec 10.3), and holds no funds.
    pub admission_signer: Pubkey,
    /// Heat's keeper key: co-signs every launch, holds each launch's durable nonce, and sends the open.
    pub keeper: Pubkey,
    /// The fee program, which `settle` registers each Fair Open's coin with.
    pub fee_program: Pubkey,
    /// Heat's Fair Open DBC config: every launch's coin is created on it.
    pub dbc_config: Pubkey,
}

impl ProgramSettings {
    fn check(&self) -> Result<()> {
        for key in [self.admission_signer, self.keeper, self.fee_program, self.dbc_config] {
            require_keys_neq!(key, Pubkey::default(), FairOpenError::MissingSetting);
        }
        Ok(())
    }
}

impl From<ProgramSettings> for ProgramConfig {
    fn from(s: ProgramSettings) -> Self {
        ProgramConfig {
            admission_signer: s.admission_signer,
            keeper: s.keeper,
            fee_program: s.fee_program,
            dbc_config: s.dbc_config,
            bump: 0,
        }
    }
}

#[account]
#[derive(InitSpace, Debug)]
pub struct ProgramConfig {
    pub admission_signer: Pubkey,
    pub keeper: Pubkey,
    pub fee_program: Pubkey,
    pub dbc_config: Pubkey,
    pub bump: u8,
}

/// What the creator chooses when scheduling (spec 2.1 steps 4 and 5).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct LaunchParams {
    /// When the window opens, a Unix timestamp; it closes 10 minutes later, at the scheduled open.
    pub deposits_open_at: i64,
    /// The least the pot must spend for the coin to be created, in the quote's raw units; 0 for none.
    pub min_raise: u64,
    /// The SHA-256 the coin's name, ticker and metadata URI are sealed behind: of DBC's `initialize_virtual_pool`
    /// parameters as they are serialized, which the open checks against the coin it creates (spec 2.1 step 5).
    pub identity_hash: [u8; 32],
}

/// One per Fair Open, at the PDA of its durable nonce account: its schedule and terms, and how many seats ask each
/// deposit, from which the allocation is found with no list of seats (spec 2.1 step 11).
#[account]
#[derive(InitSpace, Debug)]
pub struct Launch {
    /// The Creator wallet: signs the launch, pays its rent and gets it back, and its seat is the creator's seat.
    pub creator: Pubkey,
    pub dbc_config: Pubkey,
    pub quote_mint: Pubkey,
    /// The durable nonce the open is signed on, which only our keeper may advance.
    pub nonce: Pubkey,
    pub identity_hash: [u8; 32],
    /// When the window opens and when it closes, which is the scheduled open, Unix timestamps.
    pub deposits_open_at: i64,
    pub opens_at: i64,
    /// In the quote's raw units: the least the pot must spend, the most it may (20% of the Graduation Target), and the
    /// ladder's lowest rung, below which it cannot open.
    pub min_raise: u64,
    pub pot_cap: u64,
    pub lowest_rung: u64,
    /// The deposit step, in the quote's raw units.
    pub step: u64,
    pub status: LaunchStatus,
    /// Why the launch failed and when, by the chain's clock.
    pub failure: Option<Failure>,
    pub failed_at: i64,
    /// Seats holding a deposit.
    pub seats: u32,
    /// What each tier's seats have deposited, in the quote's raw units.
    pub unverified_deposits: u64,
    pub scored_deposits: u64,
    pub verified_deposits: u64,
    /// The coin-account rent the seats prepaid, held in the vault until the push or a refund.
    pub coin_rent: u64,
    /// How many Scored and Verified seats ask each deposit: `counts[k]` ask `(k + 1)` steps, up to the Verified cap.
    pub counts: [u32; 200],
    /// How many Unverified seats ask each deposit, up to the Unverified cap.
    pub unverified_counts: [u32; 10],
    /// What the open's accounts cost, prepaid by the creator at scheduling and held in the vault; after the open, what
    /// is left of it once our keeper has been paid back, which comes back to the creator.
    pub open_rent: u64,
    /// The coin, from the open on.
    pub mint: Pubkey,
    /// Our keeper's balance as the open began, inside the creation transaction alone.
    pub keeper_lamports: u64,
    /// At the open, in the quote's raw units: what the fills added up to, and each level (spec 2.1 step 11).
    pub spend: u64,
    pub others_level: u64,
    pub unverified_level: u64,
    /// The rung: what the pot spent, in the quote's raw units; and the coins it bought.
    pub spent: u64,
    pub coins: u64,
    /// The refunds pushes and claims have paid, and how many seats have had their coins and refund.
    pub refunded: u64,
    pub delivered: u32,
    /// Room for what the Creator lock and the Tax Share will record.
    pub reserved: [u8; 28],
    pub bump: u8,
    pub vault_bump: u8,
}

impl Launch {
    /// Deposits are taken and taken back only while the window is open.
    fn check_window(&self, now: i64) -> Result<()> {
        require!(self.status == LaunchStatus::Scheduled, FairOpenError::NotScheduled);
        require_gt!(self.opens_at, now, FairOpenError::WindowClosed);
        Ok(())
    }

    fn counts_of(&mut self, tier: Tier) -> &mut [u32] {
        match tier {
            Tier::Unverified => &mut self.unverified_counts,
            Tier::Scored | Tier::Verified => &mut self.counts,
        }
    }

    fn total_of(&mut self, tier: Tier) -> &mut u64 {
        match tier {
            Tier::Unverified => &mut self.unverified_deposits,
            Tier::Scored => &mut self.scored_deposits,
            Tier::Verified => &mut self.verified_deposits,
        }
    }

    /// Counts a seat asking `deposit` in its tier's counts and total.
    fn count_in(&mut self, tier: Tier, deposit: u64) -> Result<()> {
        let k = (deposit / self.step).checked_sub(1).ok_or(FairOpenError::OffStep)? as usize;
        let count = self.counts_of(tier).get_mut(k).ok_or(FairOpenError::CapOverTier)?;
        *count = count.checked_add(1).ok_or(FairOpenError::TooManySeats)?;
        *self.total_of(tier) += deposit;
        Ok(())
    }

    /// Takes a seat asking `deposit` out of its tier's counts and total, before it changes or leaves.
    fn count_out(&mut self, tier: Tier, deposit: u64) -> Result<()> {
        let k = (deposit / self.step).checked_sub(1).ok_or(FairOpenError::OffStep)? as usize;
        let count = self.counts_of(tier).get_mut(k).ok_or(FairOpenError::CapOverTier)?;
        *count = count.checked_sub(1).ok_or(FairOpenError::SeatNotCounted)?;
        let total = self.total_of(tier);
        *total = total.checked_sub(deposit).ok_or(FairOpenError::SeatNotCounted)?;
        Ok(())
    }

    /// Everything deposited.
    pub fn pot(&self) -> u64 {
        self.unverified_deposits + self.scored_deposits + self.verified_deposits
    }

    /// What the vault owes: every deposit, the coin-account rent the seats prepaid, and what is left of the open's rent.
    /// After the open the pot has spent the rung, and the refunds paid out are gone; what the deposits still owe is then
    /// every refund not yet paid and the lamports the rounding gathered for the Tax Share.
    pub fn owed(&self) -> u64 {
        let deposits = match self.status {
            LaunchStatus::Opened => self.pot() - self.spent - self.refunded,
            _ => self.pot(),
        };
        deposits + self.coin_rent + self.open_rent
    }

    /// How the pot would buy if its window closed now.
    pub fn allocation(&self) -> allocation::Allocation {
        allocation::allocate(&self.counts, &self.unverified_counts, self.step, self.pot_cap)
    }

    /// A seat's part of the open (spec 2.1 step 11): its fill at its tier's level, what it spent of the rung, the coins
    /// it bought at the pot's one price, and its refund.
    pub fn outcome(&self, tier: Tier, deposit: u64) -> Outcome {
        let level = match tier {
            Tier::Unverified => self.unverified_level,
            Tier::Scored | Tier::Verified => self.others_level,
        };
        let fill = deposit.min(level);
        let (spent, coins) = allocation::share(fill, self.spend, self.spent, self.coins);
        Outcome { fill, spent, coins, refund: deposit - spent }
    }
}

/// A seat's part of the open, in the quote's raw units and the coin's.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Outcome {
    pub fill: u64,
    pub spent: u64,
    pub coins: u64,
    pub refund: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, Debug, PartialEq, Eq)]
pub enum LaunchStatus {
    /// From scheduling to the open: deposits are taken inside the window.
    Scheduled,
    /// No coin was or will be created; every deposit comes back.
    Failed,
    /// Between `open` and `settle`, inside the creation transaction alone.
    Opening,
    /// The coin and its pool exist, and the pot bought; its seats get their coins and refund.
    Opened,
}

#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, Debug, PartialEq, Eq)]
pub enum Failure {
    /// The pot would spend less than the ladder's lowest rung.
    BelowLowestRung,
    /// The pot would spend less than the creator's minimum raise.
    MinRaiseMissed,
    /// The open had not run 15 minutes after its scheduled time.
    Late,
}

/// Holds a launch's deposits as plain SOL (spec 5.3), at the PDA of its launch.
#[account]
#[derive(InitSpace, Debug)]
pub struct Vault {
    pub launch: Pubkey,
}

/// One per launch and person, at the PDA of the launch and the person's pseudonym, held by the one wallet that took it
/// (spec 5.3, 6.3).
#[account]
#[derive(InitSpace, Debug)]
pub struct Seat {
    pub launch: Pubkey,
    pub wallet: Pubkey,
    /// The person's pseudonym in this launch.
    pub person: [u8; 32],
    pub tier: Tier,
    /// The most the seat may hold, in the quote's raw units, from its latest admission.
    pub cap: u64,
    /// What the seat has deposited: what it asks the pot to buy with.
    pub deposit: u64,
    /// The coin account's rent the depositor prepaid, which the push spends or returns.
    pub coin_rent: u64,
    /// Once delivered (spec 2.1 step 12): what its deposit spent, the coins it bought, and its refund.
    pub spent: u64,
    pub coins: u64,
    pub refund: u64,
    /// Whether a push or its own claim has delivered its coins and refund.
    pub delivered: bool,
    /// Room for what the Tax Share will record.
    pub reserved: [u8; 23],
    pub bump: u8,
}

#[event_cpi]
#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = payer, space = 8 + ProgramConfig::INIT_SPACE, seeds = [PROGRAM_CONFIG_SEED], bump)]
    pub program_config: Account<'info, ProgramConfig>,
    pub authority: Signer<'info>,
    /// This program's ProgramData, at the address the upgradeable loader derives from the program id.
    #[account(
        seeds = [crate::ID.as_ref()],
        bump,
        seeds::program = bpf_loader_upgradeable::ID,
        constraint = program_data.upgrade_authority_address == Some(authority.key()) @ FairOpenError::NotUpgradeAuthority,
    )]
    pub program_data: Account<'info, ProgramData>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct UpdateProgramConfig<'info> {
    #[account(mut, seeds = [PROGRAM_CONFIG_SEED], bump = program_config.bump)]
    pub program_config: Account<'info, ProgramConfig>,
    pub authority: Signer<'info>,
    /// This program's ProgramData, at the address the upgradeable loader derives from the program id.
    #[account(
        seeds = [crate::ID.as_ref()],
        bump,
        seeds::program = bpf_loader_upgradeable::ID,
        constraint = program_data.upgrade_authority_address == Some(authority.key()) @ FairOpenError::NotUpgradeAuthority,
    )]
    pub program_data: Account<'info, ProgramData>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct CreateLaunch<'info> {
    #[account(
        seeds = [PROGRAM_CONFIG_SEED],
        bump = program_config.bump,
        has_one = keeper @ FairOpenError::NotTheKeeper,
        has_one = dbc_config @ FairOpenError::NotTheFairOpenConfig,
    )]
    pub program_config: Account<'info, ProgramConfig>,
    /// The Creator wallet, which pays the rent.
    #[account(mut)]
    pub creator: Signer<'info>,
    pub keeper: Signer<'info>,
    /// CHECK: Heat's Fair Open config, by the program config; owned by DBC, its quote and Graduation Target read in the
    /// handler.
    #[account(owner = dbc::PROGRAM_ID @ FairOpenError::NotADbcConfig)]
    pub dbc_config: UncheckedAccount<'info>,
    /// CHECK: the launch's durable nonce account, owned by the system program; its state and authority are checked in
    /// the handler.
    #[account(owner = system_program::ID @ FairOpenError::NotOurNonce)]
    pub nonce: UncheckedAccount<'info>,
    #[account(init, payer = creator, space = 8 + Launch::INIT_SPACE, seeds = [LAUNCH_SEED, nonce.key().as_ref()], bump)]
    pub launch: Box<Account<'info, Launch>>,
    #[account(init, payer = creator, space = 8 + Vault::INIT_SPACE, seeds = [VAULT_SEED, launch.key().as_ref()], bump)]
    pub vault: Account<'info, Vault>,
    pub system_program: Program<'info, System>,
}

#[event_cpi]
#[derive(Accounts)]
#[instruction(amount: u64, admission: Admission)]
pub struct Deposit<'info> {
    #[account(seeds = [PROGRAM_CONFIG_SEED], bump = program_config.bump)]
    pub program_config: Account<'info, ProgramConfig>,
    #[account(mut, seeds = [LAUNCH_SEED, launch.nonce.as_ref()], bump = launch.bump)]
    pub launch: Box<Account<'info, Launch>>,
    #[account(mut, seeds = [VAULT_SEED, launch.key().as_ref()], bump = launch.vault_bump)]
    pub vault: Account<'info, Vault>,
    #[account(
        init_if_needed,
        payer = depositor,
        space = 8 + Seat::INIT_SPACE,
        seeds = [SEAT_SEED, launch.key().as_ref(), admission.person.as_ref()],
        bump,
    )]
    pub seat: Account<'info, Seat>,
    #[account(mut)]
    pub depositor: Signer<'info>,
    /// CHECK: the instructions sysvar, from which the admission's precompile instruction is read.
    #[account(address = solana_instructions_sysvar::ID)]
    pub instructions: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut, seeds = [LAUNCH_SEED, launch.nonce.as_ref()], bump = launch.bump)]
    pub launch: Box<Account<'info, Launch>>,
    #[account(mut, seeds = [VAULT_SEED, launch.key().as_ref()], bump = launch.vault_bump)]
    pub vault: Account<'info, Vault>,
    #[account(
        mut,
        seeds = [SEAT_SEED, launch.key().as_ref(), seat.person.as_ref()],
        bump = seat.bump,
        has_one = launch @ FairOpenError::NotThisLaunchsSeat,
        has_one = wallet @ FairOpenError::NotYourSeat,
    )]
    pub seat: Account<'info, Seat>,
    #[account(mut)]
    pub wallet: Signer<'info>,
}

#[derive(Accounts)]
pub struct Open<'info> {
    #[account(seeds = [PROGRAM_CONFIG_SEED], bump = program_config.bump, has_one = keeper @ FairOpenError::NotTheKeeper)]
    pub program_config: Account<'info, ProgramConfig>,
    #[account(mut, seeds = [LAUNCH_SEED, launch.nonce.as_ref()], bump = launch.bump)]
    pub launch: Box<Account<'info, Launch>>,
    #[account(mut, seeds = [VAULT_SEED, launch.key().as_ref()], bump = launch.vault_bump)]
    pub vault: Account<'info, Vault>,
    /// CHECK: the pot's wrapped-SOL account, at its PDA, made in the handler.
    #[account(mut, seeds = [POT_SEED, launch.key().as_ref()], bump)]
    pub pot: UncheckedAccount<'info>,
    /// Our keeper, which sends the open, fronts its accounts' rent and spends exactly the buy as the pot's delegate.
    pub keeper: Signer<'info>,
    /// CHECK: the launch's quote.
    #[account(address = launch.quote_mint @ FairOpenError::QuoteNotSupported)]
    pub quote_mint: UncheckedAccount<'info>,
    /// CHECK: SPL Token.
    #[account(address = TOKEN_PROGRAM)]
    pub token_program: UncheckedAccount<'info>,
    /// CHECK: the instructions sysvar, from which the transaction's shape is read.
    #[account(address = solana_instructions_sysvar::ID)]
    pub instructions: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct Settle<'info> {
    #[account(
        seeds = [PROGRAM_CONFIG_SEED],
        bump = program_config.bump,
        has_one = keeper @ FairOpenError::NotTheKeeper,
        has_one = fee_program @ FairOpenError::NotTheFeeProgram,
    )]
    pub program_config: Account<'info, ProgramConfig>,
    #[account(mut, seeds = [LAUNCH_SEED, launch.nonce.as_ref()], bump = launch.bump)]
    pub launch: Box<Account<'info, Launch>>,
    #[account(mut, seeds = [VAULT_SEED, launch.key().as_ref()], bump = launch.vault_bump)]
    pub vault: Account<'info, Vault>,
    /// CHECK: the pot's wrapped-SOL account, at its PDA; read and closed in the handler.
    #[account(mut, seeds = [POT_SEED, launch.key().as_ref()], bump)]
    pub pot: UncheckedAccount<'info>,
    /// CHECK: the pot's coin account, the launch's own account of its coin; read in the handler.
    pub pot_coins: UncheckedAccount<'info>,
    /// Our keeper, which is paid back the rent of the open's accounts.
    #[account(mut)]
    pub keeper: Signer<'info>,
    /// CHECK: the coin, the launch's since the open; checked in the handler.
    pub mint: UncheckedAccount<'info>,
    /// CHECK: the coin's pool: its owner, discriminator, config and base mint are checked in the handler.
    pub pool: UncheckedAccount<'info>,
    /// CHECK: Heat's Fair Open config, the launch's.
    #[account(address = launch.dbc_config @ FairOpenError::NotTheFairOpenConfig)]
    pub dbc_config: UncheckedAccount<'info>,
    /// CHECK: the coin's record, which the fee program makes and checks.
    #[account(mut)]
    pub coin_record: UncheckedAccount<'info>,
    /// CHECK: the coin registrar, this program's PDA, which signs the coin's registration.
    #[account(seeds = [COIN_REGISTRAR_SEED], bump)]
    pub coin_registrar: UncheckedAccount<'info>,
    /// CHECK: the fee program's `FeeConfig`, which the fee program checks.
    pub fee_config: UncheckedAccount<'info>,
    /// CHECK: the fee program's event authority, which the fee program checks.
    pub fee_event_authority: UncheckedAccount<'info>,
    /// CHECK: the fee program, by the program config.
    pub fee_program: UncheckedAccount<'info>,
    /// CHECK: SPL Token.
    #[account(address = TOKEN_PROGRAM)]
    pub token_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct Push<'info> {
    #[account(mut, seeds = [LAUNCH_SEED, launch.nonce.as_ref()], bump = launch.bump)]
    pub launch: Box<Account<'info, Launch>>,
    #[account(mut, seeds = [VAULT_SEED, launch.key().as_ref()], bump = launch.vault_bump)]
    pub vault: Account<'info, Vault>,
    /// CHECK: the pot's coin account, the launch's own account of its coin; checked in the handler.
    #[account(mut)]
    pub pot_coins: UncheckedAccount<'info>,
    /// CHECK: the coin, the launch's.
    #[account(mut, address = launch.mint @ FairOpenError::NotTheCoin)]
    pub mint: UncheckedAccount<'info>,
    /// Whoever sends the push: the Associated Token Account program's payer, though the seats' prepaid rent funds every
    /// account it makes.
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: SPL Token.
    #[account(address = TOKEN_PROGRAM)]
    pub token_program: UncheckedAccount<'info>,
    /// CHECK: the Associated Token Account program.
    #[account(address = creation::ASSOCIATED_TOKEN_PROGRAM)]
    pub associated_token_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(mut, seeds = [LAUNCH_SEED, launch.nonce.as_ref()], bump = launch.bump)]
    pub launch: Box<Account<'info, Launch>>,
    #[account(mut, seeds = [VAULT_SEED, launch.key().as_ref()], bump = launch.vault_bump)]
    pub vault: Account<'info, Vault>,
    #[account(
        mut,
        seeds = [SEAT_SEED, launch.key().as_ref(), seat.person.as_ref()],
        bump = seat.bump,
        has_one = launch @ FairOpenError::NotThisLaunchsSeat,
        has_one = wallet @ FairOpenError::NotYourSeat,
    )]
    pub seat: Account<'info, Seat>,
    #[account(mut)]
    pub wallet: Signer<'info>,
    /// CHECK: an account of the coin the wallet owns; read in the handler.
    #[account(mut)]
    pub coin_account: UncheckedAccount<'info>,
    /// CHECK: the pot's coin account, the launch's own account of its coin; checked in the handler.
    #[account(mut)]
    pub pot_coins: UncheckedAccount<'info>,
    /// CHECK: the coin, the launch's.
    #[account(mut, address = launch.mint @ FairOpenError::NotTheCoin)]
    pub mint: UncheckedAccount<'info>,
    /// CHECK: SPL Token.
    #[account(address = TOKEN_PROGRAM)]
    pub token_program: UncheckedAccount<'info>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct MarkFailed<'info> {
    #[account(mut, seeds = [LAUNCH_SEED, launch.nonce.as_ref()], bump = launch.bump)]
    pub launch: Box<Account<'info, Launch>>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct WithdrawFailed<'info> {
    #[account(mut, seeds = [LAUNCH_SEED, launch.nonce.as_ref()], bump = launch.bump)]
    pub launch: Box<Account<'info, Launch>>,
    #[account(mut, seeds = [VAULT_SEED, launch.key().as_ref()], bump = launch.vault_bump)]
    pub vault: Account<'info, Vault>,
    #[account(
        mut,
        close = wallet,
        seeds = [SEAT_SEED, launch.key().as_ref(), seat.person.as_ref()],
        bump = seat.bump,
        has_one = launch @ FairOpenError::NotThisLaunchsSeat,
        has_one = wallet @ FairOpenError::NotYourSeat,
    )]
    pub seat: Account<'info, Seat>,
    /// The seat's wallet, which everything goes back to.
    #[account(mut)]
    pub wallet: SystemAccount<'info>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct CloseLaunch<'info> {
    #[account(
        mut,
        close = creator,
        seeds = [LAUNCH_SEED, launch.nonce.as_ref()],
        bump = launch.bump,
        has_one = creator @ FairOpenError::NotTheCreator,
    )]
    pub launch: Box<Account<'info, Launch>>,
    #[account(mut, close = creator, seeds = [VAULT_SEED, launch.key().as_ref()], bump = launch.vault_bump)]
    pub vault: Account<'info, Vault>,
    #[account(mut)]
    pub creator: SystemAccount<'info>,
}

#[event]
pub struct ProgramConfigChanged {
    pub admission_signer: Pubkey,
    pub keeper: Pubkey,
    pub fee_program: Pubkey,
    pub dbc_config: Pubkey,
}

impl From<&ProgramConfig> for ProgramConfigChanged {
    fn from(c: &ProgramConfig) -> Self {
        ProgramConfigChanged {
            admission_signer: c.admission_signer,
            keeper: c.keeper,
            fee_program: c.fee_program,
            dbc_config: c.dbc_config,
        }
    }
}

/// A Fair Open scheduled: its terms, as the launch account holds them.
#[event]
pub struct LaunchCreated {
    pub launch: Pubkey,
    pub creator: Pubkey,
    pub dbc_config: Pubkey,
    pub quote_mint: Pubkey,
    pub nonce: Pubkey,
    pub identity_hash: [u8; 32],
    pub deposits_open_at: i64,
    pub opens_at: i64,
    pub min_raise: u64,
    pub pot_cap: u64,
    pub lowest_rung: u64,
    pub step: u64,
}

/// A deposit: `amount` added, `deposit` what the seat now holds; `pot` and `seats` the launch's after it.
#[event]
pub struct Deposited {
    pub launch: Pubkey,
    pub wallet: Pubkey,
    pub person: [u8; 32],
    pub tier: Tier,
    pub cap: u64,
    pub amount: u64,
    pub deposit: u64,
    /// Whether this deposit took the seat, and so prepaid its rent and the coin account's.
    pub new_seat: bool,
    pub pot: u64,
    pub seats: u32,
}

/// A withdrawal during the window: `deposit` what the seat still holds; the seat closed if nothing.
#[event]
pub struct Withdrawn {
    pub launch: Pubkey,
    pub wallet: Pubkey,
    pub person: [u8; 32],
    pub amount: u64,
    pub deposit: u64,
    pub closed: bool,
    pub pot: u64,
    pub seats: u32,
}

#[event]
pub struct LaunchFailed {
    pub launch: Pubkey,
    pub failure: Failure,
    /// What the pot would have spent, and what it held.
    pub spend: u64,
    pub pot: u64,
    pub seats: u32,
}

/// A failed launch's seat returned: its deposit, the coin account's rent and the seat's own rent, to its wallet.
#[event]
pub struct FailedDepositReturned {
    pub launch: Pubkey,
    pub wallet: Pubkey,
    pub person: [u8; 32],
    pub deposit: u64,
    pub coin_rent: u64,
    pub seat_rent: u64,
    /// Seats still holding a deposit.
    pub seats: u32,
}

/// A failed launch closed, its rent and its vault's returned to the creator.
#[event]
pub struct LaunchClosed {
    pub launch: Pubkey,
    pub creator: Pubkey,
    pub rent: u64,
}

/// A Fair Open opened (spec 2.1 step 10): its coin and pool created and the pot's buy their first swap. Amounts are in the
/// quote's raw units, coins in the coin's.
#[event]
pub struct LaunchOpened {
    pub launch: Pubkey,
    pub creator: Pubkey,
    pub mint: Pubkey,
    pub pool: Pubkey,
    /// What the fills added up to, and the rung, what the pot spent.
    pub spend: u64,
    pub spent: u64,
    pub coins: u64,
    pub others_level: u64,
    pub unverified_level: u64,
    /// The pot's own fee, recorded with the fee program for its 50/50 split.
    pub pot_fee: u64,
    /// What the open's accounts cost our keeper, paid back from the creator's prepaid rent.
    pub rent_paid_back: u64,
    pub seats: u32,
}

/// A seat's coins and refund delivered, by a push or its own claim (spec 2.1 step 12).
#[event]
pub struct SeatDelivered {
    pub launch: Pubkey,
    pub wallet: Pubkey,
    pub person: [u8; 32],
    /// Where its coins went.
    pub coin_account: Pubkey,
    pub deposit: u64,
    pub fill: u64,
    pub spent: u64,
    pub coins: u64,
    pub refund: u64,
    /// The coin account's prepaid rent paid back with the refund: none when the push made the account with it.
    pub coin_rent: u64,
    /// Whether a push delivered it, or the depositor's own claim.
    pub pushed: bool,
    /// Seats delivered so far.
    pub delivered: u32,
}

/// Every seat delivered: the coins the rounding left in the pot burnt (spec 12).
#[event]
pub struct CoinDustBurnt {
    pub launch: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
}

#[error_code]
pub enum FairOpenError {
    #[msg("Only the program's upgrade authority can change its settings")]
    NotUpgradeAuthority,
    #[msg("A setting is the default address")]
    MissingSetting,
    #[msg("The keeper did not sign")]
    NotTheKeeper,
    #[msg("A Fair Open runs on Heat's Fair Open config")]
    NotTheFairOpenConfig,
    #[msg("The config is not a DBC config")]
    NotADbcConfig,
    #[msg("A Fair Open takes SOL only, until another quote's deposits are built")]
    QuoteNotSupported,
    #[msg("The minimum raise is more than the pot can spend")]
    MinRaiseAboveCap,
    #[msg("The window would already be over")]
    WindowOver,
    #[msg("A window starts at most 7 days ahead")]
    TooFarAhead,
    #[msg("The coin's identity hash is missing")]
    NoIdentity,
    #[msg("The nonce is not a durable nonce account held by the keeper")]
    NotOurNonce,
    #[msg("The launch is not taking deposits: it failed or opened")]
    NotScheduled,
    #[msg("The deposit window has not started")]
    WindowNotStarted,
    #[msg("The deposit window has closed")]
    WindowClosed,
    #[msg("Deposits and withdrawals move in whole steps of 0.01 SOL")]
    OffStep,
    #[msg("A deposit needs our admission server's signature, verified right before it")]
    NoAdmission,
    #[msg("The admission is not signed by our admission server")]
    NotOurAdmission,
    #[msg("The admission is for another wallet, launch, person, tier, cap or expiry")]
    NotThisAdmission,
    #[msg("The admission has expired")]
    AdmissionExpired,
    #[msg("The admission's cap is above its tier's or off the step")]
    CapOverTier,
    #[msg("This person's seat is held by another wallet")]
    SeatHeldByAnotherWallet,
    #[msg("The deposit would be over the seat's cap")]
    OverCap,
    #[msg("That is more than the seat holds")]
    OverDeposit,
    #[msg("Too many seats ask the same deposit")]
    TooManySeats,
    #[msg("The seat is not counted in the launch")]
    SeatNotCounted,
    #[msg("The seat is another launch's")]
    NotThisLaunchsSeat,
    #[msg("The seat is another wallet's")]
    NotYourSeat,
    #[msg("The vault would hold less than it owes")]
    VaultShort,
    #[msg("The deposit window has not closed")]
    WindowNotClosed,
    #[msg("The pot can still open: it may fail only 15 minutes after the scheduled open")]
    CanStillOpen,
    #[msg("The launch has not failed")]
    NotFailed,
    #[msg("Seats still hold deposits")]
    SeatsLeft,
    #[msg("That is not the launch's creator")]
    NotTheCreator,
    #[msg("The pot opens at its scheduled time")]
    TooEarly,
    #[msg("The open is refused from 15 minutes after the scheduled time")]
    TooLate,
    #[msg("The pot would spend less than the ladder's lowest rung or the minimum raise")]
    CannotOpen,
    #[msg("The rung is not the largest at or below what the pot should spend")]
    WrongRung,
    #[msg("The open runs only in the coin's creation transaction")]
    NotTheCreationTransaction,
    #[msg("The coin's name, ticker or metadata URI is not the one sealed at scheduling")]
    IdentityMismatch,
    #[msg("Settling runs only right after the open, in the creation transaction")]
    NotOpening,
    #[msg("The pot's buy did not spend exactly the rung")]
    BuyNotSpent,
    #[msg("That is not the pot's coin account")]
    NotThePotsCoins,
    #[msg("That is not the coin's DBC pool")]
    NotThePool,
    #[msg("That is not the launch's coin")]
    NotTheCoin,
    #[msg("That is not the fee program the program config names")]
    NotTheFeeProgram,
    #[msg("That is not an SPL Token account")]
    NotATokenAccount,
    #[msg("The launch has not opened")]
    NotOpened,
    #[msg("A push takes each seat as three accounts: the seat, its wallet and the wallet's account of the coin")]
    SeatAccounts,
    #[msg("The seat's coins and refund were delivered already")]
    AlreadyDelivered,
    #[msg("The creator's coins leave the pot only into the Creator lock")]
    CreatorsSeat,
    #[msg("The coins go to an account of the coin the seat's wallet owns")]
    NotYourCoinAccount,
}
