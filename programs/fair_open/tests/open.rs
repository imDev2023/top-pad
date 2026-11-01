//! The open, in LiteSVM with the fee program and our stand-in for DBC (spec 2.1 steps 10 to 12): one transaction creates
//! the coin and its pool with the pot's buy as the pool's first swap at the ending fee, records the coin with the fee
//! program and pays our keeper back what the open's accounts cost it; every seat then gets its coins and refund at the
//! pot's one price, by a push or its own claim. Nothing but the creation transaction, at its time and on its rung, opens
//! a launch. The devnet tests run the same open against Meteora's real DBC.
#![allow(clippy::result_large_err)]
mod common;

use {
    anchor_lang::{solana_program::instruction::Instruction, Space},
    common::*,
    fair_open::{allocation, CoinDustBurnt, Launch, LaunchOpened, LaunchStatus, Seat, SeatDelivered, Tier},
    solana_keypair::Keypair,
    solana_signer::Signer,
};

/// The stand-in's price and fees (tests/dbc-stand-in): what a first buy of `amount` gets, and its fee.
fn first_buy(amount: u64) -> (u64, u64) {
    let fee = (amount as u128 * dbc_stand_in::ENDING_FEE).div_ceil(dbc_stand_in::FEE_DENOMINATOR) as u64;
    (((amount - fee) as u128 * dbc_stand_in::COINS_PER_LAMPORT_MILLI / 1_000) as u64, fee)
}

/// An oversubscribed pot with an Unverified sub-level, the devnet test's: 3 Verified people asking 0.6 SOL and 6
/// Unverified people asking 0.1 SOL into a 1.7 SOL cap. One level would give the Unverified 0.6 of 1.7 SOL, more than a
/// quarter, so they share a third of what everyone else fills.
fn oversubscribed(t: &mut Test, launch: &LaunchKeys) -> Vec<Depositor> {
    let mut people = vec![];
    for (tier, steps, n) in [(Tier::Verified, 60, 3), (Tier::Unverified, 10, 6)] {
        for _ in 0..n {
            let d = t.depositor(tier);
            t.deposit(launch, &d, steps * STEP).unwrap();
            people.push(d);
        }
    }
    people
}

/// The rung the pot covers, by the program's own reference.
fn covered_rung(t: &Test, launch: &LaunchKeys) -> u64 {
    let l: Launch = t.read(&launch.launch);
    allocation::rung_at_or_below(l.pot_cap, l.allocation().spend).unwrap()
}

/// A launch opened on the rung its pot covers, with its seats.
fn opened(
    t: &mut Test,
    deposit: impl Fn(&mut Test, &LaunchKeys) -> Vec<Depositor>,
) -> (LaunchKeys, Vec<Depositor>, CoinKeys) {
    let launch = t.launch();
    let people = deposit(t, &launch);
    t.at(600);
    let rung = covered_rung(t, &launch);
    let (_, coin) = t.open(&launch, rung).unwrap();
    (launch, people, coin)
}

#[test]
fn opens_in_one_transaction_and_records_the_coin_with_the_fee_program() {
    let mut t = Test::new();
    let launch = t.launch();
    oversubscribed(&mut t, &launch);
    let l: Launch = t.read(&launch.launch);
    let a = l.allocation();
    assert_eq!((a.spend, a.others.level, a.unverified.level), (1_699_999_998, 425_000_000, 70_833_333));
    let rung = covered_rung(&t, &launch);
    assert_eq!(rung, 1_615_000_000);

    t.at(600);
    let keeper = t.keeper.pubkey();
    let keeper_before = t.lamports(&keeper);
    let open_rent = l.open_rent;
    let (done, coin) = t.open(&launch, rung).unwrap();

    // The pot bought first, at the ending fee, and holds what it bought in its own coin account.
    let (coins, fee) = first_buy(rung);
    let l: Launch = t.read(&launch.launch);
    assert_eq!(l.status, LaunchStatus::Opened);
    assert_eq!((l.mint, l.spend, l.spent, l.coins), (coin.mint, a.spend, rung, coins));
    assert_eq!((l.others_level, l.unverified_level), (a.others.level, a.unverified.level));
    assert_eq!(t.tokens(&associated_address(&launch.launch, &coin.mint)), Some(coins));
    assert!(!t.exists(&pot_address(&launch.launch)), "the pot's wrapped-SOL account closes once spent");

    // The coin's record names its launch and the pot's own fee, the partner's four fifths of what the pot paid.
    let record: fee::CoinRecord = t.read(&coin_record_address(&coin.mint));
    assert_eq!(record.launch_mode, fee::LaunchMode::FairOpen);
    assert_eq!((record.fair_open_launch, record.pot_fee, record.pool), (Some(launch.launch), fee - fee / 5, coin.pool));

    // Our keeper paid only the transaction's three signatures: the open's accounts came out of the creator's prepaid rent,
    // which is exactly what they cost and what the Creator lock's will.
    assert_eq!(keeper_before - t.lamports(&keeper), 15_000);
    let opened = &events::<LaunchOpened>(&done)[0];
    let lock_rent = fair_open::lock_rent(&t.svm.get_sysvar());
    assert_eq!(
        (opened.rent_paid_back, opened.pot_fee, opened.coins, opened.seats),
        (open_rent - lock_rent, record.pot_fee, coins, 9)
    );
    assert_eq!(l.open_rent, lock_rent);
    assert_eq!(t.vault_holds(&launch), l.owed());
    println!(
        "open and settle: {} compute units; the open's accounts cost {} lamports, prepaid",
        done.compute_units_consumed, open_rent
    );
}

