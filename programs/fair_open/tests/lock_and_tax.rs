//! After the open, in LiteSVM with the fee program and our stand-ins for DBC and Jupiter Lock (spec 2.1 steps 13 and 14):
//! the creator's coins leave the pot only into a Jupiter Lock escrow nobody can cancel, released from day 7 to day 30;
//! once the Tax window ends its fees, less the pot's own fee, and the open's lamport dust become the launch's Tax Share,
//! paid to every seat but the creator's in proportion to what it spent, each seat closing; and the launch closes, its
//! rent back to the creator. The devnet tests run the same against Meteora's DBC and Jupiter Lock themselves.
#![allow(clippy::result_large_err)]
mod common;

use {
    anchor_lang::{prelude::Pubkey, AccountSerialize},
    common::*,
    fair_open::{
        allocation, jupiter_lock, CoinDustBurnt, CreatorLocked, Launch, LaunchClosed, Seat, TaxShareCollected,
        TaxSharePaid, Tier, CREATOR_LOCK_CLIFF_SECONDS, CREATOR_LOCK_END_SECONDS,
    },
    lock_stand_in::escrow as layout,
    solana_signer::Signer,
};

const DAY: i64 = 24 * 3600;

/// The devnet test's oversubscribed pot, 3 Verified seats asking 0.6 SOL and 6 Unverified asking 0.1 SOL, and the
/// creator's own seat, Scored, asking 0.3 SOL.
fn with_creator(t: &mut Test, launch: &LaunchKeys) -> (Vec<Depositor>, Depositor) {
    let mut people = vec![];
    for (tier, steps, n) in [(Tier::Verified, 60, 3), (Tier::Unverified, 10, 6)] {
        for _ in 0..n {
            let d = t.depositor(tier);
            t.deposit(launch, &d, steps * STEP).unwrap();
            people.push(d);
        }
    }
    let creator = Depositor { wallet: t.creator.insecure_clone(), person: [42; 32], tier: Tier::Scored };
    t.deposit(launch, &creator, 30 * STEP).unwrap();
    (people, creator)
}

/// A launch opened on the rung its pot covers, every seat but the creator's pushed.
fn opened_and_pushed(t: &mut Test) -> (LaunchKeys, Vec<Depositor>, Depositor, CoinKeys) {
    let launch = t.launch();
    let (people, creator) = with_creator(t, &launch);
    t.at(600);
    let l: Launch = t.read(&launch.launch);
    let rung = allocation::rung_at_or_below(l.pot_cap, l.allocation().spend).unwrap();
    let (_, coin) = t.open(&launch, rung).unwrap();
    for batch in people.chunks(5) {
        let seats: Vec<&Depositor> = batch.iter().collect();
        t.push(&launch, &coin.mint, &seats).unwrap();
    }
    (launch, people, creator, coin)
}

fn u64_at(data: &[u8], at: usize) -> u64 {
    u64::from_le_bytes(data[at..at + 8].try_into().unwrap())
}

fn pairs(launch: &LaunchKeys, people: &[Depositor]) -> Vec<(Pubkey, Pubkey)> {
    people.iter().map(|d| (d.seat(launch), d.wallet.pubkey())).collect()
}

