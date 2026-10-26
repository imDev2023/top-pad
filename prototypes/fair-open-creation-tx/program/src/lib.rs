//! PROTOTYPE, throwaway (ticket #31). The Fair Open pot program, reduced to what the creation
//! transaction needs. It is NOT deployed (the devnet wallet had too little SOL): it is built to
//! measure its size, and `check_creation_tx` (the transaction check `open` runs) is unit-tested
//! natively below. Deposit caps, personhood and revocation belong to ticket #28. Never audited.
use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::Instruction,
    pubkey,
    sysvar::instructions::{load_current_index_checked, load_instruction_at_checked},
};
use anchor_lang::Discriminator;
use anchor_spl::token::{self, Approve, Mint, Revoke, SyncNative, Token, TokenAccount, Transfer};

declare_id!("GpUeEpdPZSWZRWCornEzPHXfCyejZCGcv3nrsUgqScbE");

pub const DBC: Pubkey = pubkey!("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");
pub const ATA_PROGRAM: Pubkey = pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
pub const COMPUTE_BUDGET: Pubkey = pubkey!("ComputeBudget111111111111111111111111111111");
pub const NATIVE_MINT: Pubkey = pubkey!("So11111111111111111111111111111111111111112");
/// DBC `initialize_virtual_pool_with_spl_token` and `swap2` discriminators, from the SDK's IDL.
pub const DBC_INIT_SPL: [u8; 8] = [140, 85, 215, 176, 102, 54, 104, 79];
pub const DBC_SWAP2: [u8; 8] = [65, 75, 63, 76, 235, 91, 91, 136];
/// System program `AdvanceNonceAccount` (instruction index 4, little-endian u32).
const NONCE_ADVANCE: [u8; 4] = [4, 0, 0, 0];

const WINDOW: u8 = 0;
const OPENING: u8 = 1;
const SETTLED: u8 = 2;

#[program]
pub mod fair_open {
    use super::*;

    /// The creator registers a Fair Open: who must sign the DBC init, which keeper opens it,
    /// on which DBC config, the most the pot may spend, and when it opens.
    pub fn create_launch(ctx: Context<CreateLaunch>, id: u64, cap: u64, opens_at: i64) -> Result<()> {
        require!(*ctx.accounts.dbc_config.owner == DBC, FairOpenError::NotDbcConfig);
        let l = &mut ctx.accounts.launch;
        l.id = id;
        l.creator = ctx.accounts.creator.key();
        l.crank = ctx.accounts.crank.key();
        l.dbc_config = ctx.accounts.dbc_config.key();
        l.cap = cap;
        l.opens_at = opens_at;
        l.state = WINDOW;
        l.bump = ctx.bumps.launch;
        Ok(())
    }