#[test]
fn refuses_an_early_rung_a_late_one_and_any_rung_but_the_one_the_pot_covers() {
    let mut t = Test::new();
    let launch = t.launch();
    oversubscribed(&mut t, &launch);
    let rung = covered_rung(&t, &launch);
    let l: Launch = t.read(&launch.launch);
    let below = allocation::rungs(l.pot_cap).nth(2).unwrap();

    t.at(599);
    refused(t.open(&launch, rung).map(|(done, _)| done), Code::TooEarly);
    t.at(600);
    refused(t.open(&launch, below).map(|(done, _)| done), Code::WrongRung);
    refused(t.open(&launch, l.pot_cap).map(|(done, _)| done), Code::WrongRung);
    t.at(600 + 900);
    refused(t.open(&launch, rung).map(|(done, _)| done), Code::TooLate);
    t.at(600 + 899);
    t.open(&launch, rung).unwrap();
    // At most one open.
    refused(t.open(&launch, rung).map(|(done, _)| done), Code::NotScheduled);
}

#[test]
fn refuses_a_pot_below_the_lowest_rung_or_its_minimum_raise() {
    let mut t = Test::new();
    let launch = t.launch();
    let d = t.depositor(Tier::Scored);
    t.deposit(&launch, &d, STEP).unwrap();
    t.at(600);
    let l: Launch = t.read(&launch.launch);
    refused(t.open(&launch, l.lowest_rung).map(|(done, _)| done), Code::CannotOpen);

    let identity_hash = Coin::new("TEST").identity_hash();
    let launch =
        t.launch_with(fair_open::LaunchParams { deposits_open_at: WINDOW_OPENS + 10, min_raise: SOL, identity_hash });
    let d = t.depositor(Tier::Verified);
    t.at(10);
    t.deposit(&launch, &d, 90 * STEP).unwrap();
    t.at(610);
    let rung = covered_rung(&t, &launch);
    refused(t.open(&launch, rung).map(|(done, _)| done), Code::CannotOpen);
}

#[test]
fn refuses_any_transaction_but_the_creation_transaction() {
    let mut t = Test::new();
    let launch = t.launch();
    oversubscribed(&mut t, &launch);
    let rung = covered_rung(&t, &launch);
    t.at(600);
    let mint = Keypair::new();
    let good = t.creation_instructions(&launch, rung, &mint.pubkey(), &Coin::new("TEST"));

    // Something after the settle, such as a sniper's buy riding along: refused, and so is a missing settle.
    let mut ixs = good.clone();
    ixs.push(Instruction { program_id: anchor_lang::system_program::ID, accounts: vec![], data: vec![2, 0, 0, 0] });
    refused(t.send_creation(&ixs, &mint), Code::NotTheCreationTransaction);
    refused(t.send_creation(&good[..4], &mint), Code::NotTheCreationTransaction);
    // A swap without the instructions sysvar would pay DBC's 99% cliff.
    let mut ixs = good.clone();
    ixs[3].accounts.pop();
    refused(t.send_creation(&ixs, &mint), Code::NotTheCreationTransaction);
    // A coin other than the one sealed at scheduling.
    let other = t.creation_instructions(&launch, rung, &mint.pubkey(), &Coin::new("VAMP"));
    refused(t.send_creation(&other, &mint), Code::IdentityMismatch);
    // The settle on its own, outside the creation transaction.
    let keeper = t.keeper.insecure_clone();
    refused(send_as(&mut t.svm, &good[4..], &keeper, &[]), Code::NotOpening);

    t.send_creation(&good, &mint).unwrap();
}

