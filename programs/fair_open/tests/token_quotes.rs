//! Stock-priced coins (ADR 0007 decision 1, spec 5.3): a Fair Open in a quote other than SOL holds its deposits in its
//! pot, a token account of the quote the launch owns, made at scheduling, and moves them by `TransferChecked` with the
//! quote's own token program; every rent stays in SOL, in the vault. Run in a Token-2022 quote with every extension an
//! xStock carries (mainnet NVDAx's own mint account, its authorities handed to a test issuer) and in an SPL Token quote
//! shaped as Circle's USDC. A quote Heat does not take is refused at scheduling, and a paused one fails the open and
//! holds every refund until its issuer resumes it.
#![allow(clippy::result_large_err)]
mod common;

use {
    anchor_lang::prelude::Pubkey,
    common::*,
    fair_open::{
        allocation, Deposited, FailedDepositReturned, Failure, Launch, LaunchClosed, LaunchParams, LaunchStatus,
        SeatDelivered, TaxShareCollected, TaxSharePaid, Tier, Withdrawn,
    },
    solana_keypair::Keypair,
    solana_signer::Signer,
};

const KINDS: [QuoteKind; 2] = [QuoteKind::Xstock, QuoteKind::Usdc];

/// The pot's raw account.
fn pot(t: &Test, launch: &LaunchKeys) -> solana_account::Account {
    t.svm.get_account(&pot_address(&launch.launch)).expect("the pot exists")
}

/// A fresh launch's accounts in a quote of `kind`, sealing `Coin::new("TEST")`.
fn scheduled(kind: QuoteKind) -> (Test, LaunchKeys) {
    let mut t = Test::in_quote(kind);
    let launch = t.launch();
    (t, launch)
}

#[test]
fn schedules_with_a_pot_of_the_quote_the_creator_pays_for() {
    for kind in KINDS {
        let mut t = Test::in_quote(kind);
        let creator = t.creator.pubkey();
        let before = t.lamports(&creator);
        let launch = t.launch();
        let l: Launch = t.read(&launch.launch);
        assert_eq!((l.quote_mint, l.step, l.pot_cap), (t.quote.mint, QUOTE_STEP, QUOTE_GRADUATION_TARGET / 5));
        assert_eq!(
            Pubkey::create_program_address(
                &[fair_open::POT_SEED, launch.launch.as_ref(), &[l.pot_bump]],
                &fair_open::id()
            ),
            Ok(pot_address(&launch.launch))
        );

        // The pot is a token account of the quote under its own program, owned by the launch and holding nothing; an
        // xStock's carries the account extensions its mint requires (a transfer hook account and a pausable account).
        let p = pot(&t, &launch);
        assert_eq!(p.owner, t.quote.program, "{kind:?}");
        assert_eq!(&p.data[..32], t.quote.mint.as_ref());
        assert_eq!(&p.data[32..64], launch.launch.as_ref());
        assert_eq!(t.pot_holds(&launch), 0);
        match kind {
            QuoteKind::Xstock => assert!(p.data.len() > 165, "an xStock's accounts carry extensions"),
            QuoteKind::Usdc => assert_eq!(p.data.len(), 165),
        }
        // The creator paid the pot's rent, in SOL, with the launch's, the vault's and the open's, and the transaction's
        // two signatures.
        let paid = before - t.lamports(&creator) - 10_000;
        let launch_rent = t.lamports(&launch.launch) + t.lamports(&launch.vault);
        assert_eq!(paid, launch_rent + p.lamports, "{kind:?}");
        assert_eq!(p.lamports, t.rent(p.data.len()));
    }
}

#[test]
fn schedules_even_when_someone_sent_lamports_to_the_pot_first() {
    let mut t = Test::in_quote(QuoteKind::Xstock);
    let (creator, keeper) = (t.creator.insecure_clone(), t.keeper.insecure_clone());
    let nonce = t.nonce_held_by(&keeper.pubkey());
    let keys = launch_keys(nonce);
    t.svm.airdrop(&pot_address(&keys.launch), 1_000).unwrap();
    let params = LaunchParams { deposits_open_at: WINDOW_OPENS, min_raise: 0, identity_hash: [7; 32] };
    let config = t.quote.config;
    t.create_launch(&creator, &keeper, nonce, config, params).unwrap();
    assert_eq!(pot(&t, &keys).owner, TOKEN_2022);
}

