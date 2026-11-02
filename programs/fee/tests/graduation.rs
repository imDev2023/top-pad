//! Graduation's claims (spec 2.3, 4, 5.2) in LiteSVM: the partner's surplus split 50/50 like Creator Earnings, the
//! leftover withdrawn and burnt, and Heat's LP fees paid to the treasury. Our stand-ins for DBC's surplus and leftover
//! (tests/dbc-stand-in) and for DAMM v2's position fee claim (tests/damm-stand-in) do the paying; the devnet tests run
//! the same instructions against DBC and DAMM v2 themselves.
// LiteSVM's failed-transaction metadata is large by design; the helpers here only hand it back to the test.
#![allow(clippy::result_large_err)]
mod common;

use {
    anchor_lang::{solana_program::pubkey::Pubkey, InstructionData, ToAccountMetas},
    common::*,
    fee::{damm_v2, dbc, LeftoverBurnt, LpFeesClaimed, SurplusClaimed, FEE_CLAIMER},
    litesvm::types::{FailedTransactionMetadata, TransactionMetadata},
};

type Sent = Result<TransactionMetadata, FailedTransactionMetadata>;

/// DBC's offsets the tests write: a config's Graduation Target and leftover receiver, a pool's quote reserve and how far
/// its migration has gone (`MigrationProgress::CreatedPool` once migrated).
const CONFIG_MIGRATION_QUOTE_THRESHOLD: usize = 264;
const CONFIG_LEFTOVER_RECEIVER: usize = 72;
const POOL_QUOTE_RESERVE: usize = 240;
const POOL_MIGRATION_PROGRESS: usize = 308;
const CREATED_POOL: u8 = 3;
/// A Graduation Target in the tests' quote of 6 decimals: 8.5 of it.
const TARGET: u64 = 8_500_000;
/// Every coin's supply (spec 3.1).
const SUPPLY: u64 = 1_000_000_000_000_000;

/// DAMM v2's offsets the tests write: a pool's mints and vaults, a position's pool, NFT and pending fees.
const DAMM_POOL_DISCRIMINATOR: [u8; 8] = [241, 154, 109, 4, 17, 177, 109, 188];
const DAMM_POSITION_DISCRIMINATOR: [u8; 8] = [170, 188, 143, 228, 122, 64, 247, 208];
const DAMM_POOL_LEN: usize = 1112;
const DAMM_POSITION_LEN: usize = 408;

/// A graduated pool in DAMM v2 and one position in it, its NFT held by `owner`.
struct Graduated {
    pool: Pubkey,
    position: Pubkey,
    position_nft_account: Pubkey,
    token_a_vault: Pubkey,
    token_b_vault: Pubkey,
}

impl Test {
    /// A Heat coin's pool whose config graduates at `TARGET` and names the fee claimer as leftover receiver, with the
    /// coin's whole supply minted.
    fn graduating_market(&mut self) -> Market {
        let market = self.market();
        let mut config = self.svm.get_account(&market.coin.config).unwrap();
        put(&mut config.data, CONFIG_MIGRATION_QUOTE_THRESHOLD, &TARGET.to_le_bytes());
        put(&mut config.data, CONFIG_LEFTOVER_RECEIVER, FEE_CLAIMER.as_ref());
        self.svm.set_account(market.coin.config, config).unwrap();
        let mut mint = mint_data(6);
        put(&mut mint, 36, &SUPPLY.to_le_bytes());
        self.set_token_account_data(market.coin.mint, mint);
        market
    }

    /// The curve completes holding `surplus` past its target, as the last buy leaves it: the quote vault holds it.
    fn complete(&mut self, market: &Market, surplus: u64) {
        self.edit_pool(&market.coin.pool, |pool| put(pool, POOL_QUOTE_RESERVE, &(TARGET + surplus).to_le_bytes()));
        self.set_balance(&market.quote_vault, self.token_balance(&market.quote_vault) + TARGET + surplus);
    }

