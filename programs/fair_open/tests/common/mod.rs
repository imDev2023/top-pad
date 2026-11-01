//! What the Fair Open program's LiteSVM tests share: the built program (target/deploy/fair_open.so, from `pnpm programs`)
//! with its `ProgramConfig`, Heat's Fair Open config written in DBC's layout and owner, a durable nonce held by the
//! keeper, and admissions signed by a test admission key and verified by the real Ed25519 precompile. The open runs the
//! fee program (target/deploy/fee.so) with its `FeeConfig`, and our stand-in for DBC's pool creation, swap and fee claim
//! (tests/dbc-stand-in) at DBC's address; Meteora's own binary is never loaded (spec 5.1). The Creator lock runs our
//! stand-in for Jupiter Lock's escrow (tests/lock-stand-in) at Lock's address.
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
const FEE_PROGRAM: &[u8] = include_bytes!(concat!(env!("CARGO_TARGET_TMPDIR"), "/../deploy/fee.so"));
const DBC_STAND_IN: &[u8] = include_bytes!(concat!(env!("CARGO_TARGET_TMPDIR"), "/../deploy/dbc_stand_in.so"));
const LOCK_STAND_IN: &[u8] = include_bytes!(concat!(env!("CARGO_TARGET_TMPDIR"), "/../deploy/lock_stand_in.so"));

pub const TOKEN_PROGRAM: Pubkey = fair_open::TOKEN_PROGRAM;
pub const ASSOCIATED_TOKEN_PROGRAM: Pubkey = fair_open::creation::ASSOCIATED_TOKEN_PROGRAM;
pub const METADATA_PROGRAM: Pubkey = Pubkey::from_str_const("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

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
    TooEarly,
    TooLate,
    CannotOpen,
    WrongRung,
    NotTheCreationTransaction,
    IdentityMismatch,
    NotOpening,
    BuyNotSpent,
    NotThePotsCoins,
    NotThePool,
    NotTheCoin,
    NotTheFeeProgram,
    NotATokenAccount,
    NotOpened,
    SeatAccounts,
    AlreadyDelivered,
    CreatorsSeat,
    NotYourCoinAccount,
    NotTheCreatorsSeat,
    LockNotFunded,
    TaxShareCollected,
    TaxShareNotCollected,
    NotTheTreasury,
    NotDone,
    CreatorCoinsNotLocked,
}

/// A launch's coin, as the creator seals it at scheduling.
#[derive(Clone, Debug)]
pub struct Coin {
    pub name: String,
    pub ticker: String,
    pub uri: String,
}

impl Coin {
    pub fn new(ticker: &str) -> Self {
        Coin {
            name: format!("Test {ticker}"),
            ticker: ticker.into(),
            uri: format!("https://turbo-gateway.com/{ticker}"),
        }
    }

    /// DBC's `InitializePoolParameters` as the creation transaction serializes them.
    pub fn params(&self) -> Vec<u8> {
        let mut data = vec![];
        for part in [&self.name, &self.ticker, &self.uri] {
            data.extend_from_slice(&(part.len() as u32).to_le_bytes());
            data.extend_from_slice(part.as_bytes());
        }
        data
    }

    /// The hash the coin is sealed behind (spec 2.1 step 5).
    pub fn identity_hash(&self) -> [u8; 32] {
        solana_sha256_hasher::hash(&self.params()).to_bytes()
    }
}

/// A coin's accounts where DBC makes them, from its mint.
#[derive(Clone, Copy, Debug)]
pub struct CoinKeys {
    pub mint: Pubkey,
    pub pool: Pubkey,
    pub base_vault: Pubkey,
    pub quote_vault: Pubkey,
}

