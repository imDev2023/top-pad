//! The few token instructions the pot needs, built by hand as the fee program builds DBC's, and the token account and
//! mint fields it reads. Heat coins are classic SPL tokens (spec 3.1); a quote is wrapped SOL, any other SPL Token mint,
//! or a Token-2022 mint (ADR 0007), whose accounts carry extensions after SPL Token's 165 bytes. Every instruction here
//! has the same number and layout under both programs, so each takes the program it runs under.
use {
    crate::{FairOpenError, TOKEN_2022_PROGRAM, TOKEN_PROGRAM},
    anchor_lang::{
        prelude::*,
        solana_program::{
            instruction::{AccountMeta, Instruction},
            program::{get_return_data, invoke_signed},
        },
    },
};

/// Token-2022 marks an extended account's kind in the byte after SPL Token's 165: 1 a mint, 2 an account.
const ACCOUNT_TYPE_AT: usize = 165;
const ACCOUNT_TYPE_MINT: u8 = 1;
const ACCOUNT_TYPE_ACCOUNT: u8 = 2;

/// Whether `program` is SPL Token or Token-2022.
pub fn is_token_program(program: &Pubkey) -> bool {
    *program == TOKEN_PROGRAM || *program == TOKEN_2022_PROGRAM
}

/// A token account, the fields this program reads.
pub struct TokenAccount {
    pub mint: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
    /// Whether a delegate may still spend from it: both programs clear the delegate once its allowance is used up.
    pub delegated: bool,
}

impl TokenAccount {
    /// An SPL Token or Token-2022 account: SPL Token's 165 bytes, and under Token-2022 any extensions after them.
    pub fn read(account: &AccountInfo) -> Result<TokenAccount> {
        require!(is_token_program(account.owner), FairOpenError::NotATokenAccount);
        let data = account.try_borrow_data()?;
        let extended = data.len() > crate::TOKEN_ACCOUNT_LEN;
        require!(
            data.len() == crate::TOKEN_ACCOUNT_LEN
                || (extended && *account.owner == TOKEN_2022_PROGRAM && data[ACCOUNT_TYPE_AT] == ACCOUNT_TYPE_ACCOUNT),
            FairOpenError::NotATokenAccount
        );
        let address = |at: usize| Pubkey::new_from_array(data[at..at + 32].try_into().unwrap());
        Ok(TokenAccount {
            mint: address(0),
            owner: address(32),
            amount: u64::from_le_bytes(data[64..72].try_into().unwrap()),
            // `delegate`, a `COption<Pubkey>`: a 4-byte tag, 1 when some.
            delegated: data[72..76] != [0; 4],
        })
    }
}

/// A mint's decimals, which `TransferChecked` repeats.
pub fn decimals(mint: &AccountInfo) -> Result<u8> {
    require!(is_token_program(mint.owner), FairOpenError::NotATokenAccount);
    let data = mint.try_borrow_data()?;
    data.get(44).copied().ok_or(FairOpenError::NotATokenAccount.into())
}

/// Token-2022's extensions a quote's mint is read for (ADR 0007, "Which quotes"), by their `ExtensionType` numbers.
mod extension {
    pub const TRANSFER_FEE_CONFIG: u16 = 1;
    pub const DEFAULT_ACCOUNT_STATE: u16 = 6;
    pub const TRANSFER_HOOK: u16 = 14;
    pub const PAUSABLE: u16 = 26;
    /// `TransferFeeConfig`: the fee authority, the withheld authority and the withheld amount, then the older and the
    /// newer `TransferFee`, each an epoch, a maximum fee and its basis points.
    pub const FEE_AUTHORITY: core::ops::Range<usize> = 0..32;
    pub const OLDER_FEE: usize = 72;
    pub const NEWER_FEE: usize = 90;
    /// `AccountState::Frozen`.
    pub const FROZEN: u8 = 2;
    /// `TransferHook`: its authority, then the program it names.
    pub const HOOK_PROGRAM: core::ops::Range<usize> = 32..64;
    /// `PausableConfig`: its authority, then whether the mint is paused.
    pub const PAUSED: usize = 32;
}