    /// The pool migrates, its coin vault left holding `leftover`.
    fn migrate(&mut self, market: &Market, leftover: u64) {
        self.edit_pool(&market.coin.pool, |pool| pool[POOL_MIGRATION_PROGRESS] = CREATED_POOL);
        self.set_balance(&market.base_vault, leftover);
    }

    fn set_balance(&mut self, account: &Pubkey, amount: u64) {
        let mut a = self.svm.get_account(account).unwrap();
        put(&mut a.data, 64, &amount.to_le_bytes());
        self.svm.set_account(*account, a).unwrap();
    }

    fn coin_account(&mut self, market: &Market, owner: &Pubkey, amount: u64) -> Pubkey {
        let address = associated_token_address(owner, &market.coin.mint);
        self.set_token_account_data(address, token_account_data(&market.coin.mint, owner, amount));
        address
    }

    fn supply(&self, mint: &Pubkey) -> u64 {
        let account = self.svm.get_account(mint).unwrap();
        u64::from_le_bytes(account.data[36..44].try_into().unwrap())
    }

    fn claim_surplus(&mut self, market: &Market, creator_account: Pubkey, treasury_account: Pubkey) -> Sent {
        let c = market.coin;
        let fee_claimer_token_account = self.quote_account(market, &FEE_CLAIMER);
        let accounts = fee::accounts::ClaimSurplus {
            fee_config: fee_config_address(),
            creator_token_account: creator_account,
            treasury_token_account: treasury_account,
            fee_claimer: FEE_CLAIMER,
            fee_claimer_token_account,
            pool_authority: dbc::POOL_AUTHORITY,
            config: c.config,
            pool: c.pool,
            quote_vault: market.quote_vault,
            quote_mint: market.quote_mint,
            token_quote_program: TOKEN_PROGRAM,
            dbc_event_authority: dbc::EVENT_AUTHORITY,
            dbc_program: dbc::PROGRAM_ID,
            event_authority: event_authority(),
            program: fee::id(),
        };
        let ix = instruction(accounts.to_account_metas(None), fee::instruction::ClaimSurplus {}.data());
        self.send(&[ix], &[])
    }

    fn surplus_payees(&mut self, market: &Market) -> (Pubkey, Pubkey) {
        let treasury = self.fee_settings.treasury;
        (self.quote_account(market, &market.coin.creator), self.quote_account(market, &treasury))
    }

    fn burn_leftover(&mut self, market: &Market, fee_claimer_coin_account: Pubkey) -> Sent {
        let c = market.coin;
        let accounts = fee::accounts::BurnLeftover {
            fee_claimer: FEE_CLAIMER,
            fee_claimer_coin_account,
            pool_authority: dbc::POOL_AUTHORITY,
            config: c.config,
            pool: c.pool,
            base_vault: market.base_vault,
            mint: c.mint,
            token_base_program: TOKEN_PROGRAM,
            dbc_event_authority: dbc::EVENT_AUTHORITY,
            dbc_program: dbc::PROGRAM_ID,
            event_authority: event_authority(),
            program: fee::id(),
        };
        let ix = instruction(accounts.to_account_metas(None), fee::instruction::BurnLeftover {}.data());
        self.send(&[ix], &[])
    }

