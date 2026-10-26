# Can a commercial launchpad use Meteora's program code and IDLs under their licences?

Research for Top-pad's wayfinder map, ticket [#16](https://github.com/imDev2023/top-pad/issues/16), captured 2026-10-26.
It was surfaced by [#9](https://github.com/imDev2023/top-pad/issues/9), whose findings are on branch `research/prototype-stack`.
Every claim names its source; repository files are cited by path, and the commit read is listed under "Sources".
Anything not checked against a primary source is marked **unverified**.
I am not a lawyer and this is not legal advice: it reports what the licence texts, Meteora's terms and Meteora's own code say, and marks where the texts leave the answer open.

## Answer

Two sets of terms apply, not one.
The first is each repository's code licence.
The second is Meteora's Terms of Service, which say they govern "the Smart Contracts" themselves, not only the website (Terms of Service, preamble).

Under the code licences, a commercial launchpad has a clear route:

- use Meteora's TypeScript SDKs off-chain (MIT for DBC and DAMM v2, ISC on npm for DLMM and Alpha Vault);
- generate client code and `declare_program!` CPI modules from the IDLs that ship inside those SDK packages;
- never compile the DBC or DAMM v2 program crates, or the Rust quote crates in those repositories, into our code, and never copy program source.

Dumping deployed binaries for local tests is the one use the code licences do not cover for any of the four programs.

The Terms of Service go further than the code licences: "you will not use the Site, the App and the Smart Contracts for any commercial purpose (save as approved by the Company in writing)" (section 6.2(k)), where "the App" includes the Smart Contracts.
Meteora's business is selling DBC to commercial launchpads (it says it keeps 20% of DBC trading fees and has integrated 14 launchpads), so approval is plainly available, but on paper a commercial launchpad needs it in writing.
That makes the written confirmation in the next section a gate before mainnet, not a courtesy.

### Verdicts by use and program

| Use | DLMM | DBC | DAMM v2 | Alpha Vault |
| - | - | - | - | - |
| 1. Call the deployed programs through the SDKs | Allowed, thin | Allowed | Allowed | Allowed, thin |
| 2. Generate client bindings from the published IDLs | Allowed, thin | Allowed | Allowed | Allowed, thin |
| 3. CPI from our own program with `declare_program!` and an IDL | Allowed, thin | Allowed from the SDK's MIT IDL; not allowed through the program crate's `cpi` feature | Allowed from the SDK's MIT IDL; not allowed through the program crate's `cpi` feature | Allowed, thin |
| 4. Dump deployed binaries for local tests | Not allowed without permission | Not allowed on the text; unclear for Meteora's MIT copy | Not allowed on the text; unclear for Meteora's MIT copy | Not allowed without permission |
| 5. Copy or fork program source | Not allowed (source not public) | Not allowed | Not allowed | Not allowed (source not public) |
| Terms of Service, for every use above | Needs written approval | Needs written approval | Needs written approval | Needs written approval |

"Thin" means the only grant is the `"license": "ISC"` field in the npm package: the GitHub repository has no licence file and the package ships no licence text.
Rows 1 to 5 are the code licences; the last row is the Terms of Service overlay, which applies whatever the code licence says.

### 1. Calling the deployed programs through the SDKs

- The DBC and DAMM v2 SDKs are MIT, which grants the right "to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software" (`LICENSE` in `dynamic-bonding-curve-sdk` and `damm-v2-sdk`, also shipped in both npm tarballs).
- `@meteora-ag/dlmm` 1.9.14 and `@meteora-ag/alpha-vault` 1.1.16 declare `"license": "ISC"` on npm, but neither tarball contains a licence file and neither GitHub repository has one (npm metadata, tarball listing, GitHub API).
- ISC grants "Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee", "provided that the above copyright notice and this permission notice appear in all copies" (SPDX licence text); Meteora ships no such notice.
- `ISC` is also the value `npm init` writes by default (npm `init-license` config, default "ISC"), so the field may be a default rather than a choice (inference).
- On the program side, the Meteora licence only covers acts "that would otherwise infringe the licensor's copyright", and defines "**Use** means anything you do with the software requiring one of your licenses" (`license.md` in `dynamic-bonding-curve` and `damm-v2`).
- Sending a transaction to a deployed program does not copy, change or distribute its code on our side, so on the licence's own wording it does not look like a "Use"; whether that holds in law is a question for a lawyer.
- Meteora's SDK READMEs draw the same line: "This SDK is released under the MIT License. The on-chain Dynamic Bonding Curve, DAMM, and related programs are licensed separately and are not covered by this MIT license." (`dynamic-bonding-curve-sdk` `README.md`, added 2026-09-15).
- Meteora designs DBC for exactly this use: "DBC is built for launchpads that want repeatable token launch templates" (docs `core-products/dbc/what-is-dbc.mdx`).

### 2. Generating client bindings from the published IDLs

Where each IDL is published, and under which licence:

| Program | IDL under a permissive licence | Other copies |
| - | - | - |
| DBC | `packages/dynamic-bonding-curve/src/idl/dynamic-bonding-curve/idl.json` in `dynamic-bonding-curve-sdk` (MIT), and embedded in the npm bundle (`dist/index.js` holds the IDL object with `address: "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN"`) | `scripts/idl/release_*.json` in the program repository, under the non-commercial licence |
| DAMM v2 | `src/idl/cp_amm.json` in `damm-v2-sdk` (MIT), and embedded in the npm bundle | Built from `programs/cp-amm` in the non-commercial repository |
| DLMM | Embedded in the `@meteora-ag/dlmm` npm bundle (ISC field) | `idls/dlmm.json` and `ts-client/src/dlmm/idl/idl.json` in `dlmm-sdk`, which has no licence |
| Alpha Vault | Embedded in the `@meteora-ag/alpha-vault` npm bundle (ISC field) | `idls/alpha_vault.json` in `alpha-vault-sdk`, which has no licence |

- GitHub's own docs on unlicensed repositories: "without a license, the default copyright laws apply, meaning that you retain all rights to your source code and no one may reproduce, distribute, or create derivative works from your work"; what GitHub's terms add is that "other users of GitHub.com have the right to view and fork your repository".
- So the licensed copy of the DLMM and Alpha Vault IDLs is the one inside the npm package, not the JSON file on GitHub.
- Meteora's docs tell outside integrators to use the IDLs:
  - DLMM: "The stable integration contract is the published DLMM IDL and the official SDK behavior." and "Prefer generated CPI bindings from the DLMM IDL." (`developer-guides/dlmm/rust-integration/cpi.mdx`).
  - DAMM v2: "Prefer generated CPI bindings from the `cp-amm` IDL.", with the IDL linked as `damm-v2-sdk/src/idl/cp_amm.json` (`developer-guides/damm-v2/rust-integration/cpi.mdx`).
  - DBC: "If you are outside the repository, generate bindings from the published IDL and pin the IDL version you tested against." (`developer-guides/dbc/rust-integration/cpi.mdx`).
- Open point: an IDL is generated from the program source, and no text says whether Meteora counts it as part of "this SDK" (MIT) or of the programs "licensed separately"; this is the first thing to confirm.
- Third parties already publish such bindings under MIT: `carbon-meteora-dbc-decoder`, `carbon-meteora-damm-v2-decoder` and `carbon-meteora-dlmm-decoder` 2.0.0 by sevenlabs-hq (crates.io metadata).

### 3. CPI from our own program with `declare_program!`

- `declare_program!` reads `/idls/<name>.json` at compile time and generates `cpi`, `client`, `accounts`, `types`, `events` and other modules, with no dependency on the target program's crate (Anchor docs, "Dependency Free Composability").
- Meteora uses this pattern itself: `declare_program!(dlmm);` in `dlmm-sdk` `commons/src/lib.rs`, `declare_program!(alpha_vault);` in `alpha-vault-sdk` `programs/alpha-vault/src/lib.rs`, and the DBC program calls DAMM v2 through `declare_program!(damm_v2);` in `libs/damm-v2/src/lib.rs`.
- From the MIT IDLs (DBC, DAMM v2) this is allowed, on MIT's one condition: "The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software", so the MIT notice travels with the pinned IDL.
- From the DLMM and Alpha Vault IDLs it is allowed on the npm `ISC` field only.
- Not allowed: the other route Meteora's docs show, compiling the program crate with its `cpi` feature, for example `dynamic-bonding-curve = { git = "https://github.com/MeteoraAg/dynamic-bonding-curve", package = "dynamic-bonding-curve", features = ["cpi"] }` (DBC CPI guide) or `cp-amm = { path = "../programs/cp-amm", features = ["cpi"] }` (DAMM v2 CPI guide).
- That route builds the licensed source into our binary, which is a new work based on the software, allowed only "for any permitted purpose", and the licence adds: "All copies of the original software and modified works based on the software, and derivative works of the same, are subject to this license."
- The Alpha Vault guide's route, `alpha-vault = { path = "../alpha-vault/programs/alpha-vault", features = ["cpi"] }`, points at Meteora's five-line `declare_program!(alpha_vault)` crate in an unlicensed repository; writing that line ourselves against the npm IDL avoids depending on it.

### 4. Dumping deployed binaries for local tests

- DBC and DAMM v2: the deployed programs are built from the licensed repositories (`declare_id!("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN")` in `programs/dynamic-bonding-curve/src/lib.rs`, `declare_id!("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG")` in `programs/cp-amm/src/lib.rs`), so a dumped binary is a copy of "the software", and "All copies ... are subject to this license".
- Testing is a permitted purpose only as "Personal use for research, experiment, and testing for the benefit of public knowledge, ... without any anticipated commercial application", which a commercial launchpad's test suite is not.
- The licence keeps fair use: "You may have "fair use" rights for the software under the law. These terms do not limit them."; whether interoperability testing is fair use is a legal question.
- DLMM and Alpha Vault: their source is not public and no licence covers their binaries, so default copyright applies, and the Terms of Service add that you may not "reproduce, distribute, or otherwise commercialise any elements of the Materials without our prior written consent" (section 5.1(b)).
- A complication: Meteora itself publishes all four binaries in its MIT-licensed `meteora-invent` repository (`studio/src/tests/artifacts/`), loading `dynamic_bonding_curve.so` and `cp_amm.so` under their real ids and `lb_clmm.so` and `alpha_vault.so` under the localnet ids `LbVRzDTvBDEcrthxfZ4RL6yiq3uZw8bS6MwtdY6UhFQ` and `SNPmGgnywBvvrAKMLundzG6StojyHTHDLu7T4sdhP4k` (`studio/package.json`, script `start-test-validator`).
- The DBC and DAMM v2 binaries there were last updated on 2026-02-08 and 2026-07-31, after the program licences were added (GitHub commit history).
- `dlmm-sdk` (`artifacts/lb_clmm.so`, `commons/tests/artifacts/lb_clmm_prod.so`) and `alpha-vault-sdk` (`artifacts/alpha_vault.so`, `cp_amm.so`, `lb_clmm.so` and others) also ship binaries, with no licence.
- No text says whether `meteora-invent`'s MIT licence covers the program binaries committed in it or the program licence's "All copies" clause wins, so even that route is unclear.
- What needs no copy at all: integration tests that run against devnet itself, which is use 1.

### 5. Copying or forking program source

- DBC and DAMM v2: not allowed for a commercial launchpad.
  The licence grants the right "to make changes and new works based on the software for any permitted purpose", and the permitted purposes are noncommercial ones.
  Its route for noncommercial organisations excludes "any organization which is affiliated with a blockchain project or protocol".
- This includes the Rust crates inside those repositories, DBC's `dynamic-bonding-curve-sdk/` quote crate and DAMM v2's `rust-sdk/`, because the licence covers "the software at https://github.com/MeteoraAg/dynamic-bonding-curve" (and `damm-v2`) as a whole.
- A breach ends every grant at once: "If your use of the software does not comply with the requirements as described in this license, all your licenses end immediately." (Meteora removed the standard licence's 32-day cure period, see "The program licence against PolyForm" below.)
- DLMM and Alpha Vault: the program source is not public (`MeteoraAg/dlmm`, `MeteoraAg/lb_clmm` and `MeteoraAg/alpha-vault` return 404), and the Terms of Service forbid you to "modify, adapt, translate, decompile, disassemble or reverse engineer any portion of the App" (section 6.1(i)).
- For all four, section 5.1(c) adds: "you shall not modify, make derivative works of, disassemble, reverse compile or reverse engineer any part of the Materials".

### The Terms of Service

- The terms are offered by Meteora Nova Limited, under the laws of the British Virgin Islands (preamble and section 14.1).
- "The Smart Contracts and the Site are collectively referred to in these Terms as (the "App")." (introduction).
- They claim to bind anyone who touches the contracts: "BY USING THE APP, THE SMART CONTRACTS, THE SITE, OR ANY PART OF THEM ... YOU ARE CONFIRMING THAT YOU UNDERSTAND AND AGREE TO BE BOUND BY ALL OF THESE TERMS."
  Whether that binds a party that never opens Meteora's site is a legal question.
- They name their own way out: "THESE TERMS GOVERN YOUR USE OF THE APP, THE SMART CONTRACTS, AND THE SITE, UNLESS WE HAVE EXECUTED A SEPARATE WRITTEN AGREEMENT WITH YOU FOR THAT PURPOSE."
- Clauses a launchpad meets on their face:
  - 5.2: the licence granted is "to use the site and the App for your personal use".
  - 6.1(h): you may not "exploit the App for any unauthorised commercial purpose".
  - 6.1(q): you may not "access or use the App by automated means", which reads on keepers, cranks and indexers.
  - 6.1(r): you may not use the App for "creating or enabling a party to create a product or service that is competitive with any of our products or services".
  - 6.2(d): "you create and interact with Liquidity Pools for your own account and shall not do the same on behalf of any other entity or person", which reads on a launchpad, or its program's PDA, creating pools for creators.
  - 6.2(k): "you will not use the Site, the App and the Smart Contracts for any commercial purpose (save as approved by the Company in writing)".
  - Restricted Territory: the App and Smart Contracts are "strictly NOT offered to persons or entities who reside in, are citizens of, are incorporated in, or have a registered office in any Restricted Territory", a list that starts "the British Virgin Islands, the United States, China".
- The same terms describe Meteora as running "on open-source self-executing software" (section 2.3), while DLMM and Alpha Vault source is not public and DBC and DAMM v2 source is non-commercial.

### What existing commercial launchpads do

- Meteora says it "has integrated 14 launchpads" and that on DBC "20% of fees accrues as revenues to Meteora, and the remaining fees accrues to the Launchpad partners", naming Believe, PMX.Trade and Helpdotfun with Bags (Meteora Genesis Summary, 2025-10-21).
- Its Manifesto says "community tokens (Jupiter Studio), charity tokens (Bags.App), startups (BelieveApp) have all launched with Meteora" (2025-09-17).
- Jupiter: Meteora calls the relationship "purely strategic", with "engineering resource sharing for joint ventures such as Jupiter Studio" (Genesis Summary).
  Jupiter keeps forks `jup-ag/dynamic-bonding-curve` (created 2025-04-09; `main` at "Release 0.1.6" of 2025-08-19, before the licence; other branches such as `jupiter` and `chore/sync_release_v0.2.2`) and `jup-ag/damm-v2`, which carries `license.md` (GitHub API).
  What Jupiter's arrangement with Meteora says is not public (**unverified**).
- Bags: its public SDK `@bagsfm/bags-sdk` 1.4.4 (MIT) depends on `@meteora-ag/dynamic-bonding-curve-sdk` 1.3.5 and `@meteora-ag/cp-amm-sdk` 1.1.0, both MIT, which is use 1 (npm metadata).
- Believe: no public code was found, so how it integrates is **unverified**.
- Moonshot: Meteora's post "Meteora x Moonshot: A New Meta for Memecoin Launchpads" (2024-12) covers Memecoin Pools on DAMM v1, before DBC existed; only secondary sources such as iq.wiki place Moonshot on DBC (**unverified**).
- These integrations started before the program licences existed: DBC "Launched in Apr 2025, 422K+ tokens have been launched using Meteora's DBC till date" (Genesis Summary), while the licence files were added on 2026-01-07 (DAMM v2) and 2026-02-06 (DBC).
- Whether any of these launchpads signed a written agreement with Meteora is not public (**unverified**).
- Another launchpad, Crypto Library, asked Meteora in public on 2026-10-15 "whether there is any fee or commercial requirement for provisioning a private static DAMM v2 config"; the issue had no answer from Meteora by 2026-10-26 (`MeteoraAg/damm-v2` issue #235).

### What Meteora has said publicly

- The only public statement found about the program licences is the SDK README line quoted above, added to `dynamic-bonding-curve-sdk`, `damm-v2-sdk` and `dynamic-fee-sharing-sdk` on 2026-09-15.
- The pull requests that added the licences say almost nothing: DAMM v2 #174 reads "Introduce License file for DAMM V2 as per Clarence's draft." and DBC #178 has no description; neither has a review or comment; both are by GitHub user `0xSoju2` (display name "Soju").
- Web searches (WebSearch, firecrawl, including x.com) and `gh search issues` and `gh search prs` across the MeteoraAg organisation found no other statement.
- Meteora's June 2025 builder fund post tells teams building on DBC and DAMM v2 to "reach out to `@Sojuuuu54` on TG" (2025-06-05); whether that is the same Soju as the licence author is **unverified**.

## What to ask Meteora to confirm in writing

Send it to Meteora's launchpad partnerships contact (the Genesis Summary names the Meteorite Collective as the team that "drives launchpad partnerships"), and keep the reply.
A draft:

> Hi Meteora team,
>
> We are building Top-pad, a commercial fair-launch launchpad on Solana that will use DLMM, Alpha Vault, DBC and DAMM v2, and we want to stay inside your licences and Terms of Service.
> Could you confirm in writing, or send us your partner agreement, that a commercial launchpad may do the following?
>
> 1. Use your deployed programs commercially, through your SDKs and through our own Anchor program, as the approval in section 6.2(k) of your Terms of Service; including automated keepers and indexers (6.1(q)), and creating pools, configs, vaults and escrows on behalf of our creators, from our backend or our program's PDA (6.2(d)).
> 2. Generate client code and Anchor `declare_program!` CPI bindings from the IDLs shipped in `@meteora-ag/dynamic-bonding-curve-sdk` and `@meteora-ag/cp-amm-sdk` (MIT) and in `@meteora-ag/dlmm` and `@meteora-ag/alpha-vault` (ISC), and deploy a program that calls yours; and that those IDLs are not covered by the Meteora Non-commercial Licence.
> 3. Run your program binaries in our local and CI tests, dumped from devnet or mainnet under their real program ids or taken from `meteora-invent`, without redistributing them.
> 4. Rely on the ISC licence declared for `@meteora-ag/dlmm` and `@meteora-ag/alpha-vault` (will a licence file be added to `dlmm-sdk` and `alpha-vault-sdk`?).
> 5. Build a launchpad on your programs without it counting as "a product or service that is competitive with any of our products or services" (6.1(r)).
>
> We will not copy or fork your program source, or use the Rust crates in the `dynamic-bonding-curve` and `damm-v2` repositories.
> Is anything else needed from us, such as a partner config, a fee arrangement or a signed agreement?

## What this means for the build until Meteora answers

- Off-chain code uses Meteora's TypeScript SDKs and keeps their licence notices.
- Our program reaches Meteora's programs only through `declare_program!` modules built from IDLs taken from the SDK packages, each pinned with its package name, version and licence; it never depends on the `dynamic-bonding-curve` or `cp-amm` crates.
- Whether the DLMM and Alpha Vault JSON files on GitHub match the IDL objects inside the npm bundles of the same version is **unverified**; pin the copy from the package.
- The backend does no Rust quoting with Meteora's Rust crates; event decoding from pinned IDLs, as #9 recommends, is use 2 and allowed.
- Integration tests run against devnet; no Meteora binary is committed to Top-pad's public repository, because distributing copies is a further act beyond running them.
  Surfpool-style local forks that fetch program accounts from an RPC also make a local copy, so they fall under use 4 (inference).
- Mainnet waits for Meteora's written answer.

## Questions the findings raise for the map

- Partner agreement: does Top-pad need a signed agreement with Meteora Nova Limited before mainnet, and what does it cost (fee share, private configs)?
  Legal work is out of scope for this map, but the devnet proof plan depends on Meteora's answer about testing.
- Acting for creators: section 6.2(d) reads on our program's PDA creating DLMM pools, Alpha Vault escrows or DBC pools for creators, which is the open "program authority" question under "Our own on-chain program's scope"; Meteora's written answer should cover it before that ticket is decided.
- Restricted Territory: the terms exclude entities "incorporated in" the British Virgin Islands or the United States, among others, so the jurisdiction of whatever entity operates Top-pad matters for the mainnet charting.
- Testing closed-source programs: until Meteora answers, the devnet proof plan should assume integration tests on devnet itself, with dumped binaries or `meteora-invent` artifacts only after written permission.
- Rust quoting in the backend: Meteora's Rust quote crates are non-commercial, so the backend either runs the MIT TypeScript SDK math or has its own Rust implementation written from the IDLs and docs.

## Findings

### Licence inventory

GitHub API and npm registry, read on 2026-10-26.

| Repository or package | Licence | Licence file and date added | What it holds |
| - | - | - | - |
| `MeteoraAg/dynamic-bonding-curve` | "Meteora Non-commercial Licence" (GitHub: `NOASSERTION`) | `license.md`, 2026-02-06 (#178) | DBC program source, the Rust quote crate `dynamic-bonding-curve-sdk/`, IDLs of other programs (`idls/damm_v2.json`, `idls/locker.json` and others), past DBC IDLs in `scripts/idl/` |
| `MeteoraAg/damm-v2` | "Meteora Noncommercial Licence", same text as DBC apart from the repository URL | `license.md`, 2026-01-07 (#174) | DAMM v2 program source `programs/cp-amm`, the Rust quote crate `rust-sdk/` |
| `MeteoraAg/dynamic-bonding-curve-sdk` | MIT, "Copyright (c) 2026 Meteora" | `LICENSE` and `packages/dynamic-bonding-curve/LICENSE`, 2026-09-15 | TS SDK; IDLs of DBC, DAMM v1, DAMM v2 and Dynamic Vault in `packages/dynamic-bonding-curve/src/idl/` |
| `MeteoraAg/damm-v2-sdk` | MIT, "Copyright (c) 2026 Meteora" | `LICENSE`, 2026-09-15 | TS SDK; `src/idl/cp_amm.json` |
| `MeteoraAg/dlmm-sdk` | None | None | TS, Rust and Python clients; `idls/dlmm.json`; `artifacts/lb_clmm.so`; `commons/tests/artifacts/lb_clmm_prod.so`; `commons` crate with `declare_program!(dlmm)` |
| `MeteoraAg/alpha-vault-sdk` | None | None | TS client; `idls/alpha_vault.json`; `artifacts/` with `alpha_vault.so`, `cp_amm.so`, `lb_clmm.so`, `dynamic_amm.so`, `dynamic_vault.so`, `metaplex.so`; `programs/alpha-vault` crate with `declare_program!(alpha_vault)` |
| `MeteoraAg/meteora-invent` | MIT, "Copyright (c) 2025 Meteora" | `LICENSE.md`, 2025-07-07 | Studio, fun-launch scaffold, 14 program binaries in `studio/src/tests/artifacts/` |
| `MeteoraAg/dynamic-fee-sharing-sdk` | MIT | `LICENSE` | TS SDK |
| `cpi-examples`, `zap-program`, `zap-sdk`, `dynamic-fee-sharing`, `presale-sdk`, `damm-v1-sdk`, `vault-sdk`, `dbc-go`, `damm-v2-go`, `docs`, `audits`, `met-lock-sdk`, `stake-for-fee-sdk`, `liquidity-distributor-sdk`, `merkle-distributor-sdk` (all `MeteoraAg/`) | None | None | Not used by Top-pad's four programs except as references |
| `MeteoraAg/dlmm`, `MeteoraAg/lb_clmm`, `MeteoraAg/alpha-vault` | Not public | GitHub returns 404 | - |
| npm `@meteora-ag/dynamic-bonding-curve-sdk` 2.0.0 | MIT | `package/LICENSE` in the tarball | Bundle embeds the DBC IDL |
| npm `@meteora-ag/cp-amm-sdk` 1.5.1 | MIT | `package/LICENSE` in the tarball | Bundle embeds the DAMM v2 IDL |
| npm `@meteora-ag/dlmm` 1.9.14 | ISC (field only) | None in the tarball | Bundle embeds the DLMM IDL (`address: "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo"`) |
| npm `@meteora-ag/alpha-vault` 1.1.16 | ISC (field only) | None in the tarball; no `repository` field | Bundle embeds the Alpha Vault IDL (`address: "vaU6kP7iNEGkbmPkLmZfGwiGxd4Mob24QQCie5R9kd2"`) |

- Before the 2026 licence files, the DBC and DAMM v2 repositories had no licence file at all: their only `license.md` commits are the ones above, and no `LICENSE` or `LICENSE.md` path appears in their history (GitHub commits API).
- A crates.io search ("meteora", "dynamic-bonding-curve", "cp-amm") found no crate for these four programs published from a MeteoraAg program repository; one crate, `meteora-dlmm-solana-client` 1.0.2 (MIT, published by `sergey-capt`), gives `https://github.com/MeteoraAg` as its repository, and whether it is Meteora's is **unverified**.

### The program licence against PolyForm Noncommercial 1.0.0

Meteora's text is the PolyForm Noncommercial License 1.0.0 with these changes (diff against `polyformproject/polyform-licenses` `PolyForm-Noncommercial-1.0.0.md`):

- The licence names its scope: "the software at https://github.com/MeteoraAg/dynamic-bonding-curve" (or `damm-v2`).
- Added: "All other rights not expressly granted to you are reserved by the licensor."
- The distribution grant is narrowed to "for any permitted purpose".
- Added: "All copies of the original software and modified works based on the software, and derivative works of the same, are subject to this license. This license applies separately for each version of the software (and may contain variations across versions)."
- The noncommercial-organisations clause gains "(save for any organization which is affiliated with a blockchain project or protocol)".
- PolyForm's 32-day cure period ("your licenses can nonetheless continue if you come into full compliance with these terms ... within 32 days of receiving notice") is replaced by "all your licenses end immediately".
- The required notice reads: "All underlying software code is subject to the licence set out at https://github.com/MeteoraAg/dynamic-bonding-curve".

## Sources

Repositories (GitHub API, read 2026-10-26; commit read):

- `MeteoraAg/dynamic-bonding-curve` `91e696eef6a3764157220f6c104f079b7830fc04` (2026-10-16): `license.md`, `README.md`, `programs/dynamic-bonding-curve/Cargo.toml`, `programs/dynamic-bonding-curve/src/lib.rs`, `dynamic-bonding-curve-sdk/Cargo.toml`, `libs/damm-v2/src/lib.rs`, `libs/locker/src/lib.rs`, file tree; PR #178; commit history of `license.md`, `LICENSE`, `LICENSE.md`.
- `MeteoraAg/damm-v2` `5398b5c7c534de014091132da37c6478cce671a8` (2026-10-15): `license.md`, `programs/cp-amm/Cargo.toml`, `programs/cp-amm/src/lib.rs`, file tree; PR #174; issue #235; commit history of licence paths.
- `MeteoraAg/dynamic-bonding-curve-sdk` `3a965ec0c0a527c2be3c48b8b479366705bf4926` (2026-10-22): `LICENSE`, `packages/dynamic-bonding-curve/LICENSE`, file tree; commit `b067180e5f` (README licence lines).
- `MeteoraAg/damm-v2-sdk` `7ba4162ed925c609b6737010ecd73835edf7b2cd` (2026-10-22): `LICENSE`, file tree; commit `0e93d506ac`.
- `MeteoraAg/dlmm-sdk` `af36dd53ab180783ccecda306926189a4700953c` (2026-10-23): `README.md`, `ts-client/package.json`, `commons/Cargo.toml`, `commons/src/lib.rs`, `cli/Cargo.toml`, file tree.
- `MeteoraAg/alpha-vault-sdk` `1bfa0c8277b336d5ee80e698970696bab5829873` (2026-10-22): `README.md`, `ts-client/package.json`, `programs/alpha-vault/src/lib.rs`, `programs/alpha-vault/Cargo.toml`, file tree; history of `artifacts/*.so`.
- `MeteoraAg/meteora-invent` `dd77ef3d5aede3f0ff21d566d052097200417f5e` (2026-09-20): `LICENSE.md`, `studio/package.json`, `scaffolds/fun-launch/README.md`, `skills/meteora/SKILL.md`, file tree; history of `studio/src/tests/artifacts/*.so`.
- `MeteoraAg/docs` `ceee4762690067f7b42d2fc5c4994470d432f1bd` (2026-10-26), the source of docs.meteora.ag: `resources/legal/terms-of-service.mdx` (last changed 2026-05-27), `developer-guides/{dbc,damm-v2,dlmm,alpha-vault}/rust-integration/cpi.mdx`, `core-products/dbc/what-is-dbc.mdx`.
- Licence metadata via `gh api repos/<repo>` for every MeteoraAg repository named above, and for `jup-ag/dynamic-bonding-curve` and `jup-ag/damm-v2`.
- `polyformproject/polyform-licenses` `76a278c402bc43b8d2b561da140b0f3e17263015`: `PolyForm-Noncommercial-1.0.0.md`.
- `spdx/license-list-data` `main`: `text/ISC.txt`.

Registries:

- npm (`npm view`, `npm pack`): `@meteora-ag/dlmm` 1.9.14, `@meteora-ag/alpha-vault` 1.1.16, `@meteora-ag/dynamic-bonding-curve-sdk` 2.0.0 and 1.3.5, `@meteora-ag/cp-amm-sdk` 1.5.1 and 1.1.0, `@bagsfm/bags-sdk` 1.4.4.
- crates.io API: search for "meteora", "dynamic-bonding-curve" and "cp-amm"; `meteora-dlmm-solana-client`, `carbon-meteora-dbc-decoder`, `carbon-meteora-damm-v2-decoder`.

Web pages:

- GitHub Docs, "Licensing a repository": https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository
- npm Docs, config `init-license`: https://docs.npmjs.com/cli/v10/using-npm/config
- Anchor Docs, "Dependency Free Composability": https://www.anchor-lang.com/docs/features/declare-program
- Meteora, "Meteora Genesis Summary (21 October 2025)": https://meteoraag.medium.com/meteora-genesis-summary-21-october-2025-3a9d914c437f (read from the owner's knowledge base copy, `raw/meteora-blog/`)
- Meteora, "The Meteora Manifesto" (2025-09-17): https://meteoraag.medium.com/the-meteora-manifesto-15791b7f3857 (knowledge base copy)
- Meteora, "We're allocating $1M to accelerate teams building Meteora Capital Markets on Solana." (2025-06-05): https://meteoraag.medium.com/were-allocating-1m-to-accelerate-teams-building-meteora-capital-markets-on-solana-6d6c296bc5ad (knowledge base copy)
- Meteora, "Meteora x Moonshot: A New Meta for Memecoin Launchpads": https://meteoraag.medium.com/meteora-x-moonshot-a-new-meta-for-memecoin-launchpads-9917b833a940 (knowledge base digest, `meteora/04-blog-history-and-announcements.md`)

Knowledge base (canonical, read-only): `/Volumes/Farhan/Work Folder/Dev/AI/Research-Projects/jupiter-meteora`, files `github-repos.md`, `meteora/01-products-and-protocol.md` section 16.3, `meteora/04-blog-history-and-announcements.md`.