/// `Test::in_quote(Xstock)` with its quote's mint changed by `edit`, its settings written again.
fn xstock_edited(edit: impl Fn(&mut Vec<u8>)) -> Test {
    let mut t = Test::in_quote(QuoteKind::Xstock);
    let mut data = xstock_mint_data(&t.issuer.pubkey());
    edit(&mut data);
    let (mint, config) = (t.quote.mint, t.quote.config);
    t.set_account(mint, data, TOKEN_2022);
    t.set_quote_settings(&mint, config, config, QUOTE_STEP).unwrap();
    t
}

fn schedule(t: &mut Test) -> Result<litesvm::types::TransactionMetadata, litesvm::types::FailedTransactionMetadata> {
    let (creator, keeper) = (t.creator.insecure_clone(), t.keeper.insecure_clone());
    let nonce = t.nonce_held_by(&keeper.pubkey());
    let params = LaunchParams { deposits_open_at: WINDOW_OPENS, min_raise: 0, identity_hash: [7; 32] };
    let config = t.quote.config;
    t.create_launch(&creator, &keeper, nonce, config, params)
}

#[test]
fn refuses_a_quote_heat_does_not_take() {
    // As NVDAx is, every rule passes.
    schedule(&mut xstock_edited(|_| {})).unwrap();

    // Paused by its issuer.
    let mut t = xstock_edited(|data| {
        for_each_extension(data, |kind, value| {
            if kind == 26 {
                value[32] = 1
            }
        })
    });
    refused(schedule(&mut t), Code::QuotePaused);
    // A transfer hook naming a program, which no transfer here would pass the accounts of.
    let mut t = xstock_edited(|data| {
        for_each_extension(data, |kind, value| {
            if kind == 14 {
                value[32..64].fill(9)
            }
        })
    });
    refused(schedule(&mut t), Code::QuoteRefused);
    // Every new account frozen, so no depositor could be refunded.
    let mut t = xstock_edited(|data| {
        for_each_extension(data, |kind, value| {
            if kind == 6 {
                value[0] = 2
            }
        })
    });
    refused(schedule(&mut t), Code::QuoteRefused);

    // A transfer fee, now or scheduled, or an authority that could set one later (Token-2022's `TransferFeeConfig`: the
    // fee authority, the withheld authority and amount, then the older and newer fees).
    let with_fee = |authority: u8, older_bps: u16, newer_bps: u16| {
        move |data: &mut Vec<u8>| {
            let mut value = vec![0u8; 108];
            value[..32].fill(authority);
            for (at, bps) in [(72, older_bps), (90, newer_bps)] {
                value[at + 8..at + 16].copy_from_slice(&u64::MAX.to_le_bytes());
                value[at + 16..at + 18].copy_from_slice(&bps.to_le_bytes());
            }
            data.extend_from_slice(&1u16.to_le_bytes());
            data.extend_from_slice(&108u16.to_le_bytes());
            data.extend_from_slice(&value);
        }
    };
    schedule(&mut xstock_edited(with_fee(0, 0, 0))).unwrap();
    refused(schedule(&mut xstock_edited(with_fee(3, 0, 0))), Code::QuoteRefused);
    refused(schedule(&mut xstock_edited(with_fee(0, 0, 100))), Code::QuoteRefused);
    refused(schedule(&mut xstock_edited(with_fee(0, 50, 0))), Code::QuoteRefused);

    // Token-2022's own wrapped SOL, which DBC refuses.
    let mut t = Test::in_quote(QuoteKind::Xstock);
    let native = fair_open::TOKEN_2022_NATIVE_MINT;
    t.set_account(native, mint_data(9), TOKEN_2022);
    let config = Pubkey::new_unique();
    t.set_account(config, dbc_config_data(&native, QUOTE_GRADUATION_TARGET), fair_open::dbc::PROGRAM_ID);
    t.set_quote_settings(&native, config, config, QUOTE_STEP).unwrap();
    t.quote.mint = native;
    t.quote.config = config;
    refused(schedule(&mut t), Code::QuoteRefused);
}

