//! The creation transaction's shape (spec 2.1 step 10, ADR 0005). The open checks, by instruction introspection, that
//! the transaction it runs in is exactly the one a rung of the creator's ladder holds, so a rung can do nothing but its
//! one open, and the pot's delegate can fund nothing but the pool's first swap:
//!
//! 1. any durable nonce advances and compute budget instructions, and nothing else;
//! 2. this program's `open`;
//! 3. DBC's `initialize_virtual_pool_with_spl_token` on the launch's config, the Creator wallet signing as `creator` and
//!    our keeper paying, for the coin sealed behind the launch's identity hash;
//! 4. the Associated Token Account program creating the launch's own account of the new coin, the pot's coin account,
//!    our keeper paying;
//! 5. DBC's `swap2`, top-level and exact in, spending exactly the rung from the pot's wrapped-SOL account through our
//!    keeper as its delegate, into the pot's coin account, with no referral and with the instructions sysvar: DBC gives
//!    the first-swap discount only to a top-level swap after its pool's creation, with the sysvar and no referral;
//! 6. this program's `settle`, last.
use {
    crate::{dbc, FairOpenError, TOKEN_PROGRAM},
    anchor_lang::{prelude::*, solana_program::instruction::Instruction, system_program, Discriminator},
    solana_instructions_sysvar::load_instruction_at_checked,
    solana_sha256_hasher::hash,
};

pub const COMPUTE_BUDGET_PROGRAM: Pubkey = pubkey!("ComputeBudget111111111111111111111111111111");
pub const ASSOCIATED_TOKEN_PROGRAM: Pubkey = pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
/// The system program's `AdvanceNonceAccount`: instruction 4, a little-endian `u32`.
const ADVANCE_NONCE: [u8; 4] = [4, 0, 0, 0];
/// DBC's `swap2` instruction data: the discriminator, then `SwapParameters2`'s `amount_0` (exact in: the amount in),
/// `amount_1` (the least out) and `swap_mode` (0, exact in).
const SWAP2_DATA_LEN: usize = 8 + 8 + 8 + 1;
/// `swap2`'s accounts, in DBC's order, and the instructions sysvar after them as its one remaining account.
mod swap2 {
    pub const CONFIG: usize = 1;
    pub const POOL: usize = 2;
    pub const INPUT: usize = 3;
    pub const OUTPUT: usize = 4;
    pub const BASE_MINT: usize = 7;
    pub const QUOTE_MINT: usize = 8;
    pub const PAYER: usize = 9;
    pub const REFERRAL: usize = 12;
    pub const INSTRUCTIONS_SYSVAR: usize = 15;
    pub const ACCOUNTS: usize = 16;
}
/// `initialize_virtual_pool_with_spl_token`'s accounts this check reads, in DBC's order.
mod init {
    pub const CONFIG: usize = 0;
    pub const CREATOR: usize = 2;
    pub const BASE_MINT: usize = 3;
    pub const QUOTE_MINT: usize = 4;
    pub const POOL: usize = 5;
    pub const PAYER: usize = 10;
}
/// The Associated Token Account program's `Create` and `CreateIdempotent` accounts.
mod account {
    pub const PAYER: usize = 0;
    pub const ADDRESS: usize = 1;
    pub const OWNER: usize = 2;
    pub const MINT: usize = 3;
    pub const TOKEN_PROGRAM: usize = 5;
}

/// What the open expects of its transaction, from the launch and the rung.
pub struct Expect {
    pub launch: Pubkey,
    pub dbc_config: Pubkey,
    pub creator: Pubkey,
    pub keeper: Pubkey,
    pub quote_mint: Pubkey,
    /// The pot's wrapped-SOL account, which the swap spends from.
    pub pot: Pubkey,
    pub identity_hash: [u8; 32],
    pub rung: u64,
}

/// What the open learns from its transaction: the coin, its pool and the pot's coin account.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Found {
    pub mint: Pubkey,
    pub pool: Pubkey,
    pub pot_coins: Pubkey,
}

