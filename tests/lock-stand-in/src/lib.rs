//! A stand-in for Jupiter Lock in the Fair Open program's LiteSVM tests, never deployed, at Lock's address: its
//! `create_vesting_escrow_v2`, as the IDL of release 0.5.0 lays it out (`@meteora-ag/met-lock-sdk`) and Lock's source
//! does it: the escrow at the PDA of its `base`, which signs, paid for by `sender`, which signs and is recorded as its
//! creator; the whole schedule's coins moved in from `sender_token` with `sender`'s signature, as the account's owner or
//! its delegate, into the escrow's associated account. It writes the escrow in Lock's layout, so the tests read the
//! schedule back as a terminal would. The devnet tests run the Fair Open program against Jupiter Lock itself.
use anchor_lang::{
    prelude::Pubkey,
    solana_program::{
        account_info::AccountInfo,
        entrypoint::ProgramResult,
        instruction::{AccountMeta, Instruction},
        msg,
        program::invoke_signed,
        program_error::ProgramError,
    },
};

anchor_lang::declare_id!("LocpQgucEQHbqNABEYvBvwoxCPsSbG91A1QaQhQQqjn");

#[cfg(not(feature = "no-entrypoint"))]
anchor_lang::solana_program::entrypoint!(process);

pub const CREATE_VESTING_ESCROW_V2: [u8; 8] = [181, 155, 104, 183, 182, 128, 35, 47];
pub const VESTING_ESCROW_DISCRIMINATOR: [u8; 8] = [244, 119, 183, 4, 73, 116, 135, 195];
pub const ESCROW_SEED: &[u8] = b"escrow";
pub const ESCROW_LEN: usize = 8 + 288;

/// `VestingEscrow`'s fields, after its discriminator: four addresses, four one-byte fields and four of padding, then
/// nine `u64`s.
pub mod escrow {
    pub const RECIPIENT: usize = 8;
    pub const TOKEN_MINT: usize = 40;
    pub const CREATOR: usize = 72;
    pub const BASE: usize = 104;
    pub const ESCROW_BUMP: usize = 136;
    pub const UPDATE_RECIPIENT_MODE: usize = 137;
    pub const CANCEL_MODE: usize = 138;
    pub const TOKEN_PROGRAM_FLAG: usize = 139;
    pub const CLIFF_TIME: usize = 144;
    pub const FREQUENCY: usize = 152;
    pub const CLIFF_UNLOCK_AMOUNT: usize = 160;
    pub const AMOUNT_PER_PERIOD: usize = 168;
    pub const NUMBER_OF_PERIOD: usize = 176;
    pub const TOTAL_CLAIMED_AMOUNT: usize = 184;
    pub const VESTING_START_TIME: usize = 192;
    pub const CANCELLED_AT: usize = 200;
}

const TOKEN_PROGRAM: Pubkey = anchor_lang::pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM: Pubkey = anchor_lang::pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const SYSTEM_PROGRAM: Pubkey = anchor_lang::pubkey!("11111111111111111111111111111111");
/// An SPL mint's decimals, and SPL Token's `TransferChecked`.
const MINT_DECIMALS: usize = 44;
const TRANSFER_CHECKED: u8 = 12;