#[test]
fn needs_the_pot_and_the_quotes_own_token_program() {
    let mut t = Test::in_quote(QuoteKind::Xstock);
    let (creator, keeper) = (t.creator.insecure_clone(), t.keeper.insecure_clone());
    let params = LaunchParams { deposits_open_at: WINDOW_OPENS, min_raise: 0, identity_hash: [7; 32] };
    let (mint, config) = (t.quote.mint, t.quote.config);
    let send = |t: &mut Test, pot: Option<Pubkey>, program: Option<Pubkey>| {
        use anchor_lang::{InstructionData, ToAccountMetas};
        let nonce = t.nonce_held_by(&keeper.pubkey());
        let keys = launch_keys(nonce);
        let accounts = fair_open::accounts::CreateLaunch {
            program_config: program_config_address(),
            creator: creator.pubkey(),
            keeper: keeper.pubkey(),
            quote_mint: mint,
            quote_settings: quote_settings_address(&mint),
            dbc_config: config,
            reference_config: t.dbc_config,
            nonce,
            launch: keys.launch,
            vault: keys.vault,
            system_program: anchor_lang::system_program::ID,
            pot: pot.map(|f| if f == Pubkey::default() { pot_address(&keys.launch) } else { f }),
            quote_token_program: program,
            event_authority: event_authority(),
            program: fair_open::id(),
        };
        let ix = instruction(accounts.to_account_metas(None), fair_open::instruction::CreateLaunch { params }.data());
        send_as(&mut t.svm, &[ix], &creator, &[&keeper])
    };
    refused(send(&mut t, None, Some(TOKEN_2022)), Code::QuoteAccountsMissing);
    refused(send(&mut t, Some(Pubkey::default()), None), Code::QuoteAccountsMissing);
    refused(send(&mut t, Some(Pubkey::default()), Some(TOKEN_PROGRAM)), Code::NotATokenAccount);
    refused(send(&mut t, Some(Pubkey::new_unique()), Some(TOKEN_2022)), Code::NotThePot);
    send(&mut t, Some(Pubkey::default()), Some(TOKEN_2022)).unwrap();
}

#[test]
fn takes_deposits_and_withdrawals_in_the_quote() {
    for kind in KINDS {
        let (mut t, launch) = scheduled(kind);
        let d = t.depositor(Tier::Scored);
        let wallet = d.wallet.pubkey();
        let (sol, vault) = (t.lamports(&wallet), t.vault_holds(&launch));

        let done = t.deposit(&launch, &d, 30 * QUOTE_STEP).unwrap();
        println!("{kind:?} deposit taking a seat: {} compute units", done.compute_units_consumed);
        assert_eq!(t.quote_held(&wallet), QUOTE_FUNDS - 30 * QUOTE_STEP);
        assert_eq!(t.pot_holds(&launch), 30 * QUOTE_STEP);
        // The rents are SOL: the seat's and the coin account's, which the vault keeps.
        let coin_rent = t.rent(fair_open::TOKEN_ACCOUNT_LEN);
        assert_eq!(t.vault_holds(&launch) - vault, coin_rent);
        let seat_rent = t.lamports(&d.seat(&launch));
        assert_eq!(sol - t.lamports(&wallet), coin_rent + seat_rent + 10_000);
        let deposited = &events::<Deposited>(&done)[0];
        assert_eq!(
            (deposited.amount, deposited.deposit, deposited.pot),
            (30 * QUOTE_STEP, 30 * QUOTE_STEP, 30 * QUOTE_STEP)
        );

        let done = t.deposit(&launch, &d, 20 * QUOTE_STEP).unwrap();
        println!("{kind:?} top-up: {} compute units", done.compute_units_consumed);
        // Off the quote's step, and over the tier's cap in the quote's step.
        refused(t.deposit(&launch, &d, QUOTE_STEP / 2), Code::OffStep);
        refused(t.deposit(&launch, &d, QUOTE_STEP), Code::OverCap);

        let done = t.withdraw(&launch, &d, 15 * QUOTE_STEP).unwrap();
        println!("{kind:?} withdrawal: {} compute units", done.compute_units_consumed);
        assert_eq!(t.quote_held(&wallet), QUOTE_FUNDS - 35 * QUOTE_STEP);
        assert_eq!(t.pot_holds(&launch), 35 * QUOTE_STEP);
        let sol = t.lamports(&wallet);
        let done = t.withdraw(&launch, &d, 35 * QUOTE_STEP).unwrap();
        assert!(events::<Withdrawn>(&done)[0].closed);
        // Everything back: the quote to the wallet's account of it, both rents in SOL.
        assert_eq!(t.quote_held(&wallet), QUOTE_FUNDS);
        assert_eq!(t.pot_holds(&launch), 0);
        assert_eq!(t.lamports(&wallet) - sol, coin_rent + seat_rent - 5_000);
        assert_eq!(t.vault_holds(&launch), t.open_rent());
    }
}