#[test]
fn locks_the_creators_coins_in_an_escrow_nobody_can_cancel() {
    let mut t = Test::new();
    let (launch, _, creator, coin) = opened_and_pushed(&mut t);
    let l: Launch = t.read(&launch.launch);
    assert_eq!((l.creator_deposit, l.creator_tier), (30 * STEP, Tier::Scored));
    let outcome = l.outcome(Tier::Scored, 30 * STEP);
    let seat_rent = t.lamports(&creator.seat(&launch));
    let coin_rent = t.rent(fair_open::TOKEN_ACCOUNT_LEN);
    let wallet = creator.wallet.pubkey();
    let before = t.lamports(&wallet);
    let lock_rent = t.rent(jupiter_lock::ESCROW_LEN) + coin_rent;
    // The creator prepaid the lock with the open's rent: what is left of it after the open is exactly the lock's.
    assert_eq!(l.open_rent, lock_rent);

    let done = t.lock_creator(&launch, &coin, &creator).unwrap();
    println!("lock_creator: {} compute units", done.compute_units_consumed);

    // The escrow holds exactly the creator's coins, released from 7 days after trading opened to 30 days after it, to
    // the Creator wallet, with nobody able to cancel it and only the recipient able to change who receives it.
    let escrow = escrow_address(&locker_address(&launch.launch));
    let e = t.svm.get_account(&escrow).unwrap();
    assert_eq!((e.owner, e.data.len()), (jupiter_lock::PROGRAM_ID, jupiter_lock::ESCROW_LEN));
    let pool = t.svm.get_account(&coin.pool).unwrap();
    let opened_at = u64_at(&pool.data, fair_open::dbc::POOL_ACTIVATION_POINT_OFFSET);
    assert_eq!(&e.data[layout::RECIPIENT..][..32], wallet.as_ref());
    assert_eq!(&e.data[layout::TOKEN_MINT..][..32], coin.mint.as_ref());
    assert_eq!((e.data[layout::CANCEL_MODE], e.data[layout::UPDATE_RECIPIENT_MODE]), (0, 2));
    let cliff = u64_at(&e.data, layout::CLIFF_TIME);
    let (frequency, periods) = (u64_at(&e.data, layout::FREQUENCY), u64_at(&e.data, layout::NUMBER_OF_PERIOD));
    assert_eq!(cliff, opened_at + CREATOR_LOCK_CLIFF_SECONDS as u64);
    assert_eq!(cliff + frequency * periods, opened_at + CREATOR_LOCK_END_SECONDS as u64);
    let total = u64_at(&e.data, layout::CLIFF_UNLOCK_AMOUNT) + u64_at(&e.data, layout::AMOUNT_PER_PERIOD) * periods;
    assert_eq!(total, outcome.coins);
    assert_eq!(t.tokens(&associated_address(&escrow, &coin.mint)), Some(outcome.coins));
    assert!(u64_at(&e.data, layout::CLIFF_UNLOCK_AMOUNT) < periods, "at most a second's worth released at the cliff");

    // The creator's seat closed: its refund, its prepaid coin-account rent and its own rent back to the Creator wallet,
    // the lock paid out of the prepaid rent.
    let locked = &events::<CreatorLocked>(&done)[0];
    assert_eq!(
        (locked.escrow, locked.coins, locked.rent, locked.rent_from_seat),
        (Some(escrow), outcome.coins, lock_rent, 0)
    );
    assert_eq!(t.lamports(&wallet) - before, outcome.refund + coin_rent + seat_rent);
    assert!(!t.exists(&creator.seat(&launch)));
    // Every seat now has its coins: the coin dust is burnt and the pot's coin account closed.
    assert_eq!(events::<CoinDustBurnt>(&done).len(), 1);
    assert!(!t.exists(&associated_address(&launch.launch, &coin.mint)));
    let l: Launch = t.read(&launch.launch);
    assert_eq!((l.seats, l.delivered, l.open_rent), (9, 9, 0));
    // Beyond what it owes, the vault holds the pot's coin account's rent, the creator's, back with the launch's.
    assert_eq!(t.vault_holds(&launch), l.owed() + coin_rent);
    // Locked once.
    assert!(t.lock_creator(&launch, &coin, &creator).is_err());
}

#[test]
fn the_creators_coins_leave_the_pot_only_into_the_escrow() {
    let mut t = Test::new();
    let (launch, people, creator, coin) = opened_and_pushed(&mut t);
    // Not by a push, nor by the creator's own claim.
    let pot_coins = associated_address(&launch.launch, &coin.mint);
    let held = t.tokens(&pot_coins).unwrap();
    t.push(&launch, &coin.mint, &[&creator]).unwrap();
    assert_eq!(t.tokens(&pot_coins), Some(held));
    let theirs = associated_address(&creator.wallet.pubkey(), &coin.mint);
    refused(t.claim(&launch, &coin.mint, &creator, &theirs), Code::CreatorsSeat);
    // The lock takes the Creator wallet's seat only.
    let ix = t.lock_creator_instruction(&launch, &coin, &people[0].seat(&launch));
    refused(t.send(&[ix], &[]), Code::NotTheCreatorsSeat);
    // Into the escrow of the launch's own locker, which only this program signs for, and no other.
    let mut ix = t.lock_creator_instruction(&launch, &coin, &creator.seat(&launch));
    let other = escrow_address(&Pubkey::new_unique());
    ix.accounts[8].pubkey = other;
    ix.accounts[9].pubkey = associated_address(&other, &coin.mint);
    assert!(t.send(&[ix], &[]).is_err());
    assert_eq!(t.tokens(&pot_coins), Some(held));

    t.lock_creator(&launch, &coin, &creator).unwrap();
    let escrow = escrow_address(&locker_address(&launch.launch));
    // The pot's coins went to the depositors and the escrow, and the rest was burnt: no coin left the pot anywhere else.
    let coins_out: u64 = people.iter().map(|d| t.read::<Seat>(&d.seat(&launch)).coins).sum::<u64>()
        + t.tokens(&associated_address(&escrow, &coin.mint)).unwrap();
    let l: Launch = t.read(&launch.launch);
    assert!(l.coins - coins_out < 10);
}