    /// The coin's graduated pool in DAMM v2, with a position whose NFT `owner` holds, `fee_b` of the quote accrued to
    /// it and held in the pool's quote vault.
    fn graduated(&mut self, market: &Market, owner: &Pubkey, fee_b: u64) -> Graduated {
        let (pool, position, nft_mint, position_nft_account) =
            (Pubkey::new_unique(), Pubkey::new_unique(), Pubkey::new_unique(), Pubkey::new_unique());
        let (token_a_vault, token_b_vault) = (Pubkey::new_unique(), Pubkey::new_unique());
        self.set_token_account_data(token_a_vault, token_account_data(&market.coin.mint, &damm_v2::POOL_AUTHORITY, 0));
        self.set_token_account_data(
            token_b_vault,
            token_account_data(&market.quote_mint, &damm_v2::POOL_AUTHORITY, fee_b),
        );
        self.set_token_account_data(position_nft_account, token_account_data(&nft_mint, owner, 1));
        let mut data = vec![0u8; DAMM_POOL_LEN];
        put(&mut data, 0, &DAMM_POOL_DISCRIMINATOR);
        put(&mut data, 168, market.coin.mint.as_ref());
        put(&mut data, 200, market.quote_mint.as_ref());
        put(&mut data, 232, token_a_vault.as_ref());
        put(&mut data, 264, token_b_vault.as_ref());
        self.set_program_account(pool, data, damm_v2::PROGRAM_ID);
        let mut data = vec![0u8; DAMM_POSITION_LEN];
        put(&mut data, 0, &DAMM_POSITION_DISCRIMINATOR);
        put(&mut data, 8, pool.as_ref());
        put(&mut data, 40, nft_mint.as_ref());
        put(&mut data, 144, &fee_b.to_le_bytes());
        self.set_program_account(position, data, damm_v2::PROGRAM_ID);
        Graduated { pool, position, position_nft_account, token_a_vault, token_b_vault }
    }

    fn claim_lp_fees(&mut self, market: &Market, g: &Graduated, treasury_account: Pubkey) -> Sent {
        let fee_claimer_coin_account = self.coin_account(market, &FEE_CLAIMER, 0);
        let accounts = fee::accounts::ClaimLpFees {
            fee_config: fee_config_address(),
            treasury_token_account: treasury_account,
            fee_claimer: FEE_CLAIMER,
            fee_claimer_coin_account,
            damm_pool_authority: damm_v2::POOL_AUTHORITY,
            pool: g.pool,
            position: g.position,
            position_nft_account: g.position_nft_account,
            token_a_vault: g.token_a_vault,
            token_b_vault: g.token_b_vault,
            mint: market.coin.mint,
            quote_mint: market.quote_mint,
            token_base_program: TOKEN_PROGRAM,
            token_quote_program: TOKEN_PROGRAM,
            damm_event_authority: damm_v2::EVENT_AUTHORITY,
            damm_program: damm_v2::PROGRAM_ID,
            event_authority: event_authority(),
            program: fee::id(),
        };
        let ix = instruction(accounts.to_account_metas(None), fee::instruction::ClaimLpFees {}.data());
        self.send(&[ix], &[])
    }
}

fn assert_error(result: Sent, code: FeeErrorCode) {
    let err = result.expect_err("the instruction was refused");
    assert_eq!(custom_error(&err), Some(code as u32), "{:?}", err.meta.logs);
}

fn assert_refused_by_meteora(result: Sent, what: &str) {
    let err = result.expect_err("the instruction was refused");
    assert!(err.meta.logs.iter().any(|line| line.contains(what)), "{:?}", err.meta.logs);
}

#[test]
fn the_surplus_splits_half_to_the_creator_role_holder_and_the_rest_to_the_treasury() {
    let mut t = Test::initialized();
    let market = t.graduating_market();
    // DBC keeps a fifth of a surplus and gives the partner the rest: 1,000,001 past the target is 800,000 the
    // partner's, rounded down.
    t.complete(&market, 1_000_001);
    let (creator, treasury) = t.surplus_payees(&market);
    // Whatever the fee claimer's own account held before stays there.
    let fee_claimer_account = t.quote_account(&market, &FEE_CLAIMER);
    let stray = 7;
    t.set_balance(&fee_claimer_account, stray);

    let done = t.claim_surplus(&market, creator, treasury).unwrap();
    assert_eq!(t.token_balance(&creator), 400_000);
    assert_eq!(t.token_balance(&treasury), 400_000);
    assert_eq!(t.token_balance(&fee_claimer_account), stray);
    let claimed = events::<SurplusClaimed>(&done);
    assert_eq!(claimed.len(), 1);
    assert_eq!(
        (claimed[0].creator, claimed[0].creator_amount, claimed[0].treasury_amount),
        (market.coin.creator, 400_000, 400_000)
    );
    assert_eq!(
        (claimed[0].pool, claimed[0].mint, claimed[0].config),
        (market.coin.pool, market.coin.mint, market.coin.config)
    );
}

