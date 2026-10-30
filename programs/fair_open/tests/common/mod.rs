//! What the Fair Open program's LiteSVM tests share: the built program (target/deploy/fair_open.so, from `pnpm programs`)
//! with its `ProgramConfig`, Heat's Fair Open config written in DBC's layout and owner, a durable nonce held by the
//! keeper, and admissions signed by a test admission key and verified by the real Ed25519 precompile. No other program
//! runs here (spec 5.1).
// LiteSVM's failed-transaction metadata is large by design; the helpers here only hand it back to the test.
#![allow(clippy::result_large_err, dead_code)]
use {
    anchor_lang::{
        prelude::{Clock, Rent},
        solana_program::{
            instruction::{AccountMeta, Instruction},
            pubkey::Pubkey,
            system_program,
        },
        AccountDeserialize, AnchorDeserialize, Discriminator, InstructionData, Space, ToAccountMetas,
    },
    fair_open::{admission, dbc, Admission, LaunchParams, ProgramSettings, Seat, Tier, Vault},
    litesvm::{
        types::{FailedTransactionMetadata, TransactionMetadata},
        LiteSVM,
    },
    solana_account::ReadableAccount,
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
};

pub const PROGRAM: &[u8] = include_bytes!(concat!(env!("CARGO_TARGET_TMPDIR"), "/../deploy/fair_open.so"));

pub const UPGRADEABLE_LOADER: Pubkey = anchor_lang::solana_program::bpf_loader_upgradeable::ID;
pub const SOL: u64 = 1_000_000_000;
pub const STEP: u64 = fair_open::DEPOSIT_STEP;
/// Heat's devnet Graduation Target, which the test config holds: so the pot's cap is 1.7 SOL, as on devnet.
pub const GRADUATION_TARGET: u64 = 8_500_000_000;
/// When the tests' windows open, as a Unix timestamp.
pub const WINDOW_OPENS: i64 = 1_800_000_000;

/// The program's error codes, in declaration order from Anchor's 6000: clients match on these numbers, so a variant
/// inserted anywhere but the end would show up here.
#[repr(u32)]
#[derive(Clone, Copy, Debug)]
pub enum Code {
    NotUpgradeAuthority = 6000,
    MissingSetting,
    NotTheKeeper,
    NotTheFairOpenConfig,
    NotADbcConfig,
    QuoteNotSupported,
    MinRaiseAboveCap,
    WindowOver,
    TooFarAhead,
    NoIdentity,
    NotOurNonce,
    NotScheduled,
    WindowNotStarted,
    WindowClosed,
    OffStep,
    NoAdmission,
    NotOurAdmission,
    NotThisAdmission,
    AdmissionExpired,
    CapOverTier,
    SeatHeldByAnotherWallet,
    OverCap,
    OverDeposit,
    TooManySeats,
    SeatNotCounted,
    NotThisLaunchsSeat,
    NotYourSeat,
    VaultShort,
    WindowNotClosed,
    CanStillOpen,
    NotFailed,
    SeatsLeft,
    NotTheCreator,
}

/// A launch's accounts.
#[derive(Clone, Copy, Debug)]
pub struct LaunchKeys {
    pub launch: Pubkey,
    pub vault: Pubkey,
    pub nonce: Pubkey,
}

/// A depositor: their wallet, and the person our admission server says they are.
pub struct Depositor {
    pub wallet: Keypair,
    pub person: [u8; 32],
    pub tier: Tier,
}

impl Depositor {
    pub fn seat(&self, launch: &LaunchKeys) -> Pubkey {
        seat_address(&launch.launch, &self.person)
    }
}

pub struct Test {
    pub svm: LiteSVM,
    pub upgrade_authority: Keypair,
    pub keeper: Keypair,
    pub admission_key: Keypair,
    pub creator: Keypair,
    pub payer: Keypair,
    pub dbc_config: Pubkey,
}

impl Test {
    /// The program deployed, its `ProgramConfig` set, and the clock at `WINDOW_OPENS`.
    pub fn new() -> Self {
        let mut t = Test::deployed();
        let upgrade_authority = t.upgrade_authority.insecure_clone();
        t.initialize_as(&upgrade_authority, t.settings()).unwrap();
        t.at(0);
        t
    }

