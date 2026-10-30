//! The built program (target/deploy/fair_open.so, from `pnpm programs`) in LiteSVM, with no other program loaded (spec
//! 5.1): its build, and its settings, which only the upgrade authority may set.
// LiteSVM's failed-transaction metadata is large by design; the helpers here only hand it back to the test.
#![allow(clippy::result_large_err)]
mod common;

use {
    anchor_lang::solana_program::{instruction::Instruction, pubkey::Pubkey},
    common::*,
    fair_open::{ProgramConfig, ProgramConfigChanged, ProgramSettings},
    litesvm::LiteSVM,
    solana_keypair::Keypair,
    solana_signer::Signer,
};

#[test]
fn deploys_at_its_declared_id_and_refuses_an_unknown_instruction() {
    let mut svm = LiteSVM::new();
    svm.add_program(fair_open::id(), PROGRAM).unwrap();
    assert!(svm.get_account(&fair_open::id()).unwrap().executable);

    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 1_000_000_000).unwrap();
    let instruction = Instruction::new_with_bytes(fair_open::id(), &[0; 8], vec![]);
    let err = send_as(&mut svm, &[instruction], &payer, &[]).unwrap_err();
    // Anchor's InstructionFallbackNotFound (101): the program runs, and has no instruction with that discriminator.
    assert!(err.meta.logs.iter().any(|l| l.contains("InstructionFallbackNotFound")), "{:?}", err.meta.logs);
    assert_ne!(fair_open::id(), Pubkey::default());
}

#[test]
fn is_built_for_an_sbpf_version_devnet_and_mainnet_run() {
    // ELF e_flags carry the SBPF version. v2 is the newest active on devnet and mainnet; a bare `anchor build` makes v3.
    let version = u32::from_le_bytes(PROGRAM[48..52].try_into().unwrap());
    assert!(version <= 2, "built for SBPF v{version}: build with `pnpm programs` (SBPF v2)");
}

#[test]
fn carries_its_security_txt() {
    let text = String::from_utf8_lossy(PROGRAM);
    let start = text.find("=======BEGIN SECURITY.TXT V1=======").expect("security.txt is in the binary");
    let end = text.find("=======END SECURITY.TXT V1=======").expect("security.txt ends");
    let fields: Vec<&str> = text[start..end].split('\0').collect();
    for field in ["name", "project_url", "contacts", "policy", "source_code"] {
        let at = fields.iter().position(|f| f.ends_with(field)).unwrap_or_else(|| panic!("{field} is missing"));
        assert!(!fields[at + 1].is_empty(), "{field} is empty");
    }
}

#[test]
fn takes_its_settings_from_the_upgrade_authority_alone() {
    let mut t = Test::deployed();
    let stranger = Keypair::new();
    refused(t.initialize_as(&stranger, t.settings()), Code::NotUpgradeAuthority);

    let authority = t.upgrade_authority.insecure_clone();
    let done = t.initialize_as(&authority, t.settings()).unwrap();
    let config: ProgramConfig = t.read(&program_config_address());
    assert_eq!(config.admission_signer, t.admission_key.pubkey());
    assert_eq!(config.keeper, t.keeper.pubkey());
    assert_eq!(config.dbc_config, t.dbc_config);
    assert_eq!(events::<ProgramConfigChanged>(&done).len(), 1);

    // A leaked admission key is rotated by the upgrade authority, and by nobody else.
    let rotated = ProgramSettings { admission_signer: Pubkey::new_unique(), ..t.settings() };
    refused(t.update_as(&stranger, rotated), Code::NotUpgradeAuthority);
    t.update_as(&authority, rotated).unwrap();
    assert_eq!(t.read::<ProgramConfig>(&program_config_address()).admission_signer, rotated.admission_signer);
}

#[test]
fn refuses_a_setting_left_empty() {
    let mut t = Test::deployed();
    let authority = t.upgrade_authority.insecure_clone();
    let settings = ProgramSettings { keeper: Pubkey::default(), ..t.settings() };
    refused(t.initialize_as(&authority, settings), Code::MissingSetting);
}

#[test]
fn takes_no_settings_once_the_program_is_frozen() {
    // With its upgrade authority given up, nobody can change who admits depositors.
    let mut t = Test::deployed();
    t.set_upgrade_authority(None);
    let authority = t.upgrade_authority.insecure_clone();
    refused(t.initialize_as(&authority, t.settings()), Code::NotUpgradeAuthority);
}
