//! The fee claims (spec 4, 5.2) in LiteSVM: the window claim and the 50/50 split of Creator Earnings, each paid by DBC
//! straight out of a pool's quote vault. Our stand-in for DBC's partner fee claim does the paying (tests/dbc-stand-in);
//! the devnet tests run the same claims against the real DBC.
// LiteSVM's failed-transaction metadata is large by design; the helpers here only hand it back to the test.
#![allow(clippy::result_large_err)]
mod common;

use {
    anchor_lang::{solana_program::pubkey::Pubkey, AccountSerialize, InstructionData, Space, ToAccountMetas},
    common::*,
    fee::{dbc, CoinRecord, FeesClaimed, LaunchMode, WindowClaim, WindowFeesClaimed, FEE_CLAIMER, TAX_WINDOW_SECONDS},
    litesvm::types::{FailedTransactionMetadata, TransactionMetadata},
    solana_keypair::Keypair,
    solana_signer::Signer,
};

type Sent = Result<TransactionMetadata, FailedTransactionMetadata>;

/// Who receives what, for one claim: each owner's associated quote account.
struct Payees {
    creator: Pubkey,
    treasury: Pubkey,
    fee_claimer: Pubkey,
}

impl Test {
    fn payees(&mut self, market: &Market) -> Payees {
        let treasury = self.fee_settings.treasury;
        Payees {
            creator: self.quote_account(market, &market.coin.creator),
            treasury: self.quote_account(market, &treasury),
            fee_claimer: self.quote_account(market, &FEE_CLAIMER),
        }
    }

    /// A Heat coin: a market whose coin the launch key registered, as an Instant launch.
    fn heat_coin(&mut self) -> Market {
        let market = self.market();
        let launch_key = self.launch_key.insecure_clone();
        self.register(&market.coin, &launch_key).unwrap();
        market
    }

    fn claim_window(&mut self, market: &Market, payees: &Payees) -> Sent {
        let c = market.coin;
        let accounts = fee::accounts::ClaimWindowFees {
            fee_config: fee_config_address(),
            coin_record: coin_record_address(&c.mint),
            treasury_token_account: payees.treasury,
            fee_claimer: FEE_CLAIMER,
            fee_claimer_token_account: payees.fee_claimer,
            pool_authority: dbc::POOL_AUTHORITY,
            config: c.config,
            pool: c.pool,
            base_vault: market.base_vault,
            quote_vault: market.quote_vault,
            mint: c.mint,
            quote_mint: market.quote_mint,
            token_base_program: TOKEN_PROGRAM,
            token_quote_program: TOKEN_PROGRAM,
            dbc_event_authority: dbc::EVENT_AUTHORITY,
            dbc_program: dbc::PROGRAM_ID,
            event_authority: event_authority(),
            program: fee::id(),
        };
        let ix = instruction(accounts.to_account_metas(None), fee::instruction::ClaimWindowFees {}.data());
        self.send(&[ix], &[])
    }

    fn claim_unlisted_window(&mut self, market: &Market, payees: &Payees) -> Sent {
        let c = market.coin;
        let accounts = fee::accounts::ClaimUnlistedWindowFees {
            fee_config: fee_config_address(),
            coin_record: coin_record_address(&c.mint),
            window_claim: window_claim_address(&c.pool),
            payer: self.payer.pubkey(),
            treasury_token_account: payees.treasury,
            fee_claimer: FEE_CLAIMER,
            fee_claimer_token_account: payees.fee_claimer,
            pool_authority: dbc::POOL_AUTHORITY,
            config: c.config,
            pool: c.pool,
            base_vault: market.base_vault,
            quote_vault: market.quote_vault,
            mint: c.mint,
            quote_mint: market.quote_mint,
            token_base_program: TOKEN_PROGRAM,
            token_quote_program: TOKEN_PROGRAM,
            dbc_event_authority: dbc::EVENT_AUTHORITY,
            dbc_program: dbc::PROGRAM_ID,
            system_program: anchor_lang::solana_program::system_program::ID,
            event_authority: event_authority(),
            program: fee::id(),
        };
        let ix = instruction(accounts.to_account_metas(None), fee::instruction::ClaimUnlistedWindowFees {}.data());
        self.send(&[ix], &[])
    }