#[test]
fn moves_the_quote_only_through_its_own_accounts() {
    let (mut t, launch) = scheduled(QuoteKind::Xstock);
    let d = t.depositor(Tier::Scored);
    let other = t.depositor(Tier::Scored);
    t.deposit(&launch, &d, 10 * QUOTE_STEP).unwrap();

    // A deposit without the token accounts.
    let admission = t.admission(&d);
    let precompile = t.signed(&t.admission_key.insecure_clone(), &launch, &d.wallet.pubkey(), &admission);
    let mut ix = t.deposit_instruction(&launch, &d.wallet.pubkey(), QUOTE_STEP, admission);
    let pot_at = ix.accounts.iter().position(|a| a.pubkey == pot_address(&launch.launch)).unwrap();
    ix.accounts[pot_at].pubkey = fair_open::id();
    refused(send_as(&mut t.svm, &[precompile.clone(), ix.clone()], &d.wallet, &[]), Code::QuoteAccountsMissing);
    // Into another token account of the quote the launch owns, which is not its pot.
    let decoy = t.fund_quote(&launch.launch, 0);
    ix.accounts[pot_at].pubkey = decoy;
    refused(send_as(&mut t.svm, &[precompile, ix], &d.wallet, &[]), Code::NotThePot);

    // A withdrawal paid to an account of the quote another wallet owns.
    let mut ix = withdraw_ix(&t, &launch, &d);
    let to_at = ix.accounts.iter().position(|a| Some(a.pubkey) == t.quote_account(&d.wallet.pubkey())).unwrap();
    ix.accounts[to_at].pubkey = t.quote_account(&other.wallet.pubkey()).unwrap();
    refused(send_as(&mut t.svm, &[ix], &d.wallet, &[]), Code::NotYourQuoteAccount);
    assert_eq!(t.pot_holds(&launch), 10 * QUOTE_STEP);
}

fn withdraw_ix(t: &Test, launch: &LaunchKeys, d: &Depositor) -> anchor_lang::solana_program::instruction::Instruction {
    use anchor_lang::{InstructionData, ToAccountMetas};
    let (pot, quote_mint, quote_token_program) = t.quote_accounts(launch);
    let accounts = fair_open::accounts::Withdraw {
        launch: launch.launch,
        vault: launch.vault,
        seat: d.seat(launch),
        wallet: d.wallet.pubkey(),
        pot,
        quote_mint,
        quote_token_program,
        wallet_quote: t.quote_account(&d.wallet.pubkey()),
        event_authority: event_authority(),
        program: fair_open::id(),
    };
    instruction(accounts.to_account_metas(None), fair_open::instruction::Withdraw { amount: QUOTE_STEP }.data())
}