    /// The program deployed with an upgrade authority, and Heat's Fair Open config on chain; no `ProgramConfig` yet.
    pub fn deployed() -> Self {
        let mut svm = LiteSVM::new();
        svm.add_program(fair_open::id(), PROGRAM).unwrap();
        let payer = Keypair::new();
        svm.airdrop(&payer.pubkey(), 100 * SOL).unwrap();
        let creator = Keypair::new();
        svm.airdrop(&creator.pubkey(), 10 * SOL).unwrap();
        let mut t = Test {
            svm,
            upgrade_authority: Keypair::new(),
            keeper: Keypair::new(),
            admission_key: Keypair::new(),
            creator,
            payer,
            dbc_config: Pubkey::new_unique(),
        };
        t.set_upgrade_authority(Some(t.upgrade_authority.pubkey()));
        let config = dbc_config_data(&fair_open::NATIVE_MINT, GRADUATION_TARGET);
        t.set_account(t.dbc_config, config, dbc::PROGRAM_ID);
        t
    }

    pub fn settings(&self) -> ProgramSettings {
        ProgramSettings {
            admission_signer: self.admission_key.pubkey(),
            keeper: self.keeper.pubkey(),
            fee_program: Pubkey::new_from_array([7; 32]),
            dbc_config: self.dbc_config,
        }
    }

    /// LiteSVM deploys with no upgrade authority; this rewrites the ProgramData header (the loader's bincode: a u32
    /// variant tag 3, the deploy slot, then an optional authority) as a real deploy leaves it.
    pub fn set_upgrade_authority(&mut self, authority: Option<Pubkey>) {
        let address = program_data_address();
        let mut account = self.svm.get_account(&address).unwrap();
        assert_eq!(u32::from_le_bytes(account.data[..4].try_into().unwrap()), 3, "not a ProgramData account");
        match authority {
            Some(key) => {
                account.data[12] = 1;
                account.data[13..45].copy_from_slice(key.as_ref());
            }
            None => {
                account.data[12] = 0;
                account.data[13..45].fill(0);
            }
        }
        self.svm.set_account(address, account).unwrap();
    }

    pub fn initialize_as(
        &mut self,
        authority: &Keypair,
        settings: ProgramSettings,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let accounts = fair_open::accounts::Initialize {
            program_config: program_config_address(),
            authority: authority.pubkey(),
            program_data: program_data_address(),
            payer: self.payer.pubkey(),
            system_program: system_program::ID,
            event_authority: event_authority(),
            program: fair_open::id(),
        };
        let ix = instruction(accounts.to_account_metas(None), fair_open::instruction::Initialize { settings }.data());
        self.send(&[ix], &[authority])
    }

    pub fn update_as(
        &mut self,
        authority: &Keypair,
        settings: ProgramSettings,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let accounts = fair_open::accounts::UpdateProgramConfig {
            program_config: program_config_address(),
            authority: authority.pubkey(),
            program_data: program_data_address(),
            event_authority: event_authority(),
            program: fair_open::id(),
        };
        let data = fair_open::instruction::UpdateProgramConfig { settings }.data();
        self.send(&[instruction(accounts.to_account_metas(None), data)], &[authority])
    }

    /// A durable nonce account held by `authority`, as the system program leaves one it initialized.
    pub fn nonce_held_by(&mut self, authority: &Pubkey) -> Pubkey {
        let nonce = Pubkey::new_unique();
        let mut data = vec![0u8; fair_open::nonce::ACCOUNT_LEN];
        data[..4].copy_from_slice(&fair_open::nonce::CURRENT_VERSION.to_le_bytes());
        data[4..8].copy_from_slice(&fair_open::nonce::INITIALIZED.to_le_bytes());
        data[8..40].copy_from_slice(authority.as_ref());
        data[40..72].copy_from_slice(&[9; 32]);
        self.set_account(nonce, data, system_program::ID);
        nonce
    }

    /// A launch whose window opens at `WINDOW_OPENS`, with no minimum raise.
    pub fn launch(&mut self) -> LaunchKeys {
        self.launch_with(LaunchParams { deposits_open_at: WINDOW_OPENS, min_raise: 0, identity_hash: [5; 32] })
    }

    pub fn launch_with(&mut self, params: LaunchParams) -> LaunchKeys {
        let keeper = self.keeper.pubkey();
        let nonce = self.nonce_held_by(&keeper);
        let creator = self.creator.insecure_clone();
        let keeper = self.keeper.insecure_clone();
        self.create_launch(&creator, &keeper, nonce, self.dbc_config, params).unwrap();
        launch_keys(nonce)
    }