    /// One deposit per wallet in this prototype; caps and personhood are ticket #28's.
    pub fn deposit(ctx: Context<DepositSol>, amount: u64) -> Result<()> {
        let l = &mut ctx.accounts.launch;
        require!(l.state == WINDOW, FairOpenError::WrongState);
        require!(Clock::get()?.unix_timestamp < l.opens_at, FairOpenError::WindowClosed);
        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.depositor.to_account_info(),
                    to: ctx.accounts.pot_wsol.to_account_info(),
                },
            ),
            amount,
        )?;
        token::sync_native(CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            SyncNative { account: ctx.accounts.pot_wsol.to_account_info() },
        ))?;
        l.total_deposits = l.total_deposits.checked_add(amount).unwrap();
        let d = &mut ctx.accounts.deposit;
        d.launch = l.key();
        d.owner = ctx.accounts.depositor.key();
        d.amount = amount;
        d.bump = ctx.bumps.deposit;
        Ok(())
    }

    /// First instruction of the creation transaction. Checks the whole transaction's shape, then
    /// lets the keeper spend exactly `buy` from the pot as SPL delegate for the DBC swap.
    pub fn open(ctx: Context<Open>, buy: u64) -> Result<()> {
        let l = &ctx.accounts.launch;
        require!(l.state == WINDOW, FairOpenError::WrongState);
        require!(Clock::get()?.unix_timestamp >= l.opens_at, FairOpenError::NotYet);
        require!(buy > 0 && buy <= l.cap && buy <= ctx.accounts.pot_wsol.amount, FairOpenError::BadBuy);

        let sysvar = ctx.accounts.instructions.to_account_info();
        let current = load_current_index_checked(&sysvar)? as usize;
        let mut ixs = Vec::new();
        while let Ok(ix) = load_instruction_at_checked(ixs.len(), &sysvar) {
            ixs.push(ix);
        }
        let found = check_creation_tx(&ixs, current, &Expect {
            program_id: crate::ID,
            launch: l.key(),
            dbc_config: l.dbc_config,
            creator: l.creator,
            crank: l.crank,
            pot_wsol: ctx.accounts.pot_wsol.key(),
            buy,
        })
        .map_err(|e| {
            msg!("creation transaction rejected: {:?}", e);
            error!(FairOpenError::BadTransaction)
        })?;

        let id = l.id.to_le_bytes();
        let seeds: &[&[u8]] = &[b"launch", &id, &[l.bump]];
        token::approve(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Approve {
                    to: ctx.accounts.pot_wsol.to_account_info(),
                    delegate: ctx.accounts.crank.to_account_info(),
                    authority: ctx.accounts.launch.to_account_info(),
                },
                &[seeds],
            ),
            buy,
        )?;
        let l = &mut ctx.accounts.launch;
        l.state = OPENING;
        l.pool = found.pool;
        l.base_mint = found.base_mint;
        l.spent = buy;
        Ok(())
    }

    /// Last instruction of the creation transaction: clears the delegate and records the fill.
    pub fn settle(ctx: Context<Settle>) -> Result<()> {
        let l = &ctx.accounts.launch;
        require!(l.state == OPENING, FairOpenError::WrongState);
        require_keys_eq!(ctx.accounts.pot_coin.mint, l.base_mint, FairOpenError::BadAccount);
        let id = l.id.to_le_bytes();
        let seeds: &[&[u8]] = &[b"launch", &id, &[l.bump]];
        token::revoke(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Revoke { source: ctx.accounts.pot_wsol.to_account_info(), authority: ctx.accounts.launch.to_account_info() },
            &[seeds],
        ))?;
        // ExactIn spends exactly `buy`; anything else means the swap did not run as checked.
        require!(ctx.accounts.pot_wsol.amount == l.total_deposits - l.spent, FairOpenError::BadFill);
        require!(ctx.accounts.pot_coin.amount > 0, FairOpenError::BadFill);
        let l = &mut ctx.accounts.launch;
        l.coins = ctx.accounts.pot_coin.amount;
        l.refund_pool = ctx.accounts.pot_wsol.amount;
        l.state = SETTLED;
        Ok(())
    }

    /// Each depositor takes their pro-rata coins and their pro-rata share of the unspent deposits.
    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        let l = &ctx.accounts.launch;
        require!(l.state == SETTLED, FairOpenError::WrongState);
        let d = &ctx.accounts.deposit;
        require!(!d.claimed, FairOpenError::AlreadyClaimed);
        let share = |x: u64| ((x as u128) * (d.amount as u128) / (l.total_deposits as u128)) as u64;
        let (coins, refund) = (share(l.coins), share(l.refund_pool));
        let id = l.id.to_le_bytes();
        let seeds: &[&[u8]] = &[b"launch", &id, &[l.bump]];
        let tp = ctx.accounts.token_program.to_account_info();
        let auth = ctx.accounts.launch.to_account_info();
        token::transfer(CpiContext::new_with_signer(tp.clone(), Transfer {
            from: ctx.accounts.pot_coin.to_account_info(), to: ctx.accounts.depositor_coin.to_account_info(), authority: auth.clone(),
        }, &[seeds]), coins)?;
        if refund > 0 {
            token::transfer(CpiContext::new_with_signer(tp, Transfer {
                from: ctx.accounts.pot_wsol.to_account_info(), to: ctx.accounts.depositor_wsol.to_account_info(), authority: auth,
            }, &[seeds]), refund)?;
        }
        ctx.accounts.deposit.claimed = true;
        Ok(())
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum ShapeError {
    BeforeOpen(usize),
    NotOurOpen,
    MissingInit,
    InitConfig,
    InitCreator,
    PotCoinAccountOwner,
    MissingSwap,
    SwapPool,
    SwapInput,
    SwapAuthority,
    SwapAmount,
    SwapMode,
    SwapReferral,
    MissingSettle,
    TrailingInstructions,
}