#[test]
fn an_odd_surplus_gives_the_treasury_the_odd_unit() {
    let mut t = Test::initialized();
    let market = t.graduating_market();
    // 104 past the target is 83 the partner's, rounded down: 41 to the creator and 42 to the treasury.
    t.complete(&market, 104);
    let (creator, treasury) = t.surplus_payees(&market);
    t.claim_surplus(&market, creator, treasury).unwrap();
    assert_eq!((t.token_balance(&creator), t.token_balance(&treasury)), (41, 42));
}

#[test]
fn a_curve_completing_exactly_at_its_target_has_no_surplus_to_split() {
    let mut t = Test::initialized();
    let market = t.graduating_market();
    t.complete(&market, 0);
    let (creator, treasury) = t.surplus_payees(&market);
    let done = t.claim_surplus(&market, creator, treasury).unwrap();
    assert_eq!((t.token_balance(&creator), t.token_balance(&treasury)), (0, 0));
    let claimed = events::<SurplusClaimed>(&done);
    assert_eq!((claimed[0].creator_amount, claimed[0].treasury_amount), (0, 0));
}

#[test]
fn the_surplus_waits_for_the_curve_and_is_split_once() {
    let mut t = Test::initialized();
    let market = t.graduating_market();
    let (creator, treasury) = t.surplus_payees(&market);
    assert_refused_by_meteora(t.claim_surplus(&market, creator, treasury), "the curve is not complete");
    t.complete(&market, 500);
    t.at(1);
    t.claim_surplus(&market, creator, treasury).unwrap();
    t.at(2);
    assert_refused_by_meteora(t.claim_surplus(&market, creator, treasury), "the surplus has been withdrawn");
    assert_eq!(t.token_balance(&creator) + t.token_balance(&treasury), 400);
}

#[test]
fn the_surplus_follows_the_creator_role() {
    let mut t = Test::initialized();
    let mut market = t.graduating_market();
    t.complete(&market, 1_000);
    let (old_creator, treasury) = t.surplus_payees(&market);
    t.transfer_pool_creator(&mut market, Pubkey::new_unique());
    assert_error(t.claim_surplus(&market, old_creator, treasury), FeeErrorCode::NotTheCreatorsAccount);
    let (creator, _) = t.surplus_payees(&market);
    t.claim_surplus(&market, creator, treasury).unwrap();
    assert_eq!(t.token_balance(&creator), 400);
    assert_eq!(t.token_balance(&old_creator), 0);
}

#[test]
fn the_surplus_goes_only_to_its_owners_accounts() {
    let mut t = Test::initialized();
    let market = t.graduating_market();
    t.complete(&market, 1_000);
    let (creator, treasury) = t.surplus_payees(&market);
    let someone = t.quote_account(&market, &Pubkey::new_unique());
    assert_error(t.claim_surplus(&market, creator, someone), FeeErrorCode::NotTheTreasurysAccount);
    assert_error(t.claim_surplus(&market, someone, treasury), FeeErrorCode::NotTheCreatorsAccount);
}

#[test]
fn the_leftover_is_withdrawn_and_burnt_once_the_pool_migrates() {
    let mut t = Test::initialized();
    let market = t.graduating_market();
    t.complete(&market, 0);
    let account = t.coin_account(&market, &FEE_CLAIMER, 0);
    assert_refused_by_meteora(t.burn_leftover(&market, account), "the pool has not migrated");

    t.migrate(&market, 12_345);
    t.at(1);
    let done = t.burn_leftover(&market, account).unwrap();
    assert_eq!(t.token_balance(&account), 0);
    assert_eq!(t.token_balance(&market.base_vault), 0);
    assert_eq!(t.supply(&market.coin.mint), SUPPLY - 12_345);
    let burnt = events::<LeftoverBurnt>(&done);
    assert_eq!((burnt[0].withdrawn, burnt[0].burnt), (12_345, 12_345));
    assert_eq!(
        (burnt[0].pool, burnt[0].mint, burnt[0].config),
        (market.coin.pool, market.coin.mint, market.coin.config)
    );

    t.at(2);
    assert_refused_by_meteora(t.burn_leftover(&market, account), "the leftover has been withdrawn");
}