    pub fn create_launch(
        &mut self,
        creator: &Keypair,
        keeper: &Keypair,
        nonce: Pubkey,
        dbc_config: Pubkey,
        params: LaunchParams,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let keys = launch_keys(nonce);
        let accounts = fair_open::accounts::CreateLaunch {
            program_config: program_config_address(),
            creator: creator.pubkey(),
            keeper: keeper.pubkey(),
            dbc_config,
            nonce,
            launch: keys.launch,
            vault: keys.vault,
            system_program: system_program::ID,
            event_authority: event_authority(),
            program: fair_open::id(),
        };
        let ix = instruction(accounts.to_account_metas(None), fair_open::instruction::CreateLaunch { params }.data());
        send_as(&mut self.svm, &[ix], creator, &[keeper])
    }

    /// A new wallet with 5 SOL, admitted as a new person of `tier`.
    pub fn depositor(&mut self, tier: Tier) -> Depositor {
        let wallet = Keypair::new();
        self.svm.airdrop(&wallet.pubkey(), 5 * SOL).unwrap();
        Depositor { wallet, person: Pubkey::new_unique().to_bytes(), tier }
    }

    /// The admission our server would give the depositor in `launch`: their tier's full cap, for a minute.
    pub fn admission(&self, d: &Depositor) -> Admission {
        Admission { person: d.person, tier: d.tier, cap: d.tier.cap(STEP), expires_at: self.now() + 60 }
    }

    /// The Ed25519 precompile instruction verifying `signer`'s signature over the admission for `wallet`.
    pub fn signed(&self, signer: &Keypair, launch: &LaunchKeys, wallet: &Pubkey, admission: &Admission) -> Instruction {
        let message = admission.message(&launch.launch, wallet);
        ed25519_instruction(signer, &message)
    }

    pub fn deposit(
        &mut self,
        launch: &LaunchKeys,
        d: &Depositor,
        amount: u64,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let admission = self.admission(d);
        let admission_key = self.admission_key.insecure_clone();
        let precompile = self.signed(&admission_key, launch, &d.wallet.pubkey(), &admission);
        self.deposit_with(launch, &d.wallet, amount, admission, &[precompile])
    }

    /// A deposit with any admission and whatever instructions go before it.
    pub fn deposit_with(
        &mut self,
        launch: &LaunchKeys,
        wallet: &Keypair,
        amount: u64,
        admission: Admission,
        before: &[Instruction],
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let ix = self.deposit_instruction(launch, &wallet.pubkey(), amount, admission);
        let mut ixs = before.to_vec();
        ixs.push(ix);
        send_as(&mut self.svm, &ixs, wallet, &[])
    }

    pub fn deposit_instruction(
        &self,
        launch: &LaunchKeys,
        wallet: &Pubkey,
        amount: u64,
        admission: Admission,
    ) -> Instruction {
        let accounts = fair_open::accounts::Deposit {
            program_config: program_config_address(),
            launch: launch.launch,
            vault: launch.vault,
            seat: seat_address(&launch.launch, &admission.person),
            depositor: *wallet,
            instructions: solana_instructions_sysvar_id(),
            system_program: system_program::ID,
            event_authority: event_authority(),
            program: fair_open::id(),
        };
        instruction(accounts.to_account_metas(None), fair_open::instruction::Deposit { amount, admission }.data())
    }

    pub fn withdraw(
        &mut self,
        launch: &LaunchKeys,
        d: &Depositor,
        amount: u64,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        self.withdraw_as(launch, &d.seat(launch), &d.wallet, amount)
    }

    pub fn withdraw_as(
        &mut self,
        launch: &LaunchKeys,
        seat: &Pubkey,
        wallet: &Keypair,
        amount: u64,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let accounts = fair_open::accounts::Withdraw {
            launch: launch.launch,
            vault: launch.vault,
            seat: *seat,
            wallet: wallet.pubkey(),
            event_authority: event_authority(),
            program: fair_open::id(),
        };
        let ix = instruction(accounts.to_account_metas(None), fair_open::instruction::Withdraw { amount }.data());
        send_as(&mut self.svm, &[ix], wallet, &[])
    }

