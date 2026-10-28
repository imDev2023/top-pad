//! The Fair Open program (spec 5.3): holds a launch's deposits through its window and makes the pot's buy the first
//! swap at the open. Empty until "Fair Open deposits, withdrawals and the failure path" fills it in.
use anchor_lang::prelude::*;

declare_id!("HeatPiBAgiwq6VJr8eqyagQiQ2gvaK2y85q26bbBu4bo");

#[cfg(not(feature = "no-entrypoint"))]
solana_security_txt::security_txt! {
    name: "Heat Fair Open program",
    project_url: "https://github.com/imDev2023/top-pad",
    contacts: "link:https://github.com/imDev2023/top-pad/security/advisories/new",
    policy: "https://github.com/imDev2023/top-pad/blob/main/SECURITY.md",
    preferred_languages: "en",
    source_code: "https://github.com/imDev2023/top-pad"
}

#[program]
pub mod fair_open {}