/// Why a transaction is not the creation transaction; the open logs it before refusing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Shape {
    /// Instruction `n`, before the open, is neither a nonce advance nor a compute budget instruction.
    BeforeOpen(usize),
    MissingInit,
    InitConfig,
    InitCreator,
    InitQuote,
    InitPayer,
    /// The coin's name, ticker or metadata URI is not the one sealed at scheduling.
    Identity,
    MissingPotCoins,
    PotCoins,
    MissingSwap,
    /// The swap's account at index `n` is not the one expected, or it has the wrong number of accounts.
    SwapAccount(usize),
    SwapData,
    SwapAmount,
    SwapMode,
    MissingSettle,
    /// Something follows `settle`.
    Trailing,
}

impl From<Shape> for Error {
    fn from(shape: Shape) -> Error {
        msg!("Not the creation transaction: {:?}", shape);
        match shape {
            Shape::Identity => FairOpenError::IdentityMismatch.into(),
            _ => FairOpenError::NotTheCreationTransaction.into(),
        }
    }
}

/// Checks the transaction this instruction runs in, read from the instructions sysvar: the open is instruction
/// `open_at`.
pub fn check_transaction(sysvar: &AccountInfo, open_at: usize, e: &Expect) -> Result<Found> {
    let count = {
        let data = sysvar.try_borrow_data()?;
        u16::from_le_bytes(data.get(..2).ok_or(FairOpenError::NotTheCreationTransaction)?.try_into().unwrap()) as usize
    };
    let instructions =
        (0..count).map(|i| load_instruction_at_checked(i, sysvar)).collect::<core::result::Result<Vec<_>, _>>()?;
    Ok(check(&instructions, open_at, e)?)
}