pub struct Expect {
    pub program_id: Pubkey,
    pub launch: Pubkey,
    pub dbc_config: Pubkey,
    pub creator: Pubkey,
    pub crank: Pubkey,
    pub pot_wsol: Pubkey,
    pub buy: u64,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Found {
    pub pool: Pubkey,
    pub base_mint: Pubkey,
}

/// The creation transaction must be exactly:
/// `[nonce advance | compute budget]*, open, DBC init (our config, the registered creator signing),
///  [create the pot's coin ATA], DBC swap2 (pool from the init, pot in, crank as authority, ExactIn
///  `buy`, no referral), settle`, and nothing else, so the pot's delegate can only fund the first swap.
pub fn check_creation_tx(ixs: &[Instruction], open_at: usize, e: &Expect) -> core::result::Result<Found, ShapeError> {
    for (i, ix) in ixs[..open_at].iter().enumerate() {
        let ok = ix.program_id == COMPUTE_BUDGET
            || (ix.program_id == anchor_lang::system_program::ID && ix.data.starts_with(&NONCE_ADVANCE));
        if !ok {
            return Err(ShapeError::BeforeOpen(i));
        }
    }
    let is_ours = |ix: &Instruction, disc: &[u8]| ix.program_id == e.program_id && ix.data.starts_with(disc);
    if !ixs.get(open_at).is_some_and(|ix| is_ours(ix, crate::instruction::Open::DISCRIMINATOR)) {
        return Err(ShapeError::NotOurOpen);
    }
    let mut i = open_at + 1;
    let init = ixs.get(i).filter(|ix| ix.program_id == DBC && ix.data.starts_with(&DBC_INIT_SPL)).ok_or(ShapeError::MissingInit)?;
    if init.accounts.first().map(|a| a.pubkey) != Some(e.dbc_config) {
        return Err(ShapeError::InitConfig);
    }
    match init.accounts.get(2) {
        Some(a) if a.pubkey == e.creator && a.is_signer => {}
        _ => return Err(ShapeError::InitCreator),
    }
    let found = Found { base_mint: init.accounts[3].pubkey, pool: init.accounts[5].pubkey };
    i += 1;
    if let Some(ix) = ixs.get(i).filter(|ix| ix.program_id == ATA_PROGRAM) {
        // CreateIdempotent accounts: payer, ata, wallet, mint, system, token
        if ix.accounts.get(2).map(|a| a.pubkey) != Some(e.launch) || ix.accounts.get(3).map(|a| a.pubkey) != Some(found.base_mint) {
            return Err(ShapeError::PotCoinAccountOwner);
        }
        i += 1;
    }
    let swap = ixs.get(i).filter(|ix| ix.program_id == DBC && ix.data.starts_with(&DBC_SWAP2)).ok_or(ShapeError::MissingSwap)?;
    let acc = |n: usize| swap.accounts.get(n).map(|a| a.pubkey);
    if acc(2) != Some(found.pool) {
        return Err(ShapeError::SwapPool);
    }
    if acc(3) != Some(e.pot_wsol) {
        return Err(ShapeError::SwapInput);
    }
    if acc(9) != Some(e.crank) {
        return Err(ShapeError::SwapAuthority);
    }
    // SwapParameters2 { amount_0: u64, amount_1: u64, swap_mode: u8 }
    if swap.data.get(8..16).map(|b| u64::from_le_bytes(b.try_into().unwrap())) != Some(e.buy) {
        return Err(ShapeError::SwapAmount);
    }
    if swap.data.get(24) != Some(&0) {
        return Err(ShapeError::SwapMode);
    }
    if acc(12) != Some(DBC) {
        return Err(ShapeError::SwapReferral); // Anchor encodes "no referral" as the program id
    }
    i += 1;
    if !ixs.get(i).is_some_and(|ix| is_ours(ix, crate::instruction::Settle::DISCRIMINATOR)) {
        return Err(ShapeError::MissingSettle);
    }
    if ixs.len() != i + 1 {
        return Err(ShapeError::TrailingInstructions);
    }
    Ok(found)
}

#[account]
#[derive(InitSpace)]
pub struct Launch {
    pub id: u64,
    pub creator: Pubkey,
    pub crank: Pubkey,
    pub dbc_config: Pubkey,
    pub cap: u64,
    pub opens_at: i64,
    pub total_deposits: u64,
    pub spent: u64,
    pub coins: u64,
    pub refund_pool: u64,
    pub pool: Pubkey,
    pub base_mint: Pubkey,
    pub state: u8,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Deposit {
    pub launch: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
    pub claimed: bool,
    pub bump: u8,
}

#[derive(Accounts)]
#[instruction(id: u64)]
pub struct CreateLaunch<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub creator: Signer<'info>,
    /// CHECK: the keeper allowed to open this launch
    pub crank: UncheckedAccount<'info>,
    /// CHECK: owner checked to be DBC
    pub dbc_config: UncheckedAccount<'info>,
    #[account(init, payer = payer, space = 8 + Launch::INIT_SPACE, seeds = [b"launch", id.to_le_bytes().as_ref()], bump)]
    pub launch: Account<'info, Launch>,
    #[account(init, payer = payer, seeds = [b"pot", launch.key().as_ref()], bump, token::mint = native_mint, token::authority = launch)]
    pub pot_wsol: Account<'info, TokenAccount>,
    #[account(address = NATIVE_MINT)]
    pub native_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DepositSol<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,
    #[account(mut)]
    pub launch: Account<'info, Launch>,
    #[account(init, payer = depositor, space = 8 + Deposit::INIT_SPACE, seeds = [b"deposit", launch.key().as_ref(), depositor.key().as_ref()], bump)]
    pub deposit: Account<'info, Deposit>,
    #[account(mut, seeds = [b"pot", launch.key().as_ref()], bump)]
    pub pot_wsol: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Open<'info> {
    #[account(address = launch.crank)]
    pub crank: Signer<'info>,
    #[account(mut)]
    pub launch: Account<'info, Launch>,
    #[account(mut, seeds = [b"pot", launch.key().as_ref()], bump)]
    pub pot_wsol: Account<'info, TokenAccount>,
    /// CHECK: the instructions sysvar
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Settle<'info> {
    #[account(mut)]
    pub launch: Account<'info, Launch>,
    #[account(mut, seeds = [b"pot", launch.key().as_ref()], bump)]
    pub pot_wsol: Account<'info, TokenAccount>,
    #[account(token::authority = launch)]
    pub pot_coin: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    pub depositor: Signer<'info>,
    pub launch: Account<'info, Launch>,
    #[account(mut, has_one = launch, constraint = deposit.owner == depositor.key() @ FairOpenError::BadAccount)]
    pub deposit: Account<'info, Deposit>,
    #[account(mut, seeds = [b"pot", launch.key().as_ref()], bump)]
    pub pot_wsol: Account<'info, TokenAccount>,
    #[account(mut, token::authority = launch, token::mint = launch.base_mint)]
    pub pot_coin: Account<'info, TokenAccount>,
    #[account(mut, token::authority = depositor, token::mint = launch.base_mint)]
    pub depositor_coin: Account<'info, TokenAccount>,
    #[account(mut, token::authority = depositor, token::mint = NATIVE_MINT)]
    pub depositor_wsol: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[error_code]
pub enum FairOpenError {
    NotDbcConfig,
    WrongState,
    WindowClosed,
    NotYet,
    BadBuy,
    BadTransaction,
    BadAccount,
    BadFill,
    AlreadyClaimed,
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::solana_program::instruction::AccountMeta;