    /// `claim_fees`, with `window` the account that remembers the pool's window claim.
    fn claim_fees(&mut self, market: &Market, payees: &Payees, window: Pubkey, max_amount: u64) -> Sent {
        let c = market.coin;
        let accounts = fee::accounts::ClaimFees {
            fee_config: fee_config_address(),
            window,
            creator_token_account: payees.creator,
            treasury_token_account: payees.treasury,
            fee_claimer: FEE_CLAIMER,
            fee_claimer_token_account: payees.fee_claimer,
            pool_authority: dbc::POOL_AUTHORITY,
            config: c.config,
            pool: c.pool,
            base_vault: market.base_vault,
            quote_vault: market.quote_vault,
            mint: c.mint,
            quote_mint: market.quote_mint,
            token_base_program: TOKEN_PROGRAM,
            token_quote_program: TOKEN_PROGRAM,
            dbc_event_authority: dbc::EVENT_AUTHORITY,
            dbc_program: dbc::PROGRAM_ID,
            event_authority: event_authority(),
            program: fee::id(),
        };
        let ix = instruction(accounts.to_account_metas(None), fee::instruction::ClaimFees { max_amount }.data());
        self.send(&[ix], &[])
    }

    /// The same, for a Heat coin, whose record remembers its window claim.
    fn claim_coin_fees(&mut self, market: &Market, payees: &Payees, max_amount: u64) -> Sent {
        self.claim_fees(market, payees, coin_record_address(&market.coin.mint), max_amount)
    }

    fn balances(&self, payees: &Payees) -> (u64, u64) {
        (self.token_balance(&payees.creator), self.token_balance(&payees.treasury))
    }
}

fn assert_error(result: Sent, code: FeeErrorCode) {
    let err = result.expect_err("the claim was refused");
    assert_eq!(custom_error(&err), Some(code as u32), "{:?}", err.meta.logs);
}

/// Anchor's own error codes, for the account checks it makes before the program runs.
const ACCOUNT_NOT_INITIALIZED: u32 = 3012;
const ACCOUNT_NOT_SYSTEM_OWNED: u32 = 3011;

#[test]
fn the_window_claim_pays_the_tax_window_to_the_treasury_once_the_window_ends() {
    let mut t = Test::initialized();
    let market = t.heat_coin();
    let payees = t.payees(&market);
    // The sniper tax a creation-slot buy and a 30 s buy paid, the partner's 80% of each.
    t.accrue(&market, 7_920_000);
    t.at(30);
    t.accrue(&market, 4_009_600);

    t.at(TAX_WINDOW_SECONDS - 1);
    assert_error(t.claim_window(&market, &payees), FeeErrorCode::TaxWindowOpen);

    t.at(TAX_WINDOW_SECONDS);
    let done = t.claim_window(&market, &payees).unwrap();
    assert_eq!(t.token_balance(&payees.treasury), 11_929_600);
    assert_eq!((t.partner_quote_fee(&market), t.token_balance(&market.quote_vault)), (0, 0));
    assert_eq!(t.token_balance(&payees.fee_claimer), 0, "no fee rests with the fee program");
    assert!(t.read::<CoinRecord>(&coin_record_address(&market.coin.mint)).window_claimed);

    let event = events::<WindowFeesClaimed>(&done).pop().expect("WindowFeesClaimed is emitted");
    assert_eq!((event.pool, event.mint, event.config), (market.coin.pool, market.coin.mint, market.coin.config));
    assert!(event.heat);
    assert_eq!((event.destination, event.amount), (payees.treasury, 11_929_600));
    assert_eq!((event.window_ended_at, event.claimed_at), (ACTIVATION + 60, ACTIVATION + 60));
    println!("claim_window_fees: {} compute units", done.compute_units_consumed);
}

#[test]
fn a_late_window_claim_moves_the_normal_fees_of_the_seconds_it_was_late_and_no_more() {
    let mut t = Test::initialized();
    let market = t.heat_coin();
    let payees = t.payees(&market);
    t.accrue(&market, 1_000_000);
    // Three seconds of normal fees (1.25%, the partner's 80%) land before the claim does.
    t.at(TAX_WINDOW_SECONDS + 3);
    t.accrue(&market, 10_000);
    let done = t.claim_window(&market, &payees).unwrap();
    let event = events::<WindowFeesClaimed>(&done).pop().unwrap();
    assert_eq!(event.claimed_at - event.window_ended_at, 3);
    assert_eq!(t.token_balance(&payees.treasury), 1_010_000);

    // Fees after the claim are the creator's half and the treasury's half, never the window's.
    t.accrue(&market, 20_000);
    t.claim_coin_fees(&market, &payees, u64::MAX).unwrap();
    assert_eq!(t.balances(&payees), (10_000, 1_020_000));
}