/// Checks a transaction's instructions; the open is instruction `open_at`.
pub fn check(ixs: &[Instruction], open_at: usize, e: &Expect) -> core::result::Result<Found, Shape> {
    for (i, ix) in ixs[..open_at].iter().enumerate() {
        let allowed = ix.program_id == COMPUTE_BUDGET_PROGRAM
            || (ix.program_id == system_program::ID && ix.data.as_slice() == ADVANCE_NONCE.as_slice());
        if !allowed {
            return Err(Shape::BeforeOpen(i));
        }
    }
    let at = |n: usize| ixs.get(open_at + n);
    let key = |ix: &Instruction, n: usize| ix.accounts.get(n).map(|a| a.pubkey);

    let init = at(1)
        .filter(|ix| ix.program_id == dbc::PROGRAM_ID && ix.data.starts_with(&dbc::INITIALIZE_POOL_WITH_SPL_TOKEN))
        .ok_or(Shape::MissingInit)?;
    if key(init, init::CONFIG) != Some(e.dbc_config) {
        return Err(Shape::InitConfig);
    }
    if !init.accounts.get(init::CREATOR).is_some_and(|a| a.pubkey == e.creator && a.is_signer) {
        return Err(Shape::InitCreator);
    }
    if key(init, init::QUOTE_MINT) != Some(e.quote_mint) {
        return Err(Shape::InitQuote);
    }
    if key(init, init::PAYER) != Some(e.keeper) {
        return Err(Shape::InitPayer);
    }
    let (Some(mint), Some(pool)) = (key(init, init::BASE_MINT), key(init, init::POOL)) else {
        return Err(Shape::MissingInit);
    };
    // The coin's identity: the hash of DBC's pool parameters (name, ticker, URI) exactly as this instruction carries them.
    if hash(&init.data[8..]).to_bytes() != e.identity_hash {
        return Err(Shape::Identity);
    }

    let coins = at(2).filter(|ix| ix.program_id == ASSOCIATED_TOKEN_PROGRAM).ok_or(Shape::MissingPotCoins)?;
    // `Create` (no data, or 0) or `CreateIdempotent` (1), of the launch's own account of the new coin.
    let create = coins.data.is_empty() || coins.data.as_slice() == [0] || coins.data.as_slice() == [1];
    if !create
        || key(coins, account::PAYER) != Some(e.keeper)
        || key(coins, account::OWNER) != Some(e.launch)
        || key(coins, account::MINT) != Some(mint)
        || key(coins, account::TOKEN_PROGRAM) != Some(TOKEN_PROGRAM)
    {
        return Err(Shape::PotCoins);
    }
    let pot_coins = key(coins, account::ADDRESS).ok_or(Shape::PotCoins)?;

    let swap = at(3)
        .filter(|ix| ix.program_id == dbc::PROGRAM_ID && ix.data.starts_with(&dbc::SWAP2))
        .ok_or(Shape::MissingSwap)?;
    let expected = [
        (swap2::CONFIG, e.dbc_config),
        (swap2::POOL, pool),
        (swap2::INPUT, e.pot),
        (swap2::OUTPUT, pot_coins),
        (swap2::BASE_MINT, mint),
        (swap2::QUOTE_MINT, e.quote_mint),
        (swap2::PAYER, e.keeper),
        // Anchor names an optional account left out by the program's own id: no referral.
        (swap2::REFERRAL, dbc::PROGRAM_ID),
        (swap2::INSTRUCTIONS_SYSVAR, solana_instructions_sysvar::ID),
    ];
    for (n, expected) in expected {
        if key(swap, n) != Some(expected) {
            return Err(Shape::SwapAccount(n));
        }
    }
    if swap.accounts.len() != swap2::ACCOUNTS {
        return Err(Shape::SwapAccount(swap2::ACCOUNTS));
    }
    if swap.data.len() != SWAP2_DATA_LEN {
        return Err(Shape::SwapData);
    }
    if u64::from_le_bytes(swap.data[8..16].try_into().unwrap()) != e.rung {
        return Err(Shape::SwapAmount);
    }
    if swap.data[24] != 0 {
        return Err(Shape::SwapMode);
    }

    at(4)
        .filter(|ix| ix.program_id == crate::ID && ix.data.starts_with(crate::instruction::Settle::DISCRIMINATOR))
        .ok_or(Shape::MissingSettle)?;
    if ixs.len() != open_at + 5 {
        return Err(Shape::Trailing);
    }
    Ok(Found { mint, pool, pot_coins })
}

#[cfg(test)]
mod tests {
    use {super::*, anchor_lang::solana_program::instruction::AccountMeta};

    fn k(n: u8) -> Pubkey {
        Pubkey::new_from_array([n; 32])
    }
    fn ro(p: Pubkey) -> AccountMeta {
        AccountMeta::new_readonly(p, false)
    }

    const PARAMS: &[u8] = b"\x04\0\0\0Coin\x04\0\0\0COIN\x03\0\0\0uri";

    struct Fx {
        e: Expect,
        mint: Pubkey,
        pool: Pubkey,
        pot_coins: Pubkey,
    }

    fn fx() -> Fx {
        Fx {
            e: Expect {
                launch: k(1),
                dbc_config: k(2),
                creator: k(3),
                keeper: k(4),
                quote_mint: k(5),
                pot: k(6),
                identity_hash: hash(PARAMS).to_bytes(),
                rung: 1_615_000_000,
            },
            mint: k(7),
            pool: k(8),
            pot_coins: k(9),
        }
    }

    fn ours(discriminator: &[u8]) -> Instruction {
        Instruction { program_id: crate::ID, accounts: vec![], data: discriminator.to_vec() }
    }