pub fn process(_program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    match data.split_at_checked(8) {
        Some((discriminator, args)) if discriminator == CREATE_VESTING_ESCROW_V2 => create(accounts, args),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

fn require(condition: bool, what: &str) -> ProgramResult {
    if condition {
        Ok(())
    } else {
        msg!("Lock stand-in refused: {}", what);
        Err(ProgramError::InvalidArgument)
    }
}

fn number(data: &[u8], offset: usize) -> Result<u64, ProgramError> {
    let bytes = data.get(offset..offset + 8).ok_or(ProgramError::InvalidInstructionData)?;
    Ok(u64::from_le_bytes(bytes.try_into().unwrap()))
}

fn create(accounts: &[AccountInfo], args: &[u8]) -> ProgramResult {
    let [base, escrow, token_mint, escrow_token, sender, sender_token, recipient, token_program, _system_program, _event_authority, _program] =
        accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    let [vesting_start_time, cliff_time, frequency, cliff_unlock_amount, amount_per_period, number_of_period] =
        [0, 8, 16, 24, 32, 40].map(|at| number(args, at));
    let (vesting_start_time, cliff_time, frequency) = (vesting_start_time?, cliff_time?, frequency?);
    let (cliff_unlock_amount, amount_per_period, number_of_period) =
        (cliff_unlock_amount?, amount_per_period?, number_of_period?);
    let (update_recipient_mode, cancel_mode) = (args.get(48).copied(), args.get(49).copied());
    require(
        args.get(50) == Some(&0) && args.len() == 51,
        "remaining accounts info, which classic SPL coins never need",
    )?;
    let (update_recipient_mode, cancel_mode) = match (update_recipient_mode, cancel_mode) {
        (Some(u), Some(c)) if u <= 3 && c <= 3 => (u, c),
        _ => return Err(ProgramError::InvalidInstructionData),
    };
    require(cliff_time >= vesting_start_time, "InvalidVestingStartTime")?;
    require(frequency != 0, "FrequencyIsZero")?;
    let total = number_of_period
        .checked_mul(amount_per_period)
        .and_then(|n| n.checked_add(cliff_unlock_amount))
        .ok_or(ProgramError::ArithmeticOverflow)?;
    require(total > 0, "AmountIsZero")?;

    require(base.is_signer && sender.is_signer, "the base and the sender sign")?;
    require(*token_program.key == TOKEN_PROGRAM, "SPL Token only")?;
    let (address, bump) = Pubkey::find_program_address(&[ESCROW_SEED, base.key.as_ref()], &ID);
    require(*escrow.key == address, "not the escrow of the base")?;
    let (escrow_token_address, _) = Pubkey::find_program_address(
        &[escrow.key.as_ref(), TOKEN_PROGRAM.as_ref(), token_mint.key.as_ref()],
        &ASSOCIATED_TOKEN_PROGRAM,
    );
    require(*escrow_token.key == escrow_token_address, "not the escrow's associated account")?;
    require(
        escrow_token.owner == &TOKEN_PROGRAM && escrow_token.data_len() == 165,
        "the escrow's account is not made",
    )?;

    // The escrow, paid for by the sender.
    let rent = {
        use anchor_lang::prelude::SolanaSysvar;
        anchor_lang::prelude::Rent::get()?.minimum_balance(ESCROW_LEN)
    };
    let mut data = vec![0, 0, 0, 0];
    data.extend_from_slice(&rent.to_le_bytes());
    data.extend_from_slice(&(ESCROW_LEN as u64).to_le_bytes());
    data.extend_from_slice(ID.as_ref());
    let create = Instruction {
        program_id: SYSTEM_PROGRAM,
        accounts: vec![AccountMeta::new(*sender.key, true), AccountMeta::new(*escrow.key, true)],
        data,
    };
    invoke_signed(&create, &[sender.clone(), escrow.clone()], &[&[ESCROW_SEED, base.key.as_ref(), &[bump]]])?;
    {
        let mut data = escrow.try_borrow_mut_data()?;
        let mut put = |at: usize, bytes: &[u8]| data[at..at + bytes.len()].copy_from_slice(bytes);
        put(0, &VESTING_ESCROW_DISCRIMINATOR);
        put(escrow::RECIPIENT, recipient.key.as_ref());
        put(escrow::TOKEN_MINT, token_mint.key.as_ref());
        put(escrow::CREATOR, sender.key.as_ref());
        put(escrow::BASE, base.key.as_ref());
        put(escrow::ESCROW_BUMP, &[bump]);
        put(escrow::UPDATE_RECIPIENT_MODE, &[update_recipient_mode]);
        put(escrow::CANCEL_MODE, &[cancel_mode]);
        put(escrow::TOKEN_PROGRAM_FLAG, &[0]);
        put(escrow::CLIFF_TIME, &cliff_time.to_le_bytes());
        put(escrow::FREQUENCY, &frequency.to_le_bytes());
        put(escrow::CLIFF_UNLOCK_AMOUNT, &cliff_unlock_amount.to_le_bytes());
        put(escrow::AMOUNT_PER_PERIOD, &amount_per_period.to_le_bytes());
        put(escrow::NUMBER_OF_PERIOD, &number_of_period.to_le_bytes());
        put(escrow::VESTING_START_TIME, &vesting_start_time.to_le_bytes());
    }

    // The coins, signed for by the sender, as their owner or their delegate.
    let decimals = *token_mint.try_borrow_data()?.get(MINT_DECIMALS).ok_or(ProgramError::InvalidAccountData)?;
    let mut data = vec![TRANSFER_CHECKED];
    data.extend_from_slice(&total.to_le_bytes());
    data.push(decimals);
    let transfer = Instruction {
        program_id: TOKEN_PROGRAM,
        accounts: vec![
            AccountMeta::new(*sender_token.key, false),
            AccountMeta::new_readonly(*token_mint.key, false),
            AccountMeta::new(*escrow_token.key, false),
            AccountMeta::new_readonly(*sender.key, true),
        ],
        data,
    };
    invoke_signed(
        &transfer,
        &[sender_token.clone(), token_mint.clone(), escrow_token.clone(), sender.clone(), token_program.clone()],
        &[],
    )
}