#[test]
fn the_window_claim_runs_once() {
    let mut t = Test::initialized();
    let market = t.heat_coin();
    let payees = t.payees(&market);
    t.accrue(&market, 1_000);
    t.at(TAX_WINDOW_SECONDS);
    t.claim_window(&market, &payees).unwrap();
    t.at(TAX_WINDOW_SECONDS + 1);
    t.accrue(&market, 500);
    assert_error(t.claim_window(&market, &payees), FeeErrorCode::WindowAlreadyClaimed);
    assert_eq!(t.token_balance(&payees.treasury), 1_000);
    assert_eq!(t.partner_quote_fee(&market), 500);
}

#[test]
fn a_window_with_no_trades_still_has_its_claim() {
    let mut t = Test::initialized();
    let market = t.heat_coin();
    let payees = t.payees(&market);
    t.at(TAX_WINDOW_SECONDS);
    let done = t.claim_window(&market, &payees).unwrap();
    assert_eq!(events::<WindowFeesClaimed>(&done).pop().unwrap().amount, 0);
    assert!(t.read::<CoinRecord>(&coin_record_address(&market.coin.mint)).window_claimed);
    t.accrue(&market, 2_000);
    t.claim_coin_fees(&market, &payees, u64::MAX).unwrap();
    assert_eq!(t.balances(&payees), (1_000, 1_000));
}

#[test]
fn creator_earnings_wait_for_the_window_claim() {
    // Until the window claim has run, whatever the pool holds may be the sniper tax, which never reaches the creator.
    let mut t = Test::initialized();
    let market = t.heat_coin();
    let payees = t.payees(&market);
    t.accrue(&market, 1_000_000);
    t.at(TAX_WINDOW_SECONDS + 600);
    assert_error(t.claim_coin_fees(&market, &payees, u64::MAX), FeeErrorCode::WindowNotClaimed);
    assert_eq!(t.balances(&payees), (0, 0));
}

#[test]
fn claim_fees_pays_half_to_the_creator_role_holder_and_the_rest_to_the_treasury() {
    let mut t = Test::initialized();
    let market = t.heat_coin();
    let payees = t.payees(&market);
    t.at(TAX_WINDOW_SECONDS);
    t.claim_window(&market, &payees).unwrap();
    // An odd claim: the creator's half rounds down, as DBC rounds a creator's share, and the treasury takes the rest.
    t.accrue(&market, 1_001);
    let done = t.claim_coin_fees(&market, &payees, u64::MAX).unwrap();
    assert_eq!(t.balances(&payees), (500, 501));
    assert_eq!(t.partner_quote_fee(&market), 0);
    assert_eq!(t.token_balance(&payees.fee_claimer), 0, "no fee rests with the fee program");

    let event = events::<FeesClaimed>(&done).pop().expect("FeesClaimed is emitted");
    assert_eq!((event.pool, event.mint, event.config), (market.coin.pool, market.coin.mint, market.coin.config));
    assert_eq!((event.creator, event.creator_amount, event.treasury_amount), (market.coin.creator, 500, 501));
    println!("claim_fees: {} compute units", done.compute_units_consumed);
}

#[test]
fn a_claim_sent_twice_pays_nothing_twice() {
    let mut t = Test::initialized();
    let market = t.heat_coin();
    let payees = t.payees(&market);
    t.at(TAX_WINDOW_SECONDS);
    t.claim_window(&market, &payees).unwrap();
    t.accrue(&market, 10_000);
    t.claim_coin_fees(&market, &payees, u64::MAX).unwrap();
    t.at(TAX_WINDOW_SECONDS + 1);
    let again = t.claim_coin_fees(&market, &payees, u64::MAX).unwrap();
    assert_eq!(t.balances(&payees), (5_000, 5_000));
    assert!(events::<FeesClaimed>(&again).is_empty(), "nothing to claim, nothing claimed");
}