#[test]
fn a_launch_scheduled_before_the_lock_was_prepaid_pays_it_from_the_creators_refund() {
    let mut t = Test::new();
    let (launch, _, creator, coin) = opened_and_pushed(&mut t);
    // As a launch scheduled before #49 left it: no lock rent prepaid and no record of the creator's seat.
    let mut l: Launch = t.read(&launch.launch);
    let lock_rent = l.open_rent;
    l.open_rent = 0;
    l.creator_deposit = 0;
    let mut account = t.svm.get_account(&launch.launch).unwrap();
    let mut data = vec![];
    l.try_serialize(&mut data).unwrap();
    account.data[..data.len()].copy_from_slice(&data);
    t.svm.set_account(launch.launch, account).unwrap();
    let mut vault = t.svm.get_account(&launch.vault).unwrap();
    vault.lamports -= lock_rent;
    t.svm.set_account(launch.vault, vault).unwrap();

    let outcome = l.outcome(Tier::Scored, 30 * STEP);
    let wallet = creator.wallet.pubkey();
    let before = t.lamports(&wallet);
    let seat_rent = t.lamports(&creator.seat(&launch));
    let done = t.lock_creator(&launch, &coin, &creator).unwrap();
    let locked = &events::<CreatorLocked>(&done)[0];
    assert_eq!((locked.rent, locked.rent_from_seat), (lock_rent, lock_rent));
    let coin_rent = t.rent(fair_open::TOKEN_ACCOUNT_LEN);
    assert_eq!(t.lamports(&wallet) - before, outcome.refund + coin_rent - lock_rent + seat_rent);
    // It learnt the creator's seat, so the Tax Share leaves it out.
    let l: Launch = t.read(&launch.launch);
    assert_eq!(l.creator_deposit, 30 * STEP);
    assert_eq!(t.vault_holds(&launch), l.owed() + coin_rent);
}

#[test]
fn collects_the_window_fees_less_the_pots_own_fee_into_the_tax_share() {
    let mut t = Test::new();
    let (launch, _, _, coin) = opened_and_pushed(&mut t);
    let record: fee::CoinRecord = t.read(&coin_record_address(&coin.mint));
    assert_eq!(t.partner_quote_fee(&coin), record.pot_fee);
    // Two snipers' buys in the window pay the cliff.
    t.snipe(&coin, 100_000_000);
    t.snipe(&coin, 1_000_000);
    let window_fees = t.partner_quote_fee(&coin) - record.pot_fee;
    assert!(window_fees > 0);

    // Not inside the window: the fee program's window claim refuses it.
    t.at(600 + 59);
    let err = t.collect_tax_share(&launch, &coin).unwrap_err();
    assert_eq!(custom_error(&err), Some(6009), "the fee program's TaxWindowOpen: {:?}", err.meta.logs);

    t.at(600 + 60);
    let vault_before = t.vault_holds(&launch);
    let done = t.collect_tax_share(&launch, &coin).unwrap();
    println!("collect_tax_share: {} compute units", done.compute_units_consumed);
    let collected = &events::<TaxShareCollected>(&done)[0];
    let l: Launch = t.read(&launch.launch);
    // The dust: what the seats spent beyond the rung.
    let levels = (l.others_level, l.unverified_level);
    let spent = allocation::seats_spent(&l.counts, &l.unverified_counts, l.step, levels, l.spend, l.spent);
    assert_eq!((collected.fees, collected.dust), (window_fees, spent - l.spent));
    assert_eq!(collected.tax_share, window_fees + collected.dust);
    assert_eq!(collected.basis, l.spend - l.outcome(Tier::Scored, 30 * STEP).fill);
    assert_eq!(collected.treasury, None);
    assert!(l.tax_collected);
    // The fees reached the vault unwrapped, the pot's account closed again, and the pot's own fee stayed in the pool for
    // Creator Earnings' 50/50 split.
    assert_eq!(t.vault_holds(&launch) - vault_before, window_fees);
    assert!(!t.exists(&pot_address(&launch.launch)));
    assert_eq!(t.partner_quote_fee(&coin), record.pot_fee);
    assert!(t.read::<fee::CoinRecord>(&coin_record_address(&coin.mint)).window_claimed);
    assert_eq!(t.vault_holds(&launch), l.owed());
    // Collected once.
    refused(t.collect_tax_share(&launch, &coin), Code::TaxShareCollected);
}