    fn k(n: u8) -> Pubkey {
        Pubkey::new_from_array([n; 32])
    }
    fn ro(p: Pubkey) -> AccountMeta {
        AccountMeta::new_readonly(p, false)
    }

    struct Fx { e: Expect, mint: Pubkey, pool: Pubkey }

    fn fx() -> Fx {
        Fx {
            e: Expect { program_id: crate::ID, launch: k(1), dbc_config: k(2), creator: k(3), crank: k(4), pot_wsol: k(5), buy: 10_000_000 },
            mint: k(6),
            pool: k(7),
        }
    }

    fn ours(disc: &[u8]) -> Instruction {
        Instruction { program_id: crate::ID, accounts: vec![], data: disc.to_vec() }
    }
    fn init(f: &Fx, creator: Pubkey, signer: bool) -> Instruction {
        let mut accounts = vec![ro(f.e.dbc_config), ro(k(20)), AccountMeta::new_readonly(creator, signer), AccountMeta::new(f.mint, true), ro(k(21)), AccountMeta::new(f.pool, false)];
        accounts.extend((0..10).map(|n| ro(k(30 + n))));
        Instruction { program_id: DBC, accounts, data: [DBC_INIT_SPL.to_vec(), vec![0; 40]].concat() }
    }
    fn ata(f: &Fx) -> Instruction {
        Instruction { program_id: ATA_PROGRAM, accounts: vec![ro(f.e.crank), ro(k(8)), ro(f.e.launch), ro(f.mint), ro(k(40)), ro(k(41))], data: vec![1] }
    }
    fn swap(f: &Fx, input: Pubkey, authority: Pubkey, amount: u64, mode: u8, referral: Pubkey) -> Instruction {
        let mut accounts: Vec<AccountMeta> = (0..15).map(|n| ro(k(50 + n))).collect();
        accounts[2] = ro(f.pool);
        accounts[3] = ro(input);
        accounts[9] = AccountMeta::new_readonly(authority, true);
        accounts[12] = ro(referral);
        let mut data = DBC_SWAP2.to_vec();
        data.extend(amount.to_le_bytes());
        data.extend(0u64.to_le_bytes());
        data.push(mode);
        Instruction { program_id: DBC, accounts, data }
    }
    fn good(f: &Fx) -> Vec<Instruction> {
        vec![
            ours(crate::instruction::Open::DISCRIMINATOR),
            init(f, f.e.creator, true),
            ata(f),
            swap(f, f.e.pot_wsol, f.e.crank, f.e.buy, 0, DBC),
            ours(crate::instruction::Settle::DISCRIMINATOR),
        ]
    }