#[test]
fn a_creator_page_claim_pays_exactly_what_it_showed_while_fees_keep_accruing() {
    let mut t = Test::initialized();
    let market = t.heat_coin();
    let payees = t.payees(&market);
    t.at(TAX_WINDOW_SECONDS);
    t.claim_window(&market, &payees).unwrap();
    t.accrue(&market, 4_000);
    // The page shows 2,000 waiting for the creator, of 4,000; more trades land before the creator's claim does.
    let shown = t.partner_quote_fee(&market);
    t.accrue(&market, 600);
    t.claim_coin_fees(&market, &payees, shown).unwrap();
    assert_eq!(t.balances(&payees), (2_000, 2_000));
    assert_eq!(t.partner_quote_fee(&market), 600, "what accrued since waits for the next claim");
}

#[test]
fn earnings_follow_the_creator_role() {
    let mut t = Test::initialized();
    let mut market = t.heat_coin();
    let launcher = t.payees(&market);
    t.at(TAX_WINDOW_SECONDS);
    t.claim_window(&market, &launcher).unwrap();
    t.accrue(&market, 3_000);

    t.transfer_pool_creator(&mut market, Pubkey::new_unique());
    assert_error(t.claim_coin_fees(&market, &launcher, u64::MAX), FeeErrorCode::NotTheCreatorsAccount);
    let holder = t.payees(&market);
    t.claim_coin_fees(&market, &holder, u64::MAX).unwrap();
    assert_eq!(t.token_balance(&holder.creator), 1_500);
    assert_eq!(t.token_balance(&launcher.creator), 0);
}

#[test]
fn every_share_goes_only_to_its_owners_account() {
    let mut t = Test::initialized();
    let market = t.heat_coin();
    let payees = t.payees(&market);
    let stranger = t.quote_account(&market, &Pubkey::new_unique());
    t.accrue(&market, 1_000);
    t.at(TAX_WINDOW_SECONDS);

    let misdirected = Payees { treasury: stranger, ..t.payees(&market) };
    assert_error(t.claim_window(&market, &misdirected), FeeErrorCode::NotTheTreasurysAccount);
    let misdirected = Payees { fee_claimer: stranger, ..t.payees(&market) };
    assert_error(t.claim_window(&market, &misdirected), FeeErrorCode::NotTheFeeClaimersAccount);
    t.claim_window(&market, &payees).unwrap();

    t.accrue(&market, 1_000);
    let misdirected = Payees { treasury: stranger, ..t.payees(&market) };
    assert_error(t.claim_coin_fees(&market, &misdirected, u64::MAX), FeeErrorCode::NotTheTreasurysAccount);
    let misdirected = Payees { fee_claimer: payees.creator, ..t.payees(&market) };
    assert_error(t.claim_coin_fees(&market, &misdirected, u64::MAX), FeeErrorCode::NotTheFeeClaimersAccount);
    assert_eq!(t.token_balance(&stranger), 0);
}

#[test]
fn a_tax_window_ends_only_by_the_clock() {
    // A pool's own activation point sets its window: one opened later is still inside its window.
    let mut t = Test::initialized();
    let market = t.heat_coin();
    let payees = t.payees(&market);
    t.at(TAX_WINDOW_SECONDS + 5);
    let mut pool = t.svm.get_account(&market.coin.pool).unwrap();
    pool.data[dbc::POOL_ACTIVATION_POINT_OFFSET..dbc::POOL_ACTIVATION_POINT_OFFSET + 8]
        .copy_from_slice(&(ACTIVATION as u64 + 10).to_le_bytes());
    t.svm.set_account(market.coin.pool, pool).unwrap();
    assert_error(t.claim_window(&market, &payees), FeeErrorCode::TaxWindowOpen);
}

impl Test {
    /// A Fair Open's coin: a Heat coin whose record names `launch` and the pot's own fee, as the Fair Open program's open
    /// registers it.
    fn fair_open_coin(&mut self, launch: Pubkey, pot_fee: u64) -> Market {
        let market = self.heat_coin();
        let address = coin_record_address(&market.coin.mint);
        let mut record = self.read::<CoinRecord>(&address);
        record.launch_mode = LaunchMode::FairOpen;
        record.fair_open_launch = Some(launch);
        record.pot_fee = pot_fee;
        let mut account = self.svm.get_account(&address).unwrap();
        let mut data = Vec::with_capacity(8 + CoinRecord::INIT_SPACE);
        record.try_serialize(&mut data).unwrap();
        account.data[..data.len()].copy_from_slice(&data);
        self.svm.set_account(address, account).unwrap();
        market
    }