    fn init(f: &Fx) -> Instruction {
        let mut accounts: Vec<AccountMeta> = (0..16).map(|n| ro(k(30 + n))).collect();
        accounts[init::CONFIG] = ro(f.e.dbc_config);
        accounts[init::CREATOR] = AccountMeta::new_readonly(f.e.creator, true);
        accounts[init::BASE_MINT] = AccountMeta::new(f.mint, true);
        accounts[init::QUOTE_MINT] = ro(f.e.quote_mint);
        accounts[init::POOL] = AccountMeta::new(f.pool, false);
        accounts[init::PAYER] = AccountMeta::new(f.e.keeper, true);
        let data = [dbc::INITIALIZE_POOL_WITH_SPL_TOKEN.as_slice(), PARAMS].concat();
        Instruction { program_id: dbc::PROGRAM_ID, accounts, data }
    }

    fn pot_coins(f: &Fx) -> Instruction {
        let accounts = vec![
            AccountMeta::new(f.e.keeper, true),
            AccountMeta::new(f.pot_coins, false),
            ro(f.e.launch),
            ro(f.mint),
            ro(system_program::ID),
            ro(TOKEN_PROGRAM),
        ];
        Instruction { program_id: ASSOCIATED_TOKEN_PROGRAM, accounts, data: vec![1] }
    }

    fn swap(f: &Fx, amount: u64, mode: u8) -> Instruction {
        let mut accounts: Vec<AccountMeta> = (0..16).map(|n| ro(k(50 + n))).collect();
        accounts[swap2::CONFIG] = ro(f.e.dbc_config);
        accounts[swap2::POOL] = AccountMeta::new(f.pool, false);
        accounts[swap2::INPUT] = AccountMeta::new(f.e.pot, false);
        accounts[swap2::OUTPUT] = AccountMeta::new(f.pot_coins, false);
        accounts[swap2::BASE_MINT] = ro(f.mint);
        accounts[swap2::QUOTE_MINT] = ro(f.e.quote_mint);
        accounts[swap2::PAYER] = AccountMeta::new_readonly(f.e.keeper, true);
        accounts[swap2::REFERRAL] = ro(dbc::PROGRAM_ID);
        accounts[swap2::INSTRUCTIONS_SYSVAR] = ro(solana_instructions_sysvar::ID);
        let mut data = dbc::SWAP2.to_vec();
        data.extend(amount.to_le_bytes());
        data.extend(1u64.to_le_bytes());
        data.push(mode);
        Instruction { program_id: dbc::PROGRAM_ID, accounts, data }
    }

    fn good(f: &Fx) -> Vec<Instruction> {
        vec![
            Instruction { program_id: system_program::ID, accounts: vec![], data: ADVANCE_NONCE.to_vec() },
            Instruction { program_id: COMPUTE_BUDGET_PROGRAM, accounts: vec![], data: vec![2, 0, 0, 0, 0] },
            ours(crate::instruction::Open::DISCRIMINATOR),
            init(f),
            pot_coins(f),
            swap(f, f.e.rung, 0),
            ours(crate::instruction::Settle::DISCRIMINATOR),
        ]
    }

    fn checked(f: &Fx, ixs: &[Instruction]) -> core::result::Result<Found, Shape> {
        let open_at = ixs.iter().position(|ix| ix.data.starts_with(crate::instruction::Open::DISCRIMINATOR)).unwrap();
        check(ixs, open_at, &f.e)
    }

    #[test]
    fn accepts_the_creation_transaction() {
        let f = fx();
        assert_eq!(checked(&f, &good(&f)), Ok(Found { mint: f.mint, pool: f.pool, pot_coins: f.pot_coins }));
        // A nonce advance and a compute budget are allowed, not needed: the creator may sign at the open instead.
        assert!(checked(&f, &good(&f)[2..]).is_ok());
    }

    #[test]
    fn refuses_anything_before_the_open_but_a_nonce_advance_or_a_compute_budget() {
        let f = fx();
        let mut ixs = good(&f);
        ixs.insert(1, Instruction { program_id: TOKEN_PROGRAM, accounts: vec![], data: vec![3] });
        assert_eq!(checked(&f, &ixs), Err(Shape::BeforeOpen(1)));
        let mut ixs = good(&f);
        // Any other system instruction, such as a transfer (2).
        ixs[0].data = vec![2, 0, 0, 0];
        assert_eq!(checked(&f, &ixs), Err(Shape::BeforeOpen(0)));
    }