#[test]
fn pushes_every_seat_its_coins_and_refund_at_the_pots_one_price() {
    let mut t = Test::new();
    let (launch, people, coin) = opened(&mut t, oversubscribed);
    let l: Launch = t.read(&launch.launch);
    let coin_rent = t.rent(fair_open::TOKEN_ACCOUNT_LEN);
    let before: Vec<u64> = people.iter().map(|d| t.lamports(&d.wallet.pubkey())).collect();

    let mut delivered = vec![];
    let mut burnt = vec![];
    for batch in people.chunks(4) {
        let seats: Vec<&Depositor> = batch.iter().collect();
        let done = t.push(&launch, &coin.mint, &seats).unwrap();
        println!("a push of {} seats: {} compute units", seats.len(), done.compute_units_consumed);
        delivered.extend(events::<SeatDelivered>(&done));
        burnt.extend(events::<CoinDustBurnt>(&done));
    }
    assert_eq!(delivered.len(), people.len());

    let mut coins_out = 0;
    for (d, before) in people.iter().zip(before) {
        let seat: Seat = t.read(&d.seat(&launch));
        let deposit = seat.deposit;
        let level = if d.tier == Tier::Unverified { l.unverified_level } else { l.others_level };
        let fill = deposit.min(level);
        // No seat's fill exceeds its tier's cap (spec 5.3).
        assert!(fill <= d.tier.cap(STEP));
        let (spent, coins) = allocation::share(fill, l.spend, l.spent, l.coins);
        assert!(seat.delivered);
        assert_eq!((seat.spent, seat.coins, seat.refund, seat.coin_rent), (spent, coins, deposit - spent, 0));
        // The coins in the wallet's own account, made from the seat's prepaid rent, and the refund in the wallet.
        assert_eq!(t.tokens(&associated_address(&d.wallet.pubkey(), &coin.mint)), Some(coins));
        assert_eq!(t.lamports(&d.wallet.pubkey()) - before, deposit - spent);
        assert!(t.exists(&d.seat(&launch)), "a seat stays until its Tax Share is paid");
        coins_out += coins;
    }
    // The pot's one price: a Verified seat paid 0.6 SOL less its refund for 6x the coins of an Unverified seat's level.
    assert_eq!(delivered[0].spent, 403_750_001);
    assert_eq!(delivered[3].fill, 70_833_333);

    // Every seat delivered: the coins the rounding left are burnt, and the pot's coin account closes into the vault.
    let l: Launch = t.read(&launch.launch);
    assert_eq!(burnt.len(), 1);
    assert_eq!(coins_out + burnt[0].amount, l.coins);
    assert!(burnt[0].amount < people.len() as u64);
    assert!(!t.exists(&associated_address(&launch.launch, &coin.mint)));
    assert_eq!((l.delivered, l.coin_rent), (9, 0));
    // What the vault still owes: the lamports the rounding gathered for the Tax Share, and the Creator lock's prepaid rent,
    // which comes back to the creator with the launch's since they hold no seat.
    let dust: u64 = people.iter().map(|d| t.read::<Seat>(&d.seat(&launch)).spent).sum::<u64>() - l.spent;
    assert_eq!(l.owed(), dust + l.open_rent);
    assert_eq!(l.open_rent, fair_open::lock_rent(&t.svm.get_sysvar()));
    assert_eq!(t.vault_holds(&launch), l.owed() + coin_rent);
}

#[test]
fn a_push_sent_twice_delivers_nothing_twice_and_passes_over_the_creators_seat() {
    let mut t = Test::new();
    let creator = Depositor { wallet: t.creator.insecure_clone(), person: [42; 32], tier: Tier::Scored };
    let (launch, people, coin) = opened(&mut t, |t, launch| {
        let mut people = oversubscribed(t, launch);
        let creator = Depositor { wallet: t.creator.insecure_clone(), person: [42; 32], tier: Tier::Scored };
        t.deposit(launch, &creator, 30 * STEP).unwrap();
        people.push(creator);
        people
    });
    let seats: Vec<&Depositor> = people.iter().collect();
    let first = t.push(&launch, &coin.mint, &seats[..5]).unwrap();
    assert_eq!(events::<SeatDelivered>(&first).len(), 5);
    let creator_before = t.lamports(&creator.wallet.pubkey());
    // Two of them again, the four left, and the creator's: as many as a transaction's 38 accounts hold.
    let again = t.push(&launch, &coin.mint, &seats[3..]).unwrap();
    // The two passed over, and the creator's seat too: its coins go only into the Creator lock.
    assert_eq!(events::<SeatDelivered>(&again).len(), 4);
    assert!(!t.read::<Seat>(&creator.seat(&launch)).delivered);
    assert_eq!(t.lamports(&creator.wallet.pubkey()), creator_before);
    let l: Launch = t.read(&launch.launch);
    assert_eq!((l.delivered, l.seats), (9, 10));
    // With the creator's coins still in the pot, nothing is burnt yet.
    assert!(events::<CoinDustBurnt>(&again).is_empty());
    assert!(t.tokens(&associated_address(&launch.launch, &coin.mint)).unwrap() > 0);
    refused(
        t.claim(&launch, &coin.mint, &creator, &associated_address(&creator.wallet.pubkey(), &coin.mint)),
        Code::CreatorsSeat,
    );
}

