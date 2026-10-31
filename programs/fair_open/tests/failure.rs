//! The failure path (spec 2.1 step 15): anyone marks a launch failed once it cannot open, and each depositor takes back
//! their deposit and both rents on chain, with no Heat server; then the creator's rent comes back too.
#![allow(clippy::result_large_err)]
mod common;

use {
    anchor_lang::Space,
    common::*,
    fair_open::{
        FailedDepositReturned, Failure, Launch, LaunchClosed, LaunchFailed, LaunchParams, LaunchStatus, Seat, Tier,
        Vault,
    },
    solana_keypair::Keypair,
    solana_signer::Signer,
};

/// A launch with a minimum raise, three depositors in it, and the window just closed.
fn closed_window(min_raise: u64, deposits: &[(Tier, u64)]) -> (Test, LaunchKeys, Vec<Depositor>) {
    let mut t = Test::new();
    let launch = t.launch_with(LaunchParams { deposits_open_at: WINDOW_OPENS, min_raise, identity_hash: [5; 32] });
    let mut depositors = Vec::new();
    for &(tier, amount) in deposits {
        let d = t.depositor(tier);
        t.deposit(&launch, &d, amount).unwrap();
        depositors.push(d);
    }
    t.at(600);
    (t, launch, depositors)
}

#[test]
fn cannot_fail_while_the_window_is_open() {
    let (mut t, launch, _) = closed_window(0, &[]);
    t.at(599);
    refused(t.mark_failed(&launch), Code::WindowNotClosed);
}

#[test]
fn fails_at_once_when_the_minimum_raise_is_missed() {
    let (mut t, launch, _) = closed_window(SOL, &[(Tier::Scored, 50 * STEP), (Tier::Verified, 40 * STEP)]);
    let done = t.mark_failed(&launch).unwrap();
    let l: Launch = t.read(&launch.launch);
    assert_eq!((l.status, l.failure, l.failed_at), (LaunchStatus::Failed, Some(Failure::MinRaiseMissed), t.now()));
    let failed = &events::<LaunchFailed>(&done)[0];
    assert_eq!(
        (failed.failure, failed.spend, failed.pot, failed.seats),
        (Failure::MinRaiseMissed, 90 * STEP, 90 * STEP, 2)
    );
    println!("mark_failed: {} compute units", done.compute_units_consumed);
}

#[test]
fn fails_at_once_when_the_pot_is_below_the_lowest_rung() {
    // The lowest rung of a 1.7 SOL cap is about 0.07 SOL; a pot of 0.05 cannot open.
    let (mut t, launch, _) = closed_window(0, &[(Tier::Scored, 5 * STEP)]);
    t.mark_failed(&launch).unwrap();
    assert_eq!(t.read::<Launch>(&launch.launch).failure, Some(Failure::BelowLowestRung));
}

#[test]
fn counts_only_what_unverified_seats_may_spend() {
    // 1 SOL of Unverified deposits and 0.03 SOL of Scored ones: the Unverified may spend a third of 0.03, so the pot
    // would spend 0.04 SOL, below the lowest rung, however much it holds.
    let mut deposits = vec![(Tier::Scored, 3 * STEP)];
    deposits.extend((0..10).map(|_| (Tier::Unverified, 10 * STEP)));
    let (mut t, launch, _) = closed_window(0, &deposits);
    let done = t.mark_failed(&launch).unwrap();
    let failed = &events::<LaunchFailed>(&done)[0];
    assert_eq!(failed.failure, Failure::BelowLowestRung);
    assert_eq!((failed.pot, failed.spend), (103 * STEP, 4 * STEP));
}

#[test]
fn may_still_open_until_fifteen_minutes_after_its_time() {
    let (mut t, launch, _) = closed_window(SOL / 2, &[(Tier::Verified, 100 * STEP)]);
    refused(t.mark_failed(&launch), Code::CanStillOpen);
    t.at(600 + 899);
    refused(t.mark_failed(&launch), Code::CanStillOpen);
    t.at(600 + 900);
    t.mark_failed(&launch).unwrap();
    assert_eq!(t.read::<Launch>(&launch.launch).failure, Some(Failure::Late));
    // Once failed, it stays failed.
    t.at(600 + 901);
    refused(t.mark_failed(&launch), Code::NotScheduled);
}