#[test]
fn pays_every_seat_but_the_creators_its_tax_share_and_closes_the_launch() {
    let mut t = Test::new();
    let (launch, people, creator, coin) = opened_and_pushed(&mut t);
    t.snipe(&coin, 300_000_000);
    t.lock_creator(&launch, &coin, &creator).unwrap();
    // The Tax Share waits for its collection.
    refused(t.push_tax_share(&launch, &pairs(&launch, &people)), Code::TaxShareNotCollected);
    t.at(600 + 61);
    let collected = events::<TaxShareCollected>(&t.collect_tax_share(&launch, &coin).unwrap()).remove(0);
    let l: Launch = t.read(&launch.launch);
    let seats: Vec<Seat> = people.iter().map(|d| t.read(&d.seat(&launch))).collect();
    let before: Vec<u64> = people.iter().map(|d| t.lamports(&d.wallet.pubkey())).collect();
    let rents: Vec<u64> = people.iter().map(|d| t.lamports(&d.seat(&launch))).collect();

    let mut paid = vec![];
    for batch in pairs(&launch, &people).chunks(5) {
        let done = t.push_tax_share(&launch, batch).unwrap();
        println!("a Tax Share push of {} seats: {} compute units", batch.len(), done.compute_units_consumed);
        paid.extend(events::<TaxSharePaid>(&done));
    }
    assert_eq!(paid.len(), people.len());
    assert_eq!(paid.iter().map(|p| p.amount).sum::<u64>(), collected.tax_share);
    for (((d, seat), before), rent) in people.iter().zip(&seats).zip(before).zip(rents) {
        let p = paid.iter().find(|p| p.wallet == d.wallet.pubkey()).unwrap();
        let fill = l.outcome(d.tier, seat.deposit).fill;
        // In proportion to what the seat spent, within a lamport.
        let exact = collected.tax_share as f64 * fill as f64 / collected.basis as f64;
        assert!((p.amount as f64 - exact).abs() < 1.0);
        // And so in proportion to the SOL it spent, among everyone's but the creator's, within a lamport or two.
        let others_spent = l.spent + collected.dust - l.outcome(Tier::Scored, 30 * STEP).spent;
        let by_spent = collected.tax_share as f64 * seat.spent as f64 / others_spent as f64;
        assert!((p.amount as f64 - by_spent).abs() < 2.0, "{} vs {by_spent}", p.amount);
        assert_eq!(t.lamports(&d.wallet.pubkey()) - before, p.amount + rent);
        assert!(!t.exists(&d.seat(&launch)));
    }
    let l: Launch = t.read(&launch.launch);
    assert_eq!((l.seats, l.delivered, l.tax_unpaid(), l.owed()), (0, 0, 0, 0));
    // All the vault holds beyond its own rent is the pot's coin account's, the creator's.
    assert_eq!(t.vault_holds(&launch), t.rent(fair_open::TOKEN_ACCOUNT_LEN));

    // Done: the launch closes, its rent and its vault's back to the creator.
    let creator_wallet = creator.wallet.pubkey();
    let creator_before = t.lamports(&creator_wallet);
    let rent = t.lamports(&launch.launch) + t.lamports(&launch.vault);
    let done = t.close_launch(&launch).unwrap();
    assert_eq!(events::<LaunchClosed>(&done)[0].rent, rent);
    assert_eq!(t.lamports(&creator_wallet) - creator_before, rent);
    assert!(!t.exists(&launch.launch) && !t.exists(&launch.vault));
}