    /// `mark_failed`, sent by a stranger.
    pub fn mark_failed(&mut self, launch: &LaunchKeys) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let accounts = fair_open::accounts::MarkFailed {
            launch: launch.launch,
            event_authority: event_authority(),
            program: fair_open::id(),
        };
        let ix = instruction(accounts.to_account_metas(None), fair_open::instruction::MarkFailed {}.data());
        self.send(&[ix], &[])
    }

    /// `withdraw_failed` for `d`'s seat, sent by `sender`.
    pub fn withdraw_failed(
        &mut self,
        launch: &LaunchKeys,
        d: &Depositor,
        sender: &Keypair,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let ix = withdraw_failed_instruction(launch, &d.seat(launch), &d.wallet.pubkey());
        send_as(&mut self.svm, &[ix], sender, &[])
    }

    pub fn close_launch(&mut self, launch: &LaunchKeys) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let accounts = fair_open::accounts::CloseLaunch {
            launch: launch.launch,
            vault: launch.vault,
            creator: self.creator.pubkey(),
            event_authority: event_authority(),
            program: fair_open::id(),
        };
        let ix = instruction(accounts.to_account_metas(None), fair_open::instruction::CloseLaunch {}.data());
        self.send(&[ix], &[])
    }

    /// The chain's clock `seconds` after the tests' windows open.
    pub fn at(&mut self, seconds: i64) {
        let clock = Clock { unix_timestamp: WINDOW_OPENS + seconds, ..self.svm.get_sysvar::<Clock>() };
        self.svm.set_sysvar(&clock);
    }

    pub fn now(&self) -> i64 {
        self.svm.get_sysvar::<Clock>().unix_timestamp
    }

    pub fn rent(&self, len: usize) -> u64 {
        self.svm.get_sysvar::<Rent>().minimum_balance(len)
    }

    pub fn lamports(&self, address: &Pubkey) -> u64 {
        self.svm.get_account(address).map_or(0, |a| a.lamports)
    }

    pub fn exists(&self, address: &Pubkey) -> bool {
        self.svm.get_account(address).is_some_and(|a| a.lamports > 0)
    }

    pub fn read<T: AccountDeserialize>(&self, address: &Pubkey) -> T {
        let account = self.svm.get_account(address).unwrap_or_else(|| panic!("no account at {address}"));
        T::try_deserialize(&mut account.data.as_slice()).unwrap()
    }

    /// Every seat of `launch` on chain, read the way a depositor with no Heat server finds theirs.
    pub fn seats_of(&self, launch: &LaunchKeys) -> Vec<Seat> {
        self.svm
            .accounts_db()
            .inner
            .iter()
            .filter(|(_, a)| a.owner() == &fair_open::id() && a.data().starts_with(Seat::DISCRIMINATOR))
            .map(|(_, a)| Seat::try_deserialize(&mut a.data()).unwrap())
            .filter(|s| s.launch == launch.launch)
            .collect()
    }

    /// What the vault holds beyond its own rent.
    pub fn vault_holds(&self, launch: &LaunchKeys) -> u64 {
        self.lamports(&launch.vault) - self.rent(8 + Vault::INIT_SPACE)
    }

    pub fn send(
        &mut self,
        ixs: &[Instruction],
        signers: &[&Keypair],
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let payer = self.payer.insecure_clone();
        send_as(&mut self.svm, ixs, &payer, signers)
    }

    pub fn set_account(&mut self, address: Pubkey, data: Vec<u8>, owner: Pubkey) {
        let lamports = self.svm.minimum_balance_for_rent_exemption(data.len());
        let account = solana_account::Account { lamports, data, owner, executable: false, rent_epoch: 0 };
        self.svm.set_account(address, account).unwrap();
    }
}

/// A DBC `PoolConfig` as DBC lays it out, with only what the program reads filled in.
pub fn dbc_config_data(quote_mint: &Pubkey, graduation_target: u64) -> Vec<u8> {
    let mut data = vec![0u8; 1048];
    data[..8].copy_from_slice(&dbc::POOL_CONFIG_DISCRIMINATOR);
    data[dbc::CONFIG_QUOTE_MINT_OFFSET..][..32].copy_from_slice(quote_mint.as_ref());
    data[dbc::CONFIG_MIGRATION_QUOTE_THRESHOLD_OFFSET..][..8].copy_from_slice(&graduation_target.to_le_bytes());
    data
}