    /// `claim_fair_open_window_fees`, signed by `registrar`, paying into `tax_share_account`.
    fn claim_fair_open_window(&mut self, market: &Market, registrar: &Keypair, tax_share_account: Pubkey) -> Sent {
        let c = market.coin;
        let fee_claimer = self.quote_account(market, &FEE_CLAIMER);
        let accounts = fee::accounts::ClaimFairOpenWindowFees {
            fee_config: fee_config_address(),
            registrar: registrar.pubkey(),
            coin_record: coin_record_address(&c.mint),
            tax_share_account,
            fee_claimer: FEE_CLAIMER,
            fee_claimer_token_account: fee_claimer,
            pool_authority: dbc::POOL_AUTHORITY,
            config: c.config,
            pool: c.pool,
            base_vault: market.base_vault,
            quote_vault: market.quote_vault,
            mint: c.mint,
            quote_mint: market.quote_mint,
            token_base_program: TOKEN_PROGRAM,
            token_quote_program: TOKEN_PROGRAM,
            dbc_event_authority: dbc::EVENT_AUTHORITY,
            dbc_program: dbc::PROGRAM_ID,
            event_authority: event_authority(),
            program: fee::id(),
        };
        let ix = instruction(accounts.to_account_metas(None), fee::instruction::ClaimFairOpenWindowFees {}.data());
        self.send(&[ix], &[registrar])
    }
}

#[test]
fn a_fair_open_coins_window_fees_never_reach_the_treasury() {
    // A Fair Open's window fees are its depositors' Tax Share (spec 4): the Instant launch's window claim refuses its coin,
    // so they never reach the treasury instead. The Fair Open program's tests run its own window claim, signed by its
    // coin registrar, end to end.
    let mut t = Test::initialized();
    let market = t.fair_open_coin(Pubkey::new_unique(), 100);
    let payees = t.payees(&market);
    t.accrue(&market, 1_000);
    t.at(TAX_WINDOW_SECONDS);
    assert_error(t.claim_window(&market, &payees), FeeErrorCode::FairOpenTaxShare);
    assert_eq!(t.partner_quote_fee(&market), 1_000);
}

#[test]
fn only_the_fair_open_program_collects_a_fair_opens_window_fees() {
    let mut t = Test::initialized();
    let launch = Pubkey::new_unique();
    let market = t.fair_open_coin(launch, 100);
    t.accrue(&market, 1_000);
    t.at(TAX_WINDOW_SECONDS);
    let fair_open_program = t.settings().fair_open_program;
    let pot = Pubkey::find_program_address(&[fee::POT_SEED, launch.as_ref()], &fair_open_program).0;
    // A plain key cannot stand in for the coin registrar, a PDA only the Fair Open program signs for.
    let impostor = Keypair::new();
    assert_error(t.claim_fair_open_window(&market, &impostor, pot), FeeErrorCode::NotTheFairOpenProgram);
    assert_eq!(t.partner_quote_fee(&market), 1_000);
}

#[test]
fn a_pool_made_around_heat_pays_its_window_to_the_treasury_and_then_splits_like_any_other() {
    let mut t = Test::initialized();
    let market = t.market();
    let payees = t.payees(&market);
    t.accrue(&market, 9_000);
    t.at(TAX_WINDOW_SECONDS);
    let err = t.claim_window(&market, &payees).unwrap_err();
    assert_eq!(custom_error(&err), Some(ACCOUNT_NOT_INITIALIZED), "a pool no record lists has no coin window claim");

    let payer_before = t.svm.get_balance(&t.payer.pubkey()).unwrap();
    let done = t.claim_unlisted_window(&market, &payees).unwrap();
    assert_eq!(t.token_balance(&payees.treasury), 9_000);
    let event = events::<WindowFeesClaimed>(&done).pop().unwrap();
    assert!(!event.heat);
    assert_eq!(event.amount, 9_000);
    let claim = t.read::<WindowClaim>(&window_claim_address(&market.coin.pool));
    assert_eq!(claim.pool, market.coin.pool);
    // Whoever sends it pays its rent.
    let rent = t.svm.get_account(&window_claim_address(&market.coin.pool)).unwrap().lamports;
    assert_eq!(payer_before - t.svm.get_balance(&t.payer.pubkey()).unwrap(), rent + done.fee);
    println!(
        "claim_unlisted_window_fees: {} compute units, {} bytes of rent-paid data",
        done.compute_units_consumed,
        8 + WindowClaim::INIT_SPACE
    );

    t.at(TAX_WINDOW_SECONDS + 1);
    assert!(t.claim_unlisted_window(&market, &payees).is_err(), "its window claim runs once");
    assert_error(
        t.claim_fees(&market, &payees, coin_record_address(&market.coin.mint), u64::MAX),
        FeeErrorCode::WindowNotClaimed,
    );
    t.accrue(&market, 4_000);
    t.claim_fees(&market, &payees, window_claim_address(&market.coin.pool), u64::MAX).unwrap();
    assert_eq!(t.balances(&payees), (2_000, 11_000));
}