/// Why Heat does not take a quote's mint now, though DBC might (ADR 0007, "Which quotes"; spec 3.2); the same rules as
/// `quoteVerdict` in `@top-pad/chain`, read from the mint's own account. Whether DBC takes the mint at all, a TokenBadge
/// for most Token-2022 quotes, DBC itself checks at every config's and every pool's creation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum QuoteRefusal {
    /// Neither SPL Token nor Token-2022 owns it, or it is not a mint.
    NotAMint,
    /// Token-2022's own wrapped SOL, which DBC refuses: SOL is quoted as SPL Token's wrapped SOL.
    Token2022NativeMint,
    /// A transfer fee now or scheduled, or an authority that could set one later.
    TransferFee,
    /// A transfer hook naming a program, which neither DBC nor this program would pass the accounts of.
    TransferHookProgram,
    /// Every new account starts frozen, so nobody could take a deposit or a refund.
    DefaultStateFrozen,
    /// The issuer has paused every transfer.
    Paused,
}

impl From<QuoteRefusal> for Error {
    fn from(refusal: QuoteRefusal) -> Error {
        msg!("Heat does not take this quote: {:?}", refusal);
        match refusal {
            QuoteRefusal::Paused => FairOpenError::QuotePaused.into(),
            _ => FairOpenError::QuoteRefused.into(),
        }
    }
}

/// Reads a quote's mint against Heat's quote rules. SPL Token mints carry no extensions; a Token-2022 mint's extensions
/// follow its account type byte as type, length and value entries.
pub fn check_quote(mint: &AccountInfo) -> core::result::Result<(), QuoteRefusal> {
    let data = mint.try_borrow_data().map_err(|_| QuoteRefusal::NotAMint)?;
    if *mint.owner == TOKEN_PROGRAM {
        return if data.len() == crate::MINT_LEN && data[45] == 1 { Ok(()) } else { Err(QuoteRefusal::NotAMint) };
    }
    if *mint.owner != TOKEN_2022_PROGRAM || data.len() < crate::MINT_LEN || data[45] != 1 {
        return Err(QuoteRefusal::NotAMint);
    }
    if mint.key() == crate::TOKEN_2022_NATIVE_MINT {
        return Err(QuoteRefusal::Token2022NativeMint);
    }
    if data.len() == crate::MINT_LEN {
        return Ok(());
    }
    if data.get(ACCOUNT_TYPE_AT) != Some(&ACCOUNT_TYPE_MINT) {
        return Err(QuoteRefusal::NotAMint);
    }
    let mut at = ACCOUNT_TYPE_AT + 1;
    while let Some(header) = data.get(at..at + 4) {
        let kind = u16::from_le_bytes([header[0], header[1]]);
        let len = u16::from_le_bytes([header[2], header[3]]) as usize;
        let value = data.get(at + 4..at + 4 + len).ok_or(QuoteRefusal::NotAMint)?;
        let has_fee = |fee: usize| {
            let maximum = u64::from_le_bytes(value[fee + 8..fee + 16].try_into().unwrap());
            let basis_points = u16::from_le_bytes(value[fee + 16..fee + 18].try_into().unwrap());
            maximum != 0 && basis_points != 0
        };
        match kind {
            0 => break,
            extension::TRANSFER_FEE_CONFIG if len >= extension::NEWER_FEE + 18 => {
                if value[extension::FEE_AUTHORITY] != [0; 32]
                    || has_fee(extension::OLDER_FEE)
                    || has_fee(extension::NEWER_FEE)
                {
                    return Err(QuoteRefusal::TransferFee);
                }
            }
            extension::DEFAULT_ACCOUNT_STATE if len >= 1 => {
                if value[0] == extension::FROZEN {
                    return Err(QuoteRefusal::DefaultStateFrozen);
                }
            }
            extension::TRANSFER_HOOK if len >= extension::HOOK_PROGRAM.end => {
                if value[extension::HOOK_PROGRAM] != [0; 32] {
                    return Err(QuoteRefusal::TransferHookProgram);
                }
            }
            extension::PAUSABLE if len > extension::PAUSED => {
                if value[extension::PAUSED] != 0 {
                    return Err(QuoteRefusal::Paused);
                }
            }
            extension::TRANSFER_FEE_CONFIG
            | extension::DEFAULT_ACCOUNT_STATE
            | extension::TRANSFER_HOOK
            | extension::PAUSABLE => return Err(QuoteRefusal::NotAMint),
            _ => {}
        }
        at += 4 + len;
    }
    Ok(())
}