#[test]
fn returns_every_deposit_and_both_rents_with_no_server() {
    let (mut t, launch, depositors) =
        closed_window(0, &[(Tier::Verified, 200 * STEP), (Tier::Scored, 50 * STEP), (Tier::Unverified, 10 * STEP)]);
    t.at(600 + 900);
    t.mark_failed(&launch).unwrap();

    let coin_rent = t.rent(fair_open::TOKEN_ACCOUNT_LEN);
    let seat_rent = t.rent(8 + Seat::INIT_SPACE);
    for (i, d) in depositors.iter().enumerate() {
        let before = t.lamports(&d.wallet.pubkey());
        let deposit = t.read::<Seat>(&d.seat(&launch)).deposit;
        // Each depositor sends it alone, paying only its fee.
        let wallet = d.wallet.insecure_clone();
        let done = t.withdraw_failed(&launch, d, &wallet).unwrap();
        assert_eq!(t.lamports(&d.wallet.pubkey()) - before, deposit + coin_rent + seat_rent - 5_000);
        assert!(!t.exists(&d.seat(&launch)));
        let returned = &events::<FailedDepositReturned>(&done)[0];
        assert_eq!((returned.deposit, returned.coin_rent, returned.seat_rent), (deposit, coin_rent, seat_rent));
        assert_eq!(returned.seats as usize, depositors.len() - i - 1);
        if i == 0 {
            println!("withdraw_failed: {} compute units", done.compute_units_consumed);
        }
    }
    let l: Launch = t.read(&launch.launch);
    assert_eq!((l.seats, l.pot(), l.coin_rent), (0, 0, 0));
    // Only the creator's prepaid rent for the open is left, which `close_launch` returns.
    assert_eq!(t.vault_holds(&launch), t.open_rent());
}

#[test]
fn lets_anyone_send_a_depositor_their_refund_but_pays_only_them() {
    let (mut t, launch, depositors) = closed_window(SOL, &[(Tier::Scored, 20 * STEP)]);
    t.mark_failed(&launch).unwrap();
    let d = &depositors[0];
    let before = t.lamports(&d.wallet.pubkey());
    let stranger = Keypair::new();
    t.svm.airdrop(&stranger.pubkey(), SOL).unwrap();
    t.withdraw_failed(&launch, d, &stranger).unwrap();
    let back = 20 * STEP + t.rent(fair_open::TOKEN_ACCOUNT_LEN) + t.rent(8 + Seat::INIT_SPACE);
    assert_eq!(t.lamports(&d.wallet.pubkey()) - before, back);

    // A seat's refund sent anywhere but its wallet is refused.
    let (mut t, launch, depositors) = closed_window(SOL, &[(Tier::Scored, 20 * STEP)]);
    t.mark_failed(&launch).unwrap();
    let ix = withdraw_failed_instruction(&launch, &depositors[0].seat(&launch), &stranger.pubkey());
    t.svm.airdrop(&stranger.pubkey(), SOL).unwrap();
    refused(send_as(&mut t.svm, &[ix], &stranger, &[]), Code::NotYourSeat);
}

#[test]
fn refunds_nothing_before_the_launch_fails() {
    let (mut t, launch, depositors) = closed_window(SOL, &[(Tier::Scored, 20 * STEP)]);
    let wallet = depositors[0].wallet.insecure_clone();
    refused(t.withdraw_failed(&launch, &depositors[0], &wallet), Code::NotFailed);
    t.mark_failed(&launch).unwrap();
    // A failed launch takes no deposits and no window withdrawals, even within the window's times.
    t.at(10);
    refused(t.deposit(&launch, &depositors[0], STEP), Code::NotScheduled);
    refused(t.withdraw(&launch, &depositors[0], STEP), Code::NotScheduled);
}

#[test]
fn returns_the_creators_rent_once_every_seat_is_back() {
    let (mut t, launch, depositors) = closed_window(SOL, &[(Tier::Scored, 20 * STEP), (Tier::Verified, 30 * STEP)]);
    refused(t.close_launch(&launch), Code::NotFailed);
    t.mark_failed(&launch).unwrap();
    let wallet = depositors[0].wallet.insecure_clone();
    t.withdraw_failed(&launch, &depositors[0], &wallet).unwrap();
    refused(t.close_launch(&launch), Code::SeatsLeft);
    let wallet = depositors[1].wallet.insecure_clone();
    t.withdraw_failed(&launch, &depositors[1], &wallet).unwrap();

    let creator = t.creator.pubkey();
    let before = t.lamports(&creator);
    let done = t.close_launch(&launch).unwrap();
    // The launch's and the vault's rent, and the open's, which was never spent.
    let rent = t.rent(8 + Launch::INIT_SPACE) + t.rent(8 + Vault::INIT_SPACE) + t.open_rent();
    assert_eq!(t.lamports(&creator) - before, rent);
    assert!(!t.exists(&launch.launch) && !t.exists(&launch.vault));
    assert_eq!(events::<LaunchClosed>(&done)[0].rent, rent);
}