impl CoinKeys {
    pub fn of(config: &Pubkey, mint: &Pubkey) -> Self {
        let quote = fair_open::NATIVE_MINT;
        let (larger, smaller) = if mint > &quote { (*mint, quote) } else { (quote, *mint) };
        let dbc = |seeds: &[&[u8]]| Pubkey::find_program_address(seeds, &dbc::PROGRAM_ID).0;
        let pool = dbc(&[b"pool", config.as_ref(), larger.as_ref(), smaller.as_ref()]);
        CoinKeys {
            mint: *mint,
            pool,
            base_vault: dbc(&[b"token_vault", mint.as_ref(), pool.as_ref()]),
            quote_vault: dbc(&[b"token_vault", quote.as_ref(), pool.as_ref()]),
        }
    }
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
        svm.add_program(fee::id(), FEE_PROGRAM).unwrap();
        svm.add_program(dbc::PROGRAM_ID, DBC_STAND_IN).unwrap();
        svm.add_program(fair_open::jupiter_lock::PROGRAM_ID, LOCK_STAND_IN).unwrap();
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
        t.set_account(fair_open::NATIVE_MINT, mint_data(9), TOKEN_PROGRAM);
        // The fee program's settings, as `fee-config` sets them: its Fair Open program is this one.
        let fee_config = fee::FeeConfig {
            treasury: Pubkey::new_unique(),
            launch_key: t.keeper.pubkey(),
            fair_open_program: fair_open::id(),
            bump: Pubkey::find_program_address(&[fee::FEE_CONFIG_SEED], &fee::id()).1,
        };
        let mut data = vec![];
        anchor_lang::AccountSerialize::try_serialize(&fee_config, &mut data).unwrap();
        t.set_account(fee_config_address(), data, fee::id());
        // The keeper's float, which fronts the open's rent.
        let keeper = t.keeper.pubkey();
        t.svm.airdrop(&keeper, 10 * SOL).unwrap();
        t
    }

    pub fn settings(&self) -> ProgramSettings {
        ProgramSettings {
            admission_signer: self.admission_key.pubkey(),
            keeper: self.keeper.pubkey(),
            fee_program: fee::id(),
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

    /// A launch whose window opens at `WINDOW_OPENS`, with no minimum raise, sealing `Coin::new("TEST")`.
    pub fn launch(&mut self) -> LaunchKeys {
        let identity_hash = Coin::new("TEST").identity_hash();
        self.launch_with(LaunchParams { deposits_open_at: WINDOW_OPENS, min_raise: 0, identity_hash })
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

    /// The coin's creation transaction for `rung`, as a rung of the creator's ladder holds it (spec 2.1 step 10): the
    /// open, DBC's pool creation, the pot's coin account, the pot's buy, and the settle.
    pub fn creation_instructions(
        &self,
        launch: &LaunchKeys,
        rung: u64,
        mint: &Pubkey,
        coin: &Coin,
    ) -> Vec<Instruction> {
        let keeper = self.keeper.pubkey();
        let c = CoinKeys::of(&self.dbc_config, mint);
        let pot = pot_address(&launch.launch);
        let pot_coins = associated_address(&launch.launch, mint);
        let dbc_pda = |seed: &[u8]| Pubkey::find_program_address(&[seed], &dbc::PROGRAM_ID).0;
        let (pool_authority, dbc_events) = (dbc_pda(b"pool_authority"), dbc_pda(b"__event_authority"));
        let metadata =
            Pubkey::find_program_address(&[b"metadata", METADATA_PROGRAM.as_ref(), mint.as_ref()], &METADATA_PROGRAM).0;
        let ro = AccountMeta::new_readonly;
        let rw = AccountMeta::new;

        let open = fair_open::accounts::Open {
            program_config: program_config_address(),
            launch: launch.launch,
            vault: launch.vault,
            pot,
            keeper,
            quote_mint: fair_open::NATIVE_MINT,
            token_program: TOKEN_PROGRAM,
            instructions: solana_instructions_sysvar_id(),
            system_program: system_program::ID,
        };
        let open = instruction(open.to_account_metas(None), fair_open::instruction::Open { rung }.data());
        let init = Instruction {
            program_id: dbc::PROGRAM_ID,
            accounts: vec![
                ro(self.dbc_config, false),
                ro(pool_authority, false),
                ro(self.creator.pubkey(), true),
                rw(*mint, true),
                ro(fair_open::NATIVE_MINT, false),
                rw(c.pool, false),
                rw(c.base_vault, false),
                rw(c.quote_vault, false),
                rw(metadata, false),
                ro(METADATA_PROGRAM, false),
                rw(keeper, true),
                ro(TOKEN_PROGRAM, false),
                ro(TOKEN_PROGRAM, false),
                ro(system_program::ID, false),
                ro(dbc_events, false),
                ro(dbc::PROGRAM_ID, false),
            ],
            data: [dbc::INITIALIZE_POOL_WITH_SPL_TOKEN.as_slice(), &coin.params()].concat(),
        };
        let coins = Instruction {
            program_id: ASSOCIATED_TOKEN_PROGRAM,
            accounts: vec![
                rw(keeper, true),
                rw(pot_coins, false),
                ro(launch.launch, false),
                ro(*mint, false),
                ro(system_program::ID, false),
                ro(TOKEN_PROGRAM, false),
            ],
            data: vec![1],
        };
        let mut data = dbc::SWAP2.to_vec();
        data.extend(rung.to_le_bytes());
        data.extend(1u64.to_le_bytes());
        data.push(0);
        let swap = Instruction {
            program_id: dbc::PROGRAM_ID,
            accounts: vec![
                ro(pool_authority, false),
                ro(self.dbc_config, false),
                rw(c.pool, false),
                rw(pot, false),
                rw(pot_coins, false),
                rw(c.base_vault, false),
                rw(c.quote_vault, false),
                ro(*mint, false),
                ro(fair_open::NATIVE_MINT, false),
                ro(keeper, true),
                ro(TOKEN_PROGRAM, false),
                ro(TOKEN_PROGRAM, false),
                ro(dbc::PROGRAM_ID, false),
                ro(dbc_events, false),
                ro(dbc::PROGRAM_ID, false),
                ro(solana_instructions_sysvar_id(), false),
            ],
            data,
        };
        let settle = fair_open::accounts::Settle {
            program_config: program_config_address(),
            launch: launch.launch,
            vault: launch.vault,
            pot,
            pot_coins,
            keeper,
            mint: *mint,
            pool: c.pool,
            dbc_config: self.dbc_config,
            coin_record: coin_record_address(mint),
            coin_registrar: Pubkey::find_program_address(&[fair_open::COIN_REGISTRAR_SEED], &fair_open::id()).0,
            fee_config: fee_config_address(),
            fee_event_authority: Pubkey::find_program_address(&[b"__event_authority"], &fee::id()).0,
            fee_program: fee::id(),
            token_program: TOKEN_PROGRAM,
            system_program: system_program::ID,
            event_authority: event_authority(),
            program: fair_open::id(),
        };
        let settle = instruction(settle.to_account_metas(None), fair_open::instruction::Settle {}.data());
        vec![open, init, coins, swap, settle]
    }

    /// Sends a creation transaction, our keeper paying and signing with the creator and the coin's mint key.
    pub fn send_creation(
        &mut self,
        ixs: &[Instruction],
        mint: &Keypair,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let (keeper, creator) = (self.keeper.insecure_clone(), self.creator.insecure_clone());
        send_as(&mut self.svm, ixs, &keeper, &[&creator, mint])
    }

    /// Opens `launch` on `rung` with its sealed coin, `Coin::new("TEST")`, at the clock's current time.
    pub fn open(
        &mut self,
        launch: &LaunchKeys,
        rung: u64,
    ) -> Result<(TransactionMetadata, CoinKeys), FailedTransactionMetadata> {
        let mint = Keypair::new();
        let ixs = self.creation_instructions(launch, rung, &mint.pubkey(), &Coin::new("TEST"));
        let done = self.send_creation(&ixs, &mint)?;
        Ok((done, CoinKeys::of(&self.dbc_config, &mint.pubkey())))
    }

    /// A push of `seats`, each the seat, its wallet and the wallet's associated account of the coin, sent by a stranger.
    pub fn push(
        &mut self,
        launch: &LaunchKeys,
        mint: &Pubkey,
        seats: &[&Depositor],
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let wallets: Vec<(Pubkey, Pubkey)> = seats.iter().map(|d| (d.seat(launch), d.wallet.pubkey())).collect();
        let ix = self.push_instruction(launch, mint, &wallets);
        self.send(&[compute_unit_limit(1_400_000), ix], &[])
    }

    /// A push of seats given as (seat, wallet) pairs.
    pub fn push_instruction(&self, launch: &LaunchKeys, mint: &Pubkey, seats: &[(Pubkey, Pubkey)]) -> Instruction {
        let accounts = fair_open::accounts::Push {
            launch: launch.launch,
            vault: launch.vault,
            pot_coins: associated_address(&launch.launch, mint),
            mint: *mint,
            payer: self.payer.pubkey(),
            token_program: TOKEN_PROGRAM,
            associated_token_program: ASSOCIATED_TOKEN_PROGRAM,
            system_program: system_program::ID,
            event_authority: event_authority(),
            program: fair_open::id(),
        };
        let mut metas = accounts.to_account_metas(None);
        for (seat, wallet) in seats {
            metas.push(AccountMeta::new(*seat, false));
            metas.push(AccountMeta::new(*wallet, false));
            metas.push(AccountMeta::new(associated_address(wallet, mint), false));
        }
        instruction(metas, fair_open::instruction::Push {}.data())
    }

    /// The depositor's own claim, into `coin_account`.
    pub fn claim(
        &mut self,
        launch: &LaunchKeys,
        mint: &Pubkey,
        d: &Depositor,
        coin_account: &Pubkey,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let accounts = fair_open::accounts::Claim {
            launch: launch.launch,
            vault: launch.vault,
            seat: d.seat(launch),
            wallet: d.wallet.pubkey(),
            coin_account: *coin_account,
            pot_coins: associated_address(&launch.launch, mint),
            mint: *mint,
            token_program: TOKEN_PROGRAM,
            event_authority: event_authority(),
            program: fair_open::id(),
        };
        let ix = instruction(accounts.to_account_metas(None), fair_open::instruction::Claim {}.data());
        send_as(&mut self.svm, &[ix], &d.wallet, &[])
    }

    /// The Creator lock of `creator`'s seat, sent by a stranger.
    pub fn lock_creator(
        &mut self,
        launch: &LaunchKeys,
        coin: &CoinKeys,
        creator: &Depositor,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let ix = self.lock_creator_instruction(launch, coin, &creator.seat(launch));
        self.send(&[compute_unit_limit(400_000), ix], &[])
    }

    pub fn lock_creator_instruction(&self, launch: &LaunchKeys, coin: &CoinKeys, seat: &Pubkey) -> Instruction {
        let locker = locker_address(&launch.launch);
        let escrow = escrow_address(&locker);
        let accounts = fair_open::accounts::LockCreator {
            launch: launch.launch,
            vault: launch.vault,
            seat: *seat,
            creator: self.creator.pubkey(),
            pool: coin.pool,
            pot_coins: associated_address(&launch.launch, &coin.mint),
            mint: coin.mint,
            locker,
            escrow,
            escrow_coins: associated_address(&escrow, &coin.mint),
            lock_event_authority: fair_open::jupiter_lock::EVENT_AUTHORITY,
            lock_program: fair_open::jupiter_lock::PROGRAM_ID,
            token_program: TOKEN_PROGRAM,
            associated_token_program: ASSOCIATED_TOKEN_PROGRAM,
            system_program: system_program::ID,
            event_authority: event_authority(),
            program: fair_open::id(),
        };
        instruction(accounts.to_account_metas(None), fair_open::instruction::LockCreator {}.data())
    }

    /// The Tax Share's collection, sent by a stranger.
    pub fn collect_tax_share(
        &mut self,
        launch: &LaunchKeys,
        coin: &CoinKeys,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let ix = self.collect_tax_share_instruction(launch, coin);
        self.send(&[compute_unit_limit(400_000), ix], &[])
    }

    pub fn collect_tax_share_instruction(&self, launch: &LaunchKeys, coin: &CoinKeys) -> Instruction {
        let dbc_pda = |seed: &[u8]| Pubkey::find_program_address(&[seed], &dbc::PROGRAM_ID).0;
        let accounts = fair_open::accounts::CollectTaxShare {
            program_config: program_config_address(),
            launch: launch.launch,
            vault: launch.vault,
            pot: pot_address(&launch.launch),
            quote_mint: fair_open::NATIVE_MINT,
            treasury: self.treasury(),
            coin_registrar: Pubkey::find_program_address(&[fair_open::COIN_REGISTRAR_SEED], &fair_open::id()).0,
            fee_config: fee_config_address(),
            coin_record: coin_record_address(&coin.mint),
            fee_claimer: fee::FEE_CLAIMER,
            fee_claimer_token_account: associated_address(&fee::FEE_CLAIMER, &fair_open::NATIVE_MINT),
            pool_authority: dbc_pda(b"pool_authority"),
            dbc_config: self.dbc_config,
            pool: coin.pool,
            base_vault: coin.base_vault,
            quote_vault: coin.quote_vault,
            mint: coin.mint,
            token_base_program: TOKEN_PROGRAM,
            dbc_event_authority: dbc_pda(b"__event_authority"),
            dbc_program: dbc::PROGRAM_ID,
            fee_event_authority: Pubkey::find_program_address(&[b"__event_authority"], &fee::id()).0,
            fee_program: fee::id(),
            token_program: TOKEN_PROGRAM,
            system_program: system_program::ID,
            event_authority: event_authority(),
            program: fair_open::id(),
        };
        instruction(accounts.to_account_metas(None), fair_open::instruction::CollectTaxShare {}.data())
    }

    /// A push of the Tax Share to `seats`, given as (seat, wallet) pairs, sent by a stranger.
    pub fn push_tax_share(
        &mut self,
        launch: &LaunchKeys,
        seats: &[(Pubkey, Pubkey)],
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let accounts = fair_open::accounts::PushTaxShare {
            launch: launch.launch,
            vault: launch.vault,
            event_authority: event_authority(),
            program: fair_open::id(),
        };
        let mut metas = accounts.to_account_metas(None);
        for (seat, wallet) in seats {
            metas.push(AccountMeta::new(*seat, false));
            metas.push(AccountMeta::new(*wallet, false));
        }
        let ix = instruction(metas, fair_open::instruction::PushTaxShare {}.data());
        self.send(&[compute_unit_limit(1_400_000), ix], &[])
    }

    /// Heat's treasury, as the fee program's settings name it.
    pub fn treasury(&self) -> Pubkey {
        self.read::<fee::FeeConfig>(&fee_config_address()).treasury
    }

    /// A buy of `amount` lamports on the coin's pool by a new wallet, after the pot's: our stand-in charges it the
    /// sniper tax's cliff, the partner's share of which accrues in the pool as the window's fees.
    pub fn snipe(&mut self, coin: &CoinKeys, amount: u64) -> TransactionMetadata {
        let buyer = Keypair::new();
        self.svm.airdrop(&buyer.pubkey(), SOL).unwrap();
        let wsol = Pubkey::new_unique();
        let rent = self.rent(165);
        let mut data = token_account_data(&fair_open::NATIVE_MINT, &buyer.pubkey(), amount);
        // A wrapped-SOL account: `is_native`, its rent-exempt reserve.
        data[109..113].copy_from_slice(&1u32.to_le_bytes());
        data[113..121].copy_from_slice(&rent.to_le_bytes());
        let account = solana_account::Account {
            lamports: rent + amount,
            data,
            owner: TOKEN_PROGRAM,
            executable: false,
            rent_epoch: 0,
        };
        self.svm.set_account(wsol, account).unwrap();
        let coins = Pubkey::new_unique();
        self.set_account(coins, token_account_data(&coin.mint, &buyer.pubkey(), 0), TOKEN_PROGRAM);
        let dbc_pda = |seed: &[u8]| Pubkey::find_program_address(&[seed], &dbc::PROGRAM_ID).0;
        let (ro, rw) = (AccountMeta::new_readonly, AccountMeta::new);
        let mut data = dbc::SWAP2.to_vec();
        data.extend(amount.to_le_bytes());
        data.extend(1u64.to_le_bytes());
        data.push(0);
        let swap = Instruction {
            program_id: dbc::PROGRAM_ID,
            accounts: vec![
                ro(dbc_pda(b"pool_authority"), false),
                ro(self.dbc_config, false),
                rw(coin.pool, false),
                rw(wsol, false),
                rw(coins, false),
                rw(coin.base_vault, false),
                rw(coin.quote_vault, false),
                ro(coin.mint, false),
                ro(fair_open::NATIVE_MINT, false),
                ro(buyer.pubkey(), true),
                ro(TOKEN_PROGRAM, false),
                ro(TOKEN_PROGRAM, false),
                ro(dbc::PROGRAM_ID, false),
                ro(dbc_pda(b"__event_authority"), false),
                ro(dbc::PROGRAM_ID, false),
            ],
            data,
        };
        send_as(&mut self.svm, &[swap], &buyer, &[]).unwrap()
    }

    /// The partner's quote fee accrued in the coin's pool and not yet claimed.
    pub fn partner_quote_fee(&self, coin: &CoinKeys) -> u64 {
        let pool = self.svm.get_account(&coin.pool).unwrap();
        u64::from_le_bytes(pool.data[dbc::POOL_PARTNER_QUOTE_FEE_OFFSET..][..8].try_into().unwrap())
    }

    /// The tokens a token account holds, or none if it does not exist.
    pub fn tokens(&self, account: &Pubkey) -> Option<u64> {
        let account = self.svm.get_account(account).filter(|a| a.owner == TOKEN_PROGRAM && a.data.len() == 165)?;
        Some(u64::from_le_bytes(account.data[64..72].try_into().unwrap()))
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

    /// What the open's accounts cost, which the creator prepays at scheduling.
    pub fn open_rent(&self) -> u64 {
        fair_open::open_rent(&self.svm.get_sysvar::<Rent>())
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

/// A DBC `PoolConfig` as DBC lays it out, with only what our programs read filled in: its quote, its fee claimer, the
/// fee program's PDA, and its Graduation Target.
pub fn dbc_config_data(quote_mint: &Pubkey, graduation_target: u64) -> Vec<u8> {
    let mut data = vec![0u8; 1048];
    data[..8].copy_from_slice(&dbc::POOL_CONFIG_DISCRIMINATOR);
    data[dbc::CONFIG_QUOTE_MINT_OFFSET..][..32].copy_from_slice(quote_mint.as_ref());
    data[40..72].copy_from_slice(fee::FEE_CLAIMER.as_ref());
    data[dbc::CONFIG_MIGRATION_QUOTE_THRESHOLD_OFFSET..][..8].copy_from_slice(&graduation_target.to_le_bytes());
    data
}

/// An initialized SPL Token account of `mint`, owned by `owner`, holding `amount`.
pub fn token_account_data(mint: &Pubkey, owner: &Pubkey, amount: u64) -> Vec<u8> {
    let mut data = vec![0u8; 165];
    data[..32].copy_from_slice(mint.as_ref());
    data[32..64].copy_from_slice(owner.as_ref());
    data[64..72].copy_from_slice(&amount.to_le_bytes());
    data[108] = 1;
    data
}

/// A launch's creator locker, the Creator lock escrow's base and sender.
pub fn locker_address(launch: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[fair_open::CREATOR_LOCK_SEED, launch.as_ref()], &fair_open::id()).0
}

/// Jupiter Lock's escrow of `base`.
pub fn escrow_address(base: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[fair_open::jupiter_lock::ESCROW_SEED, base.as_ref()],
        &fair_open::jupiter_lock::PROGRAM_ID,
    )
    .0
}

/// An SPL mint with no authorities, of `decimals`.
pub fn mint_data(decimals: u8) -> Vec<u8> {
    let mut data = vec![0u8; 82];
    data[44] = decimals;
    data[45] = 1;
    data
}

/// A wallet's associated account of `mint`.
pub fn associated_address(owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[owner.as_ref(), TOKEN_PROGRAM.as_ref(), mint.as_ref()], &ASSOCIATED_TOKEN_PROGRAM).0
}

pub fn fee_config_address() -> Pubkey {
    Pubkey::find_program_address(&[fee::FEE_CONFIG_SEED], &fee::id()).0
}

pub fn coin_record_address(mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[fee::COIN_RECORD_SEED, mint.as_ref()], &fee::id()).0
}

pub fn pot_address(launch: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[fair_open::POT_SEED, launch.as_ref()], &fair_open::id()).0
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

/// The compute budget program's `SetComputeUnitLimit`.
pub fn compute_unit_limit(units: u32) -> Instruction {
    let mut data = vec![2];
    data.extend_from_slice(&units.to_le_bytes());
    Instruction { program_id: fair_open::creation::COMPUTE_BUDGET_PROGRAM, accounts: vec![], data }
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