fn run<'info>(
    program: &Pubkey,
    data: Vec<u8>,
    accounts: &[(&AccountInfo<'info>, bool, bool)],
    signer: &[&[u8]],
) -> Result<()> {
    let metas = accounts
        .iter()
        .map(
            |(a, writable, signs)| {
                if *writable {
                    AccountMeta::new(a.key(), *signs)
                } else {
                    AccountMeta::new_readonly(a.key(), *signs)
                }
            },
        )
        .collect();
    let infos: Vec<AccountInfo<'info>> = accounts.iter().map(|(a, _, _)| (*a).clone()).collect();
    let signers: &[&[&[u8]]] = if signer.is_empty() { &[] } else { &[signer] };
    invoke_signed(&Instruction { program_id: *program, accounts: metas, data }, &infos, signers)?;
    Ok(())
}

/// `GetAccountDataSize` (21): how many bytes an account of `mint` needs, with every extension the mint requires of its
/// accounts (Token-2022's transfer hook and pausable accounts, for an xStock); 165 under SPL Token.
pub fn account_size<'info>(program: &Pubkey, mint: &AccountInfo<'info>) -> Result<usize> {
    run(program, vec![21], &[(mint, false, false)], &[])?;
    let (from, data) = get_return_data().ok_or(FairOpenError::NotATokenAccount)?;
    require_keys_eq!(from, *program, FairOpenError::NotATokenAccount);
    let size = u64::from_le_bytes(data.get(..8).ok_or(FairOpenError::NotATokenAccount)?.try_into().unwrap());
    Ok(size as usize)
}

/// `InitializeAccount3` (18): a token account of `mint` owned by `owner`, at an address already allocated to `program`.
/// A wrapped-SOL account holds as many tokens as it has lamports above its rent.
pub fn initialize_account<'info>(
    program: &Pubkey,
    account: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    owner: &Pubkey,
) -> Result<()> {
    let mut data = vec![18];
    data.extend_from_slice(owner.as_ref());
    run(program, data, &[(account, true, false), (mint, false, false)], &[])
}

/// `Approve` (4): `delegate` may spend `amount` from `account`, which `owner` signs for.
pub fn approve<'info>(
    program: &Pubkey,
    account: &AccountInfo<'info>,
    delegate: &AccountInfo<'info>,
    owner: &AccountInfo<'info>,
    amount: u64,
    signer: &[&[u8]],
) -> Result<()> {
    let mut data = vec![4];
    data.extend_from_slice(&amount.to_le_bytes());
    run(program, data, &[(account, true, false), (delegate, false, false), (owner, false, true)], signer)
}

/// `TransferChecked` (12): `amount` from `from` to `to`, which `owner` signs for, the depositor's own signature or a PDA's.
#[allow(clippy::too_many_arguments)]
pub fn transfer<'info>(
    program: &Pubkey,
    from: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    owner: &AccountInfo<'info>,
    amount: u64,
    decimals: u8,
    signer: &[&[u8]],
) -> Result<()> {
    let mut data = vec![12];
    data.extend_from_slice(&amount.to_le_bytes());
    data.push(decimals);
    let accounts = [(from, true, false), (mint, false, false), (to, true, false), (owner, false, true)];
    run(program, data, &accounts, signer)
}

/// `Burn` (8): `amount` of `account`'s tokens destroyed, which `owner` signs for.
pub fn burn<'info>(
    account: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    owner: &AccountInfo<'info>,
    amount: u64,
    signer: &[&[u8]],
) -> Result<()> {
    let mut data = vec![8];
    data.extend_from_slice(&amount.to_le_bytes());
    run(&TOKEN_PROGRAM, data, &[(account, true, false), (mint, true, false), (owner, false, true)], signer)
}

/// `CloseAccount` (9): `account` closed and every lamport it holds, wrapped SOL included, sent to `to`.
pub fn close<'info>(
    program: &Pubkey,
    account: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    owner: &AccountInfo<'info>,
    signer: &[&[u8]],
) -> Result<()> {
    run(program, vec![9], &[(account, true, false), (to, true, false), (owner, false, true)], signer)
}