    #[test]
    fn accepts_the_creation_transaction() {
        let f = fx();
        assert_eq!(check_creation_tx(&good(&f), 0, &f.e), Ok(Found { pool: f.pool, base_mint: f.mint }));
    }

    #[test]
    fn accepts_a_nonce_advance_and_compute_budget_first() {
        let f = fx();
        let mut ixs = vec![
            Instruction { program_id: anchor_lang::system_program::ID, accounts: vec![], data: vec![4, 0, 0, 0] },
            Instruction { program_id: COMPUTE_BUDGET, accounts: vec![], data: vec![2, 0, 0, 0, 0] },
        ];
        ixs.extend(good(&f));
        assert!(check_creation_tx(&ixs, 2, &f.e).is_ok());
    }

    #[test]
    fn rejects_a_pot_transfer_slipped_in() {
        let f = fx();
        let mut ixs = good(&f);
        ixs.insert(4, Instruction { program_id: anchor_spl::token::ID, accounts: vec![ro(f.e.pot_wsol)], data: vec![3] });
        assert_eq!(check_creation_tx(&ixs, 0, &f.e), Err(ShapeError::MissingSettle));
    }

    #[test]
    fn rejects_anything_before_open() {
        let f = fx();
        let mut ixs = good(&f);
        ixs.insert(0, Instruction { program_id: anchor_spl::token::ID, accounts: vec![], data: vec![3] });
        assert_eq!(check_creation_tx(&ixs, 1, &f.e), Err(ShapeError::BeforeOpen(0)));
    }

    #[test]
    fn rejects_another_buyer_before_the_pot() {
        let f = fx();
        let mut ixs = good(&f);
        ixs.insert(3, swap(&f, k(9), k(9), 1, 0, DBC));
        assert_eq!(check_creation_tx(&ixs, 0, &f.e), Err(ShapeError::SwapInput));
    }

    #[test]
    fn rejects_a_trailing_instruction() {
        let f = fx();
        let mut ixs = good(&f);
        ixs.push(swap(&f, k(9), k(9), 1, 0, DBC));
        assert_eq!(check_creation_tx(&ixs, 0, &f.e), Err(ShapeError::TrailingInstructions));
    }

    #[test]
    fn rejects_the_wrong_creator_or_an_unsigned_one() {
        let f = fx();
        let mut ixs = good(&f);
        ixs[1] = init(&f, k(99), true);
        assert_eq!(check_creation_tx(&ixs, 0, &f.e), Err(ShapeError::InitCreator));
        ixs[1] = init(&f, f.e.creator, false);
        assert_eq!(check_creation_tx(&ixs, 0, &f.e), Err(ShapeError::InitCreator));
    }

    #[test]
    fn rejects_a_swap_that_is_not_the_capped_exact_in_buy() {
        let f = fx();
        let mut ixs = good(&f);
        ixs[3] = swap(&f, f.e.pot_wsol, f.e.crank, f.e.buy + 1, 0, DBC);
        assert_eq!(check_creation_tx(&ixs, 0, &f.e), Err(ShapeError::SwapAmount));
        ixs[3] = swap(&f, f.e.pot_wsol, f.e.crank, f.e.buy, 1, DBC);
        assert_eq!(check_creation_tx(&ixs, 0, &f.e), Err(ShapeError::SwapMode));
        ixs[3] = swap(&f, f.e.pot_wsol, f.e.crank, f.e.buy, 0, k(77));
        assert_eq!(check_creation_tx(&ixs, 0, &f.e), Err(ShapeError::SwapReferral));
        ixs[3] = swap(&f, f.e.pot_wsol, k(78), f.e.buy, 0, DBC);
        assert_eq!(check_creation_tx(&ixs, 0, &f.e), Err(ShapeError::SwapAuthority));
    }

    #[test]
    fn rejects_another_config() {
        let f = fx();
        let mut ixs = good(&f);
        ixs[1].accounts[0] = ro(k(98));
        assert_eq!(check_creation_tx(&ixs, 0, &f.e), Err(ShapeError::InitConfig));
    }
}