/// The devnet test's oversubscribed pot in the quote's steps, 3 Verified seats asking 60 steps and 6 Unverified asking
/// 10, and the creator's own seat, Scored, asking 30.
fn with_creator(t: &mut Test, launch: &LaunchKeys) -> (Vec<Depositor>, Depositor) {
    let mut people = vec![];
    for (tier, steps, n) in [(Tier::Verified, 60, 3), (Tier::Unverified, 10, 6)] {
        for _ in 0..n {
            let d = t.depositor(tier);
            t.deposit(launch, &d, steps * QUOTE_STEP).unwrap();
            people.push(d);
        }
    }
    let creator = Depositor { wallet: t.creator.insecure_clone(), person: [42; 32], tier: Tier::Scored };
    t.fund_quote(&creator.wallet.pubkey(), QUOTE_FUNDS);
    t.deposit(launch, &creator, 30 * QUOTE_STEP).unwrap();
    (people, creator)
}

#[test]
fn opens_pushes_and_pays_the_tax_share_in_an_xstock() {
    let (mut t, launch) = scheduled(QuoteKind::Xstock);
    let (people, creator) = with_creator(&mut t, &launch);
    let deposits = t.pot_holds(&launch);
    t.at(600);
    let l: Launch = t.read(&launch.launch);
    let rung = allocation::rung_at_or_below(l.pot_cap, l.allocation().spend).unwrap();

    // The open: DBC's swap spends exactly the rung out of the pot, through our keeper as its delegate, with the quote's
    // TokenBadge passed to the pool's creation.
    let (done, coin) = t.open(&launch, rung).unwrap();
    println!("xStock creation transaction: {} compute units", done.compute_units_consumed);
    assert_eq!(t.pot_holds(&launch), deposits - rung);
    assert_eq!(t.tokens(&coin.quote_vault), Some(rung));
    let l: Launch = t.read(&launch.launch);
    assert_eq!((l.status, l.spent), (LaunchStatus::Opened, rung));
    assert!(pot(&t, &launch).data[72..76] == [0; 4], "the delegate is spent");
    // The open refuses a second time.
    assert!(t.open(&launch, rung).is_err());

    // Each seat's coins and its refund in the quote, to the raw unit.
    for batch in people.chunks(5) {
        let seats: Vec<&Depositor> = batch.iter().collect();
        let befores: Vec<u64> = batch.iter().map(|d| t.quote_held(&d.wallet.pubkey())).collect();
        let done = t.push(&launch, &coin.mint, &seats).unwrap();
        println!("xStock push of {}: {} compute units", batch.len(), done.compute_units_consumed);
        let delivered = events::<SeatDelivered>(&done);
        for ((d, before), event) in batch.iter().zip(befores).zip(delivered) {
            let outcome = l.outcome(d.tier, event.deposit);
            assert_eq!(t.quote_held(&d.wallet.pubkey()) - before, outcome.refund);
            assert_eq!((event.refund, event.coins), (outcome.refund, outcome.coins));
        }
    }
    // The creator's coins into the Creator lock, their refund in the quote to their own account of it.
    let before = t.quote_held(&creator.wallet.pubkey());
    t.lock_creator(&launch, &coin, &creator).unwrap();
    let outcome = l.outcome(Tier::Scored, 30 * QUOTE_STEP);
    assert_eq!(t.quote_held(&creator.wallet.pubkey()) - before, outcome.refund);
    let l: Launch = t.read(&launch.launch);
    assert_eq!(t.pot_holds(&launch), l.owed_deposits());

    // A sniper's buys in the window pay the cliff in the quote; the window's fees, less the pot's own, are the Tax Share,
    // collected once the 60 s Tax window has ended.
    t.snipe(&coin, 50 * QUOTE_STEP);
    t.at(600 + 60);
    let window_fees = t.partner_quote_fee(&coin) - t.read::<fee::CoinRecord>(&coin_record_address(&coin.mint)).pot_fee;
    let before = t.pot_holds(&launch);
    let done = t.collect_tax_share(&launch, &coin).unwrap();
    println!("xStock collect_tax_share: {} compute units", done.compute_units_consumed);
    let collected = &events::<TaxShareCollected>(&done)[0];
    assert_eq!(collected.fees, window_fees);
    assert_eq!(t.pot_holds(&launch) - before, window_fees);
    assert_eq!(collected.tax_share, window_fees + collected.dust);

    // Every seat paid its share of it in the quote and closed; the shares add up to it to the raw unit.
    let pairs: Vec<(Pubkey, Pubkey)> = people.iter().map(|d| (d.seat(&launch), d.wallet.pubkey())).collect();
    let befores: Vec<u64> = people.iter().map(|d| t.quote_held(&d.wallet.pubkey())).collect();
    let done = t.push_tax_share(&launch, &pairs).unwrap();
    println!("xStock push_tax_share of {}: {} compute units", pairs.len(), done.compute_units_consumed);
    let paid = events::<TaxSharePaid>(&done);
    assert_eq!(paid.len(), people.len());
    for ((d, before), event) in people.iter().zip(befores).zip(&paid) {
        assert_eq!(t.quote_held(&d.wallet.pubkey()) - before, event.amount);
        assert!(!t.exists(&d.seat(&launch)));
    }
    assert_eq!(paid.iter().map(|p| p.amount).sum::<u64>(), collected.tax_share);
    assert_eq!(t.pot_holds(&launch), 0);

    // The launch closes, the pot with it, every rent back to the creator in SOL.
    let creator_sol = t.lamports(&creator.wallet.pubkey());
    let rents = t.lamports(&launch.launch) + t.lamports(&launch.vault) + pot(&t, &launch).lamports;
    let done = t.close_launch(&launch).unwrap();
    assert_eq!(events::<LaunchClosed>(&done)[0].rent, rents);
    assert_eq!(t.lamports(&creator.wallet.pubkey()) - creator_sol, rents);
    assert!(!t.exists(&pot_address(&launch.launch)));
}