/// The depositor makes their own associated account of the coin, paying its rent.
fn own_coin_account(t: &mut Test, d: &Depositor, mint: &anchor_lang::prelude::Pubkey) -> anchor_lang::prelude::Pubkey {
    use anchor_lang::solana_program::instruction::AccountMeta;
    let wallet = d.wallet.pubkey();
    let account = associated_address(&wallet, mint);
    let ix = Instruction {
        program_id: ASSOCIATED_TOKEN_PROGRAM,
        accounts: vec![
            AccountMeta::new(wallet, true),
            AccountMeta::new(account, false),
            AccountMeta::new_readonly(wallet, false),
            AccountMeta::new_readonly(*mint, false),
            AccountMeta::new_readonly(anchor_lang::system_program::ID, false),
            AccountMeta::new_readonly(TOKEN_PROGRAM, false),
        ],
        data: vec![1],
    };
    send_as(&mut t.svm, &[ix], &d.wallet, &[]).unwrap();
    account
}

#[test]
fn returns_the_coin_accounts_rent_when_the_wallet_has_one_already() {
    let mut t = Test::new();
    let (launch, people, coin) = opened(&mut t, oversubscribed);
    let d = &people[0];
    own_coin_account(&mut t, d, &coin.mint);
    let before = t.lamports(&d.wallet.pubkey());
    let done = t.push(&launch, &coin.mint, &[d]).unwrap();
    let delivered = &events::<SeatDelivered>(&done)[0];
    let coin_rent = t.rent(fair_open::TOKEN_ACCOUNT_LEN);
    assert_eq!(delivered.coin_rent, coin_rent);
    assert_eq!(t.lamports(&d.wallet.pubkey()) - before, delivered.refund + coin_rent);
}

#[test]
fn a_depositor_claims_alone_into_an_account_they_own() {
    let mut t = Test::new();
    let (launch, people, coin) = opened(&mut t, oversubscribed);
    let (d, other) = (&people[4], &people[5]);
    let account = own_coin_account(&mut t, d, &coin.mint);
    let theirs = own_coin_account(&mut t, other, &coin.mint);
    refused(t.claim(&launch, &coin.mint, d, &theirs), Code::NotYourCoinAccount);

    let before = t.lamports(&d.wallet.pubkey());
    let done = t.claim(&launch, &coin.mint, d, &account).unwrap();
    let delivered = &events::<SeatDelivered>(&done)[0];
    assert!(!delivered.pushed);
    assert_eq!(t.tokens(&account), Some(delivered.coins));
    // The refund and the coin account's prepaid rent, less the claim's own fee.
    let coin_rent = t.rent(fair_open::TOKEN_ACCOUNT_LEN);
    assert_eq!(t.lamports(&d.wallet.pubkey()) + 5_000 - before, delivered.refund + coin_rent);
    refused(t.claim(&launch, &coin.mint, d, &account), Code::AlreadyDelivered);
    // A push afterwards passes the claimed seat over.
    let again = t.push(&launch, &coin.mint, &[d, other]).unwrap();
    assert_eq!(events::<SeatDelivered>(&again).len(), 1);
}

#[test]
fn nothing_is_pushed_or_claimed_before_the_open() {
    let mut t = Test::new();
    let launch = t.launch();
    let people = oversubscribed(&mut t, &launch);
    // Before the open the launch has no coin, so a push names one it cannot have.
    let mint = Keypair::new().pubkey();
    let ix = t.push_instruction(&launch, &mint, &[(people[0].seat(&launch), people[0].wallet.pubkey())]);
    refused(t.send(&[ix], &[]), Code::NotTheCoin);
}

#[test]
fn keeps_the_seat_and_launch_layouts() {
    // The open's fields took the room the window's accounts kept for them (#45), so a seat or launch made before still
    // reads.
    assert_eq!(8 + Launch::INIT_SPACE, 1_233);
    assert_eq!(8 + Seat::INIT_SPACE, 178);
    assert_eq!(fair_open::open_rent::COIN_RECORD_LEN, 8 + fee::CoinRecord::INIT_SPACE);
    let discriminator = <fee::instruction::RegisterFairOpenCoin as anchor_lang::Discriminator>::DISCRIMINATOR;
    assert_eq!(&fair_open::fee::REGISTER_FAIR_OPEN_COIN_DISCRIMINATOR[..], discriminator);
    assert_eq!(fair_open::COIN_REGISTRAR_SEED, fee::COIN_REGISTRAR_SEED);
}