#[test]
fn a_seat_waits_for_its_coins_before_its_tax_share_and_a_launch_for_every_seat_before_it_closes() {
    let mut t = Test::new();
    let launch = t.launch();
    let (people, creator) = with_creator(&mut t, &launch);
    t.at(600);
    let l: Launch = t.read(&launch.launch);
    let rung = allocation::rung_at_or_below(l.pot_cap, l.allocation().spend).unwrap();
    let (_, coin) = t.open(&launch, rung).unwrap();
    refused(t.close_launch(&launch), Code::TaxShareNotCollected);
    t.at(600 + 60);
    t.collect_tax_share(&launch, &coin).unwrap();
    // Nobody pushed yet: a seat still owed its coins and refund keeps its seat.
    let done = t.push_tax_share(&launch, &pairs(&launch, &people[..3])).unwrap();
    assert!(events::<TaxSharePaid>(&done).is_empty());
    assert!(t.exists(&people[0].seat(&launch)));
    // The creator's seat closes with the lock, never with a Tax Share.
    let done = t.push_tax_share(&launch, &[(creator.seat(&launch), creator.wallet.pubkey())]).unwrap();
    assert!(events::<TaxSharePaid>(&done).is_empty());
    let seats: Vec<&Depositor> = people.iter().collect();
    for batch in seats.chunks(5) {
        t.push(&launch, &coin.mint, batch).unwrap();
    }
    t.push_tax_share(&launch, &pairs(&launch, &people)).unwrap();
    refused(t.close_launch(&launch), Code::SeatsLeft);
    t.lock_creator(&launch, &coin, &creator).unwrap();
    t.close_launch(&launch).unwrap();
}

#[test]
fn with_no_seat_but_the_creators_the_tax_share_goes_to_the_treasury() {
    let mut t = Test::new();
    let launch = t.launch();
    let creator = Depositor { wallet: t.creator.insecure_clone(), person: [42; 32], tier: Tier::Scored };
    t.deposit(&launch, &creator, 50 * STEP).unwrap();
    t.at(600);
    let l: Launch = t.read(&launch.launch);
    let rung = allocation::rung_at_or_below(l.pot_cap, l.allocation().spend).unwrap();
    let (_, coin) = t.open(&launch, rung).unwrap();
    t.snipe(&coin, 10_000_000);
    t.lock_creator(&launch, &coin, &creator).unwrap();
    t.at(600 + 60);
    let treasury = t.treasury();
    let before = t.lamports(&treasury);
    let done = t.collect_tax_share(&launch, &coin).unwrap();
    let collected = &events::<TaxShareCollected>(&done)[0];
    assert_eq!((collected.basis, collected.treasury), (0, Some(treasury)));
    assert_eq!(t.lamports(&treasury) - before, collected.tax_share);
    let l: Launch = t.read(&launch.launch);
    assert_eq!((l.seats, l.tax_unpaid(), l.owed()), (0, 0, 0));
    assert_eq!(t.vault_holds(&launch), t.rent(fair_open::TOKEN_ACCOUNT_LEN));
    t.close_launch(&launch).unwrap();
}

#[test]
fn the_creator_lock_schedule_holds_every_coin() {
    for coins in [1, 1_987_199, 1_987_200, 1_987_201, 123_456_789_012_345] {
        let s = jupiter_lock::Schedule::creator_lock(1_800_000_000, coins);
        assert_eq!(s.cliff_unlock_amount + s.amount_per_period * s.number_of_period, coins);
        assert_eq!(s.cliff_time, 1_800_000_000 + 7 * DAY as u64);
        assert_eq!(s.end_time(), 1_800_000_000 + 30 * DAY as u64);
        assert_eq!(s.frequency, 1);
        assert!(s.cliff_unlock_amount < s.number_of_period);
    }
    // The escrow's layout and Lock's event authority, as the program names them.
    assert_eq!(jupiter_lock::ESCROW_LEN, lock_stand_in::ESCROW_LEN);
    assert_eq!(jupiter_lock::CREATE_VESTING_ESCROW_V2, lock_stand_in::CREATE_VESTING_ESCROW_V2);
    let events = Pubkey::find_program_address(&[b"__event_authority"], &jupiter_lock::PROGRAM_ID).0;
    assert_eq!(jupiter_lock::EVENT_AUTHORITY, events);
    let discriminator = <fee::instruction::ClaimFairOpenWindowFees as anchor_lang::Discriminator>::DISCRIMINATOR;
    assert_eq!(&fair_open::fee::CLAIM_FAIR_OPEN_WINDOW_FEES_DISCRIMINATOR[..], discriminator);
    assert_eq!(
        &fair_open::fee::FEE_CONFIG_DISCRIMINATOR[..],
        <fee::FeeConfig as anchor_lang::Discriminator>::DISCRIMINATOR
    );
    assert_eq!(fair_open::POT_SEED, fee::POT_SEED);
}