/// The Ed25519 precompile's instruction as Solana's SDK builds one (`new_ed25519_instruction_with_signature`): one
/// signature, its public key, signature and message all in its own data.
pub fn ed25519_instruction(signer: &Keypair, message: &[u8]) -> Instruction {
    let signature = signer.sign_message(message);
    let (key_at, signature_at, message_at) = (16u16, 48u16, 112u16);
    let mut data = vec![1u8, 0];
    for field in [signature_at, u16::MAX, key_at, u16::MAX, message_at, message.len() as u16, u16::MAX] {
        data.extend_from_slice(&field.to_le_bytes());
    }
    data.extend_from_slice(signer.pubkey().as_ref());
    data.extend_from_slice(signature.as_ref());
    data.extend_from_slice(message);
    Instruction { program_id: admission::ED25519_PROGRAM, accounts: vec![], data }
}

pub fn withdraw_failed_instruction(launch: &LaunchKeys, seat: &Pubkey, wallet: &Pubkey) -> Instruction {
    let accounts = fair_open::accounts::WithdrawFailed {
        launch: launch.launch,
        vault: launch.vault,
        seat: *seat,
        wallet: *wallet,
        event_authority: event_authority(),
        program: fair_open::id(),
    };
    instruction(accounts.to_account_metas(None), fair_open::instruction::WithdrawFailed {}.data())
}

pub fn instruction(accounts: Vec<AccountMeta>, data: Vec<u8>) -> Instruction {
    Instruction { program_id: fair_open::id(), accounts, data }
}

/// Sends a transaction on a new blockhash, so one sent again, as a refused one often is, is a new transaction.
pub fn send_as(
    svm: &mut LiteSVM,
    ixs: &[Instruction],
    payer: &Keypair,
    signers: &[&Keypair],
) -> Result<TransactionMetadata, FailedTransactionMetadata> {
    svm.expire_blockhash();
    let msg = Message::new_with_blockhash(ixs, Some(&payer.pubkey()), &svm.latest_blockhash());
    let mut all: Vec<&Keypair> = vec![payer];
    all.extend(signers.iter().copied().filter(|s| s.pubkey() != payer.pubkey()));
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &all).unwrap();
    svm.send_transaction(tx)
}

/// The custom error a failed instruction returned, if any.
pub fn custom_error(err: &FailedTransactionMetadata) -> Option<u32> {
    let text = format!("{:?}", err.err);
    let at = text.find("Custom(")? + "Custom(".len();
    text[at..].split(')').next()?.parse().ok()
}

/// Asserts a transaction failed with the program's error `code`.
pub fn refused(result: Result<TransactionMetadata, FailedTransactionMetadata>, code: Code) {
    let err = result.expect_err("the transaction should have been refused");
    assert_eq!(custom_error(&err), Some(code as u32), "expected {code:?}: {:?}", err.meta.logs);
}

/// The events of type `E` a transaction emitted through Anchor's event CPI, in order.
pub fn events<E: AnchorDeserialize + Discriminator>(done: &TransactionMetadata) -> Vec<E> {
    let tag = anchor_lang::event::EVENT_IX_TAG_LE;
    done.inner_instructions
        .iter()
        .flatten()
        .filter_map(|inner| {
            let data = &inner.instruction.data;
            let body = data.strip_prefix(tag)?.strip_prefix(E::DISCRIMINATOR)?;
            E::try_from_slice(body).ok()
        })
        .collect()
}

pub fn launch_keys(nonce: Pubkey) -> LaunchKeys {
    let launch = Pubkey::find_program_address(&[fair_open::LAUNCH_SEED, nonce.as_ref()], &fair_open::id()).0;
    let vault = Pubkey::find_program_address(&[fair_open::VAULT_SEED, launch.as_ref()], &fair_open::id()).0;
    LaunchKeys { launch, vault, nonce }
}

pub fn seat_address(launch: &Pubkey, person: &[u8; 32]) -> Pubkey {
    Pubkey::find_program_address(&[fair_open::SEAT_SEED, launch.as_ref(), person], &fair_open::id()).0
}

pub fn program_config_address() -> Pubkey {
    Pubkey::find_program_address(&[fair_open::PROGRAM_CONFIG_SEED], &fair_open::id()).0
}

pub fn event_authority() -> Pubkey {
    Pubkey::find_program_address(&[b"__event_authority"], &fair_open::id()).0
}

pub fn program_data_address() -> Pubkey {
    Pubkey::find_program_address(&[fair_open::id().as_ref()], &UPGRADEABLE_LOADER).0
}

pub fn solana_instructions_sysvar_id() -> Pubkey {
    Pubkey::from_str_const("Sysvar1nstructions1111111111111111111111111")
}