#[test]
fn a_push_in_a_token_quote_runs_one_more_call_a_seat() {
    // A transaction runs at most 64 instructions, its programs' calls included (spec 5.3), which caps a push in SOL at 7
    // seats. In a token quote each seat's refund is one more call, a `TransferChecked` of the quote: counted here on a
    // push of 6 seats, the most LiteSVM builds as a legacy transaction (38 static accounts), against the same push in SOL.
    let calls = |t: &mut Test| {
        let launch = t.launch();
        let step = t.quote.step;
        let people: Vec<Depositor> = (0..6).map(|_| t.depositor(Tier::Verified)).collect();
        for d in &people {
            t.deposit(&launch, d, 40 * step).unwrap();
        }
        t.at(600);
        let l: Launch = t.read(&launch.launch);
        let rung = allocation::rung_at_or_below(l.pot_cap, l.allocation().spend).unwrap();
        let (_, coin) = t.open(&launch, rung).unwrap();
        let seats: Vec<&Depositor> = people.iter().collect();
        let done = t.push(&launch, &coin.mint, &seats).unwrap();
        // The compute budget and the push themselves, and every call they made.
        2 + done.inner_instructions.iter().map(Vec::len).sum::<usize>()
    };
    let in_sol = calls(&mut Test::new());
    let in_xstock = calls(&mut Test::in_quote(QuoteKind::Xstock));
    let in_usdc = calls(&mut Test::in_quote(QuoteKind::Usdc));
    println!("a push of 6 runs {in_sol} instructions in SOL, {in_xstock} in an xStock, {in_usdc} in USDC");
    assert_eq!(in_xstock, in_sol + 6);
    assert_eq!(in_usdc, in_sol + 6);
    // So 7 seats still fit in SOL, and in a token quote 6 do and 7 would not.
    let per_seat_in_sol = (in_sol - 3) / 6;
    assert!(in_sol + per_seat_in_sol <= 64, "7 seats fit in SOL");
    assert!(in_xstock <= 64 && in_xstock + per_seat_in_sol + 1 > 64, "6 seats fit in a token quote, and only 6");
}