#[test]
fn a_heat_coin_never_takes_the_unlisted_window_claim() {
    // Its record decides where its window's fees go, so the claim for pools no record lists is refused for it.
    let mut t = Test::initialized();
    let market = t.heat_coin();
    let payees = t.payees(&market);
    t.at(TAX_WINDOW_SECONDS);
    let err = t.claim_unlisted_window(&market, &payees).unwrap_err();
    assert_eq!(custom_error(&err), Some(ACCOUNT_NOT_SYSTEM_OWNED), "{:?}", err.meta.logs);
}

#[test]
fn another_pools_window_claim_proves_nothing() {
    let mut t = Test::initialized();
    let claimed = t.heat_coin();
    let claimed_payees = t.payees(&claimed);
    let market = t.heat_coin();
    let payees = t.payees(&market);
    t.at(TAX_WINDOW_SECONDS);
    t.claim_window(&claimed, &claimed_payees).unwrap();
    t.accrue(&market, 1_000);
    let other = coin_record_address(&claimed.coin.mint);
    assert_error(t.claim_fees(&market, &payees, other, u64::MAX), FeeErrorCode::PoolMismatch);
}

#[test]
fn a_creator_role_held_by_the_fee_claimer_is_refused() {
    let mut t = Test::initialized();
    let mut market = t.heat_coin();
    let payees = t.payees(&market);
    t.at(TAX_WINDOW_SECONDS);
    t.claim_window(&market, &payees).unwrap();
    t.accrue(&market, 1_000);
    t.transfer_pool_creator(&mut market, FEE_CLAIMER);
    let payees = t.payees(&market);
    assert_error(t.claim_coin_fees(&market, &payees, u64::MAX), FeeErrorCode::CreatorRoleHeldByFeeClaimer);
}

#[test]
fn a_single_raw_unit_goes_to_the_treasury() {
    let mut t = Test::initialized();
    let market = t.heat_coin();
    let payees = t.payees(&market);
    t.at(TAX_WINDOW_SECONDS);
    t.claim_window(&market, &payees).unwrap();
    t.accrue(&market, 1);
    let done = t.claim_coin_fees(&market, &payees, u64::MAX).unwrap();
    assert_eq!(t.balances(&payees), (0, 1));
    let event = events::<FeesClaimed>(&done).pop().unwrap();
    assert_eq!((event.creator_amount, event.treasury_amount), (0, 1));
}

#[test]
fn only_the_fee_programs_own_claimer_can_sign_dbcs_claim() {
    // The stand-in refuses a claim the config's fee claimer did not sign, as DBC does; the fee program signs it only for
    // configs naming its PDA, so a config naming anyone else pays nothing through it.
    let mut t = Test::initialized();
    let market = t.heat_coin();
    let payees = t.payees(&market);
    let mut config = t.svm.get_account(&market.coin.config).unwrap();
    config.data[dbc::CONFIG_FEE_CLAIMER_OFFSET..dbc::CONFIG_FEE_CLAIMER_OFFSET + 32]
        .copy_from_slice(Keypair::new().pubkey().as_ref());
    t.svm.set_account(market.coin.config, config).unwrap();
    t.accrue(&market, 1_000);
    t.at(TAX_WINDOW_SECONDS);
    let err = t.claim_window(&market, &payees).unwrap_err();
    assert!(err.meta.logs.iter().any(|l| l.contains("not the fee claimer")), "{:?}", err.meta.logs);
    assert_eq!(t.partner_quote_fee(&market), 1_000);
}
