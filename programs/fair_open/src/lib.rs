//! The Fair Open program (spec 5.3): holds a Fair Open's deposits as plain SOL through its 10-minute window, one seat per
//! person admitted by our admission server, and lets a launch that cannot open fail on chain, after which every
//! depositor takes back their deposit and both rents with no Heat server running (spec 2.1 steps 7, 9, 11 and 15). The
//! open, the pushes, the Creator lock and the Tax Share come with later slices (spec 14); the launch and seat accounts
//! keep room for what they will record, so a seat made now still reads after those upgrades.
use {
    anchor_lang::{prelude::*, solana_program::bpf_loader_upgradeable, system_program},
    solana_instructions_sysvar::{load_current_index_checked, load_instruction_at_checked},
};

pub mod admission;
pub mod allocation;

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
            reserved: [0; 128],
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
                reserved: [0; 48],
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
    /// Room for what the open, the pushes and the Tax Share will record.
    pub reserved: [u8; 128],
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

    /// What the vault owes: every deposit, and the coin-account rent the seats prepaid.
    pub fn owed(&self) -> u64 {
        self.pot() + self.coin_rent
    }

    /// How the pot would buy if its window closed now.
    pub fn allocation(&self) -> allocation::Allocation {
        allocation::allocate(&self.counts, &self.unverified_counts, self.step, self.pot_cap)
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, Debug, PartialEq, Eq)]
pub enum LaunchStatus {
    /// From scheduling to the open: deposits are taken inside the window.
    Scheduled,
    /// No coin was or will be created; every deposit comes back.
    Failed,
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
    /// Room for the fill, coins, refund and Tax Share the open and the pushes will record.
    pub reserved: [u8; 48],
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
}