    #[test]
    fn refuses_another_config_creator_quote_or_payer() {
        let f = fx();
        let refused = |edit: &dyn Fn(&mut Instruction), shape| {
            let mut ixs = good(&f);
            edit(&mut ixs[3]);
            assert_eq!(checked(&f, &ixs), Err(shape));
        };
        refused(&|ix| ix.accounts[init::CONFIG].pubkey = k(99), Shape::InitConfig);
        refused(&|ix| ix.accounts[init::CREATOR].pubkey = k(99), Shape::InitCreator);
        refused(&|ix| ix.accounts[init::CREATOR].is_signer = false, Shape::InitCreator);
        refused(&|ix| ix.accounts[init::QUOTE_MINT].pubkey = k(99), Shape::InitQuote);
        refused(&|ix| ix.accounts[init::PAYER].pubkey = k(99), Shape::InitPayer);
    }

    #[test]
    fn refuses_a_coin_other_than_the_sealed_one() {
        let f = fx();
        let mut ixs = good(&f);
        let last = ixs[3].data.len() - 1;
        ixs[3].data[last] = b'x';
        assert_eq!(checked(&f, &ixs), Err(Shape::Identity));
    }

    #[test]
    fn refuses_a_pot_coin_account_someone_else_owns_or_pays_for() {
        let f = fx();
        for (n, shape) in
            [(account::OWNER, Shape::PotCoins), (account::MINT, Shape::PotCoins), (account::PAYER, Shape::PotCoins)]
        {
            let mut ixs = good(&f);
            ixs[4].accounts[n].pubkey = k(99);
            assert_eq!(checked(&f, &ixs), Err(shape), "account {n}");
        }
        let mut ixs = good(&f);
        ixs.remove(4);
        assert_eq!(checked(&f, &ixs), Err(Shape::MissingPotCoins));
    }

    #[test]
    fn refuses_a_swap_that_is_not_the_pots_exact_buy() {
        let f = fx();
        let mut ixs = good(&f);
        ixs[5] = swap(&f, f.e.rung + 1, 0);
        assert_eq!(checked(&f, &ixs), Err(Shape::SwapAmount));
        ixs[5] = swap(&f, f.e.rung, 1);
        assert_eq!(checked(&f, &ixs), Err(Shape::SwapMode));
        for n in [swap2::INPUT, swap2::OUTPUT, swap2::PAYER, swap2::POOL, swap2::REFERRAL, swap2::INSTRUCTIONS_SYSVAR] {
            let mut ixs = good(&f);
            ixs[5].accounts[n].pubkey = k(99);
            assert_eq!(checked(&f, &ixs), Err(Shape::SwapAccount(n)), "account {n}");
        }
        // Without the instructions sysvar DBC charges the pot the 99% cliff.
        let mut ixs = good(&f);
        ixs[5].accounts.pop();
        assert_eq!(checked(&f, &ixs), Err(Shape::SwapAccount(swap2::INSTRUCTIONS_SYSVAR)));
    }

    #[test]
    fn refuses_another_buy_slipped_in_or_anything_after_settle() {
        let f = fx();
        let mut ixs = good(&f);
        ixs.insert(5, swap(&f, 1, 0));
        assert_eq!(checked(&f, &ixs), Err(Shape::SwapAmount));
        let mut ixs = good(&f);
        ixs.insert(6, Instruction { program_id: TOKEN_PROGRAM, accounts: vec![ro(f.e.pot)], data: vec![3] });
        assert_eq!(checked(&f, &ixs), Err(Shape::MissingSettle));
        let mut ixs = good(&f);
        ixs.push(swap(&f, 1, 0));
        assert_eq!(checked(&f, &ixs), Err(Shape::Trailing));
    }
}