#[test]
fn a_paused_quote_fails_the_open_and_holds_the_refunds_until_it_resumes() {
    let (mut t, launch) = scheduled(QuoteKind::Xstock);
    let people: Vec<Depositor> = (0..3).map(|_| t.depositor(Tier::Verified)).collect();
    for d in &people {
        t.deposit(&launch, d, 100 * QUOTE_STEP).unwrap();
    }
    t.at(600);
    let l: Launch = t.read(&launch.launch);
    let rung = allocation::rung_at_or_below(l.pot_cap, l.allocation().spend).unwrap();

    // Paused at its scheduled time: no rung opens, the pot cannot fail early, so it fails 15 minutes late.
    t.pause_quote(true);
    refused(t.open(&launch, rung).map(|(done, _)| done), Code::QuotePaused);
    refused(t.mark_failed(&launch), Code::CanStillOpen);
    t.at(600 + 900);
    t.mark_failed(&launch).unwrap();
    assert_eq!(t.read::<Launch>(&launch.launch).failure, Some(Failure::Late));

    // While it stays paused no deposit can move, so every refund waits, the seats and the pot as they were.
    let sender = Keypair::new();
    t.svm.airdrop(&sender.pubkey(), SOL).unwrap();
    for d in &people {
        assert!(t.withdraw_failed(&launch, d, &sender).is_err());
        assert!(t.exists(&d.seat(&launch)));
    }
    assert_eq!(t.pot_holds(&launch), 300 * QUOTE_STEP);

    // Once the issuer resumes it, every deposit comes back in full.
    t.pause_quote(false);
    for d in &people {
        let done = t.withdraw_failed(&launch, d, &sender).unwrap();
        assert_eq!(events::<FailedDepositReturned>(&done)[0].deposit, 100 * QUOTE_STEP);
        assert_eq!(t.quote_held(&d.wallet.pubkey()), QUOTE_FUNDS);
    }
    t.close_launch(&launch).unwrap();
    assert!(!t.exists(&pot_address(&launch.launch)));
}

#[test]
fn fails_in_usdc_with_every_deposit_refunded_in_usdc() {
    // The devnet demo's shape: deposits and a withdrawal, then a pot below the lowest rung failing at once.
    let (mut t, launch) = scheduled(QuoteKind::Usdc);
    let people: Vec<Depositor> = (0..3).map(|_| t.depositor(Tier::Scored)).collect();
    for d in &people {
        t.deposit(&launch, d, 2 * QUOTE_STEP).unwrap();
    }
    t.withdraw(&launch, &people[0], QUOTE_STEP).unwrap();
    t.at(600);
    t.mark_failed(&launch).unwrap();
    assert_eq!(t.read::<Launch>(&launch.launch).failure, Some(Failure::BelowLowestRung));
    let sender = Keypair::new();
    t.svm.airdrop(&sender.pubkey(), SOL).unwrap();
    for d in &people {
        let done = t.withdraw_failed(&launch, d, &sender).unwrap();
        println!("USDC withdraw_failed: {} compute units", done.compute_units_consumed);
        assert_eq!(t.quote_held(&d.wallet.pubkey()), QUOTE_FUNDS);
    }
    assert_eq!(t.pot_holds(&launch), 0);

    // Anything sent to the pot besides goes to the creator's account of the quote as it closes: 7 raw units here.
    let creator = t.creator.pubkey();
    t.fund_quote(&creator, 0);
    let pot_data = {
        let mut a = pot(&t, &launch);
        a.data[64..72].copy_from_slice(&7u64.to_le_bytes());
        a
    };
    t.svm.set_account(pot_address(&launch.launch), pot_data).unwrap();
    t.close_launch(&launch).unwrap();
    assert_eq!(t.quote_held(&creator), 7);
    assert!(!t.exists(&pot_address(&launch.launch)));
}
