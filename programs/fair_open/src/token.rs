//! The few SPL Token instructions the pot needs, built by hand as the fee program builds DBC's, and the token account
//! fields it reads: a classic SPL Token account is a fixed 165 bytes (spec 3.1: Heat coins are never Token-2022).
use {
    crate::{FairOpenError, TOKEN_PROGRAM},
    anchor_lang::{
        prelude::*,
        solana_program::{
            instruction::{AccountMeta, Instruction},
            program::invoke_signed,
        },
    },
};

/// An SPL Token account, the fields this program reads.
pub struct TokenAccount {
    pub mint: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
    /// Whether a delegate may still spend from it: SPL Token clears the delegate once its allowance is used up.
    pub delegated: bool,
}

impl TokenAccount {
    pub fn read(account: &AccountInfo) -> Result<TokenAccount> {
        require_keys_eq!(*account.owner, TOKEN_PROGRAM, FairOpenError::NotATokenAccount);
        let data = account.try_borrow_data()?;
        require_eq!(data.len(), crate::TOKEN_ACCOUNT_LEN, FairOpenError::NotATokenAccount);
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
    require_keys_eq!(*mint.owner, TOKEN_PROGRAM, FairOpenError::NotATokenAccount);
    let data = mint.try_borrow_data()?;
    data.get(44).copied().ok_or(FairOpenError::NotATokenAccount.into())
}

fn run<'info>(data: Vec<u8>, accounts: &[(&AccountInfo<'info>, bool, bool)], signer: &[&[u8]]) -> Result<()> {
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
    invoke_signed(&Instruction { program_id: TOKEN_PROGRAM, accounts: metas, data }, &infos, &[signer])?;
    Ok(())
}

/// `InitializeAccount3` (18): a token account of `mint` owned by `owner`, at an address already allocated to SPL Token.
/// A wrapped-SOL account holds as many tokens as it has lamports above its rent.
pub fn initialize_account<'info>(
    account: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    owner: &Pubkey,
) -> Result<()> {
    let mut data = vec![18];
    data.extend_from_slice(owner.as_ref());
    run(data, &[(account, true, false), (mint, false, false)], &[])
}

/// `Approve` (4): `delegate` may spend `amount` from `account`, which `owner` signs for.
pub fn approve<'info>(
    account: &AccountInfo<'info>,
    delegate: &AccountInfo<'info>,
    owner: &AccountInfo<'info>,
    amount: u64,
    signer: &[&[u8]],
) -> Result<()> {
    let mut data = vec![4];
    data.extend_from_slice(&amount.to_le_bytes());
    run(data, &[(account, true, false), (delegate, false, false), (owner, false, true)], signer)
}

/// `TransferChecked` (12): `amount` from `from` to `to`, which `owner` signs for.
pub fn transfer<'info>(
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
    run(data, &[(from, true, false), (mint, false, false), (to, true, false), (owner, false, true)], signer)
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
    run(data, &[(account, true, false), (mint, true, false), (owner, false, true)], signer)
}

/// `CloseAccount` (9): `account` closed and every lamport it holds, wrapped SOL included, sent to `to`.
pub fn close<'info>(
    account: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    owner: &AccountInfo<'info>,
    signer: &[&[u8]],
) -> Result<()> {
    run(vec![9], &[(account, true, false), (to, true, false), (owner, false, true)], signer)
}