#[test]
fn a_pool_with_nothing_left_over_still_burns_nothing_cleanly() {
    let mut t = Test::initialized();
    let market = t.graduating_market();
    t.migrate(&market, 0);
    let account = t.coin_account(&market, &FEE_CLAIMER, 0);
    let done = t.burn_leftover(&market, account).unwrap();
    let burnt = events::<LeftoverBurnt>(&done);
    assert_eq!((burnt[0].withdrawn, burnt[0].burnt), (0, 0));
    assert_eq!(t.supply(&market.coin.mint), SUPPLY);
}

#[test]
fn the_fee_program_never_keeps_a_coin() {
    let mut t = Test::initialized();
    let market = t.graduating_market();
    t.migrate(&market, 10);
    // Coins someone sent the fee claimer burn with the leftover.
    let account = t.coin_account(&market, &FEE_CLAIMER, 5);
    let done = t.burn_leftover(&market, account).unwrap();
    assert_eq!(t.token_balance(&account), 0);
    let burnt = events::<LeftoverBurnt>(&done);
    assert_eq!((burnt[0].withdrawn, burnt[0].burnt), (10, 15));
}

#[test]
fn the_leftover_goes_only_to_the_fee_claimers_account() {
    let mut t = Test::initialized();
    let market = t.graduating_market();
    t.migrate(&market, 10);
    let someone = t.coin_account(&market, &Pubkey::new_unique(), 0);
    assert_error(t.burn_leftover(&market, someone), FeeErrorCode::NotTheFeeClaimersAccount);
}

#[test]
fn heats_lp_fees_go_to_the_treasury() {
    let mut t = Test::initialized();
    let market = t.graduating_market();
    let graduated = t.graduated(&market, &FEE_CLAIMER, 123_456);
    let treasury = t.fee_settings.treasury;
    let treasury_account = t.quote_account(&market, &treasury);

    let done = t.claim_lp_fees(&market, &graduated, treasury_account).unwrap();
    assert_eq!(t.token_balance(&treasury_account), 123_456);
    assert_eq!(t.token_balance(&associated_token_address(&FEE_CLAIMER, &market.coin.mint)), 0);
    let claimed = events::<LpFeesClaimed>(&done);
    assert_eq!(
        (claimed[0].pool, claimed[0].position, claimed[0].mint, claimed[0].amount),
        (graduated.pool, graduated.position, market.coin.mint, 123_456)
    );

    // Claimed again with nothing new accrued, it pays nothing.
    t.at(1);
    let done = t.claim_lp_fees(&market, &graduated, treasury_account).unwrap();
    assert_eq!(events::<LpFeesClaimed>(&done)[0].amount, 0);
    assert_eq!(t.token_balance(&treasury_account), 123_456);
}

#[test]
fn heats_lp_fees_go_only_to_the_treasury() {
    let mut t = Test::initialized();
    let market = t.graduating_market();
    let graduated = t.graduated(&market, &FEE_CLAIMER, 1_000);
    let someone = t.quote_account(&market, &Pubkey::new_unique());
    assert_error(t.claim_lp_fees(&market, &graduated, someone), FeeErrorCode::NotTheTreasurysAccount);
}

#[test]
fn the_fee_program_claims_only_positions_it_owns() {
    let mut t = Test::initialized();
    let market = t.graduating_market();
    // The creator's own position: only the creator can claim it, from Meteora directly.
    let creators = t.graduated(&market, &market.coin.creator, 1_000);
    let treasury = t.fee_settings.treasury;
    let treasury_account = t.quote_account(&market, &treasury);
    assert_refused_by_meteora(t.claim_lp_fees(&market, &creators, treasury_account), "the NFT's owner signs");
    assert_eq!(t.token_balance(&treasury_account), 0);
}
