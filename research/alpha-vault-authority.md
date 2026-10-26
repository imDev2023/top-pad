# Alpha Vault by simulation: can our program be its authority, can the allowlist change after deposits open, is an escrow's cap fixed?

Research for ticket #25 of the Top-pad wayfinder map (issue #1), captured 2026-10-26.
It builds on the DLMM Fair Open research ([research/dlmm-fair-open.md][dlmm-fo], ticket #3) and the bundle detection research ([research/bundle-detection.md][bundle], ticket #5).
The Alpha Vault program `vaU6kP7iNEGkbmPkLmZfGwiGxd4Mob24QQCie5R9kd2` is closed source, so every claim below rests on four kinds of evidence:

1. **IDL and SDK source:** `alpha_vault` IDL 0.4.1 and `@meteora-ag/alpha-vault` at commit [`1bfa0c8`][sdk] (the head of `main` on 2026-10-26).
2. **On-chain history:** every vault, Merkle root config and relevant transaction on mainnet and devnet, read through Helius on 2026-10-26.
3. **Live simulations:** `simulateTransaction` against the live program on current mainnet and devnet state, with `sigVerify: false` and `replaceRecentBlockhash: true`, labelled L1 to L11 and D1 to D2.
4. **Local replay:** the deployed program bytes, dumped from mainnet and from devnet, run in LiteSVM 0.8.0 under the real program id, on real mainnet accounts, with the clock moved back inside each vault's deposit window, labelled R1 to R40.
   A small native program of ours, compiled for SBF, forwards calls into Alpha Vault and signs for its own PDAs with `invoke_signed`, labelled C1 to C7.

No transaction was signed with a real key, and nothing was sent to any cluster.
Claims that could not be checked are marked **Unverified**.

## Answer

**1. Can a PDA of our program be the vault authority that creates capped escrows for anyone, so per-wallet caps hold on chain without a published allowlist?**
**Yes.**
- C3: our compiled program calls `create_permissioned_escrow_with_authority(max_cap 1 USDC)` through CPI, its PDA signs with `invoke_signed`, and Alpha Vault logs `success`, leaving an escrow with `max_cap 1000000`.
- C4: the same call with the wrong seeds, so the PDA does not sign, fails with `AccountNotSigner` (3010) on `payer`.
- R8 to R10: the escrow's cap then binds every deposit, and a deposit into a full escrow fails with `DepositAmountIsZero` (6017).
- Two mainnet programs already run this in production, with a PDA as vault authority and every escrow created through CPI (E3).

**2. Can a second `MerkleRootConfig` version be created after `depositing_point`, so late registrants can be added?**
**Yes**, until `last_join_point`.
- R24: `create_merkle_root_config(version 1)`, signed by the vault authority 3 h after `depositing_point`, logs `success`.
- R26: an escrow against that new root logs `success`.
- R35: a root created after `last_join_point` is accepted, but an escrow against it fails with `NotPermitThisActionInThisTimePoint` (6004).
- On mainnet, vault `BpnZsa8z...` created root v1 839 s after its deposits opened, and 2,787 later transactions used it (E4).

**3. Is an escrow's `max_cap` fixed once the escrow is created, or can the authority change it?**
**Fixed**, with one exception that needs the owner.
- No instruction edits `max_cap` (IDL).
- R5 and R29: re-creating the escrow with a higher cap, by the authority or through a new Merkle root, fails with `Allocate: account ... already in use` (custom error 0).
- The exception: in Pro Rata, inside the window, the owner can withdraw to zero (R14) and close the escrow (R15), and the authority can then create a new escrow with a new cap (R16).

**4. Can the authority stop a wallet from depositing again after its escrow exists, or revoke a slot before the buy?**
**No**, unless our program also owns the escrow.
- R11: `close_escrow` signed by the authority fails with `ConstraintHasOne` (2001).
- R13: `update_prorata_vault_parameters` signed by the authority fails with `InvalidAdmin` (6013).
- R18: deposits still succeed after the authority moves to another key.
- If each escrow's owner is a per-user PDA of our program, our program can withdraw and close the slot before `last_join_point` (R39, C7), and a later deposit to that slot fails with `AccountOwnedByWrongProgram` (3007, R40).

The mainnet and devnet program binaries hash differently, but all 47 replayed steps give identical results on both, down to the source line in each error (E6).

### 1. A PDA as the vault authority

- The IDL has no separate authority account on `create_permissioned_escrow_with_authority`; `payer` is its only signer, and it must equal `vault.vault_authority` ([IDL L602][idl-ewa]; the SDK passes the authority as `payer`, [index.ts L831][sdk-ewa]).
  Any other payer fails with `InvalidCreator` (6030), raised on the `payer` account (R1, R6, live L5).
- The callee only sees `is_signer` on the account, so an off-curve PDA signing through `invoke_signed` satisfies the check (C3), and a PDA that did not sign does not (C4: 3010 `AccountNotSigner`).
- The PDA pays the escrow's rent, 1,341,120 lamports for 136 bytes, so it must be a system-owned account holding lamports when the call runs (live L3: an unfunded PDA fails with `Transfer: insufficient lamports 0, need 1341120`; L4 funds it in the same transaction and passes the authority check).
  Anchor creates the escrow account before it checks `payer`, so an unfunded wrong payer fails on the transfer before it reaches 6030 (L3 compared with L5).
- There are two ways to make a PDA the authority, and both run in production:
  - **Born with it:** a program signs `initialize_prorata_vault` with its PDA as both `funder` and `base`, which makes the PDA the authority from the start (mainnet vault `fkJ21Ucr...` on DAMM v2, E3).
  - **Handed over:** a keypair creates the vault, then calls `transfer_vault_authority(new_authority = PDA)` (devnet vault `3LyASVto...`, E3).
    The transfer has no time restriction: it succeeds mid-window (R3) and long after the vault ended (live L1); any other signer fails with `ConstraintHasOne` (2001, R2, L2).
- For a DLMM launch, use the hand-over route.
  On customizable DLMM pools the vault's `base` equals the pool creator ([DLMM research E3][dlmm-fo]), and the pool creator must hold the base token ([DLMM research E3][dlmm-fo]).
  A keypair creates the pool and the vault, then transfers the authority to our PDA (R3 shows the transfer works on a DLMM vault, inside the deposit window).
  Whether all three fit in one transaction is **Unverified**, and so is whether a PDA could create the DLMM pool itself.
- So per-wallet caps are enforced on chain without a published allowlist.
  Our program decides who gets an escrow and its cap; Alpha Vault enforces the cap on every deposit (R8 to R10).
- Production precedent: since early October 2026, mainnet programs `2nHzAKCrTNyyau8h3bMnszQohmmc4p8Ar893371JD5Hv` (instruction `Join`, from 2026-10-06) and `83YHJYXu85Yj9JewVYcDAV8oXQ37Jc1MPhL73HwrWLTV` (instruction `AddVoice`, seen 2026-10-08) create every escrow of their vaults through CPI, with their PDA as `payer`, while the user is the only transaction signer (E3).
  All 46 and 55 escrows carry one equal cap, and none exceeds it (E3).

### 2. New Merkle roots after deposits open

- `create_merkle_root_config` has no time check.
  It succeeds 3 h into the window (R24), 1 h after `last_join_point` (R34), and on live mainnet 6 days after `depositing_point` (L7).
- A root is only useful until `last_join_point`: an escrow against a root created later fails with `NotPermitThisActionInThisTimePoint` (6004, R35).
- Version numbers need not be consecutive (R34 makes v4 while v3 does not exist; mainnet vaults hold versions `[0, 3]` and `[0, 2]`, E4).
- A version cannot be overwritten: re-creating v0 or v1 fails with `already in use` (R25, L8).
- Only the vault authority or a Meteora program admin may create a root; any other key fails with `InvalidAdmin` (6013, R23, L9; [docs][docs-access]).
- Mainnet precedent: vault `BpnZsa8zx3D9DSTRapsVNmT9WvtdW4iWGhwrDEj6PZMj` created root v1 at 09:13:59 UTC on 2025-07-21, 839 s after its deposits opened at 09:00:00, and 2,787 successful transactions referenced that root over the next three days (the vault holds 2,786 escrows), while root v0 was never used (E4).
  Vault `Gu1onXKo...` created its root v4 3,748 s after opening (E4).
- So late registrants can be added until `last_join_point`, but roots stay append-only.
  The program has no close instruction for root configs (IDL), and a published root stays usable for the whole window.

### 3. An escrow's cap

- No instruction writes `max_cap` after creation: of the 27 IDL instructions, only the two permissioned escrow-creation instructions take a `max_cap` argument (IDL).
- The escrow is a PDA of `["escrow", vault, owner]` ([SDK][sdk-derive]), so a second creation for the same owner always collides, whatever the mode:
  - authority mode, higher cap: `already in use` (R5);
  - Merkle mode, a new root listing the wallet at 100 USDC: `already in use` (R29);
  - a real mainnet escrow re-created against a fresh root: `already in use` (R30);
  - live mainnet, a PDA-authority vault's existing escrow at a 100 SOL cap: `already in use` (L10).
- A new root therefore cannot raise or lower the cap of a wallet that already has an escrow.
- A wallet listed in two roots with different caps chooses at creation: R33 lists U4 at 1 USDC in v5 and 50 USDC in v6, and U4's escrow is created with `max_cap 50000000`.
- Deposits clamp to the remaining cap rather than fail: depositing 0.6 USDC twice against a 1 USDC cap takes 0.6, then 0.4 (R8, R9), and once the cap is full a deposit fails with `DepositAmountIsZero` (6017, R10, R32).
- The only way to change a cap: in Pro Rata, inside the window, the owner withdraws everything (R14), the owner closes the escrow (R15; with a deposit still in it, `EscrowIsNotClosable` 6006, R12), and the authority creates a new escrow with a new cap (R16).
  The owner must sign the close, so the authority cannot do this alone.
- A cap of 0 is rejected with `MaxDepositingCapIsTooSmall` (6035, R7).

### 4. Stopping or revoking a wallet

- The authority has no instruction that touches an existing escrow (IDL).
  `close_escrow` needs the owner: signed by the authority it fails with `ConstraintHasOne` (2001, R11, live L11 on a production PDA-authority vault).
- The authority cannot shrink the vault either: `update_prorata_vault_parameters` is for Meteora's admin only, `InvalidAdmin` (6013, R13, L6), so `max_buying_cap` and the vesting points are fixed at vault creation for us.
- `deposit` needs only the owner's signature and the escrow (IDL accounts), and moving the authority to another key does not stop it (R17, R18).
- Deposits and escrow creation stop only at the time bounds: 60 s before `depositing_point` and 1 s after `last_join_point`, both fail with 6004 (R20 to R22).
- The way around this is a custody design: our program creates each escrow with the owner set to a per-user PDA of ours, and users deposit through our program.
  Then our program signs as the owner, so it can withdraw the deposit and close the escrow before the buy (R39 top level, C5 to C7 through a real CPI), and the revoked slot cannot be deposited into again (R40).
  Devnet programs `8rpDepKoKd8jKPWwdSUFYv2zrFrVdrD1aX8pDdgUtWzU` and `EqFHHYMip7ZGdHH9QBw1T8bnTdsnMZ4jJReGZ2QFR5mV` (instruction `BuyIntoVault`) already create escrows owned by their own PDAs and deposit for them through CPI (E3).
  This needs Pro Rata, because FCFS has no normal withdrawal ([KB 6.3][kb]).

## What this means for per-wallet caps on chain

- **Authority mode with our PDA works today.**
  Alpha Vault enforces each escrow's cap on chain; our program is the gatekeeper that decides who may join and at what cap.
  No allowlist needs to be published, and anyone who passes our program's rule can join until `last_join_point`.
- **The cap is per wallet, not per person.**
  Anyone who can call our join instruction from many wallets gets many escrows, so the join rule must carry the person check: a personhood attestation, a server co-signature, or a one-seat-per-person PDA keyed on the attestation ([bundle detection][bundle]).
  This is a design consequence, not a tested feature.
- **Decide the cap before the escrow exists.**
  Once created, a cap cannot be lowered, so a cluster found by detection after a wallet joined cannot be shrunk, and in plain authority mode it cannot be removed either.
- **Keep the power to revoke only with custody.**
  If revoking a slot or merging clusters before the buy matters, our program must own each escrow through a per-user PDA.
  This answers part of the map's open question (Alpha Vault as the pre-activation buyer, or a small program of ours that can revoke a slot): with custody, Alpha Vault stays the buyer and our program still gains the revoke.
  The cost is that our program then holds every escrow and must route claims and refunds back to users, so a bug in our program can lock or misroute buyers' funds.
  Claims and refunds through a custody PDA were not run (**Unverified**, see below).
- **Merkle mode remains the weaker option for caps.**
  Late registrants can be added, but nothing can be removed or lowered, a wallet listed twice takes the larger cap, and Meteora's program admins can also append roots to any vault ([docs][docs-access]).
- **Rent:** the PDA pays 1,341,120 lamports (about 0.00134 SOL) per escrow, recoverable only through `close_escrow`, whose `rent_receiver` the owner chooses (IDL).
  The production `Join` flow has the user send 0.01 SOL to the PDA, the PDA pays the escrow's rent, and the PDA refunds the remaining 8,658,880 lamports to the user in the same instruction (E3).
- **Program risk:** Alpha Vault is upgradeable, by `JADaUV8kvDpDbJr55wxXJHVaBS3VCj8thZZHjfeuCVLd` on mainnet and `5unTfT2kssBuNvHPY6LbJfJpLqEcdMxGYLWHwShaeTLi` on devnet, so this behaviour holds for the binaries deployed at slots 349,243,341 and 387,997,458 and should be re-checked before launch (E1).

## Unverified and open

- `claim_token` and `withdraw_remaining_quote` signed by a custody PDA through CPI, after a real fill: the same owner-signer check applies, but neither was run.
- Every replay used Pro Rata vaults; FCFS behaviour under authority and custody was not replayed.
- Whether a PDA can create a customizable DLMM pool (the token launch proof from a PDA-owned token account), which would let the vault be born with a PDA `base` on DLMM.
- Whether a Meteora program admin can create authority-mode escrows: the docs list admins for roots and metadata only, and the 6030 check compares `payer` with the vault authority.
- Who runs the mainnet programs `2nHzAK...` and `83YHJY...`; neither publishes an on-chain Anchor IDL (E3).
- Replay overrides: cloned account state is from 2026-10-26, not from inside the window; vault `HgS8Rog...` never created its quote token account on mainnet, so the replay created it empty; test wallets and our PDA were given lamports and USDC.
- A devnet run of our own program would still need: a deployed devnet program, a devnet DLMM customizable pool with a Pro Rata authority vault whose deposits open a few minutes ahead, `transfer_vault_authority` to the PDA, then join, deposit, revoke, crank the fill, and claim through the custody PDA, cranked by our own wallet since nobody else cranks devnet ([DLMM research][dlmm-fo]).

## Evidence

### E1. Versions, binaries and method

- IDL `alpha_vault` 0.4.1, 27 instructions, at `idls/alpha_vault.json` in [`1bfa0c8`][sdk]; the local copy matches GitHub's blob `c14552ee`.
- Program data `EHSLhL1F25toWAyL967Vp9ZDvdxNUK2KbJHjHZZkXLC6`: mainnet deploy slot 349,243,341 (2025-06-26), upgrade authority `JADaUV8k...`, dumped bytes SHA-256 `2e4540af...`; devnet deploy slot 387,997,458 (2025-06-16), upgrade authority `5unTfT2k...`, SHA-256 `70cbc051...`.
- Replay: LiteSVM 0.8.0 (npm), signature verification off, the dumped binary loaded at `vaU6kP7i...`, accounts cloned from mainnet at slots 461,732,540 and 461,732,543, the clock's `unix_timestamp` set inside the window.
- Our stand-in program is a 31,912-byte native SBF program built with `cargo-build-sbf` (solana-program 2.2.1), loaded at `5sWP3Qiugw77bt7LLGjAJi1ukTZSJaCK1cSFniMBPMw`; it forwards one instruction and signs with seeds `["vault_authority"]` (PDA `S8idH23mGu3GKm9wGpWWbGyjYnMqurJSm3FmqwtZpRE`) or `["custody", user]`.
- Live simulations went through Helius RPC on mainnet slots 461,733,871 to 461,733,935 and devnet slots 515,392,955 to 515,392,961.

### E2. IDL and SDK facts

- `create_permissioned_escrow_with_authority(max_cap)`: accounts `vault`, `pool`, `escrow` (PDA), `owner`, `payer` (signer, writable), `system_program`, `event_authority`, `program` ([IDL L602][idl-ewa]).
- `transfer_vault_authority(new_authority: pubkey)`: accounts `vault` and `vault_authority` (signer) ([IDL L1379][idl-tva]).
- `create_merkle_root_config({root, version})`: `admin` signer, root config PDA `["merkle_root", vault, version as u64 LE]` ([IDL L379][idl-mrc], [SDK L1198][sdk-mrc]).
- `close_escrow`: `owner` signer and a `rent_receiver` ([IDL L101][idl-close]); `deposit(max_amount)`: `owner` signer, no authority account ([IDL L715][idl-dep]).
- `update_prorata_vault_parameters({max_buying_cap, start_vesting_point, end_vesting_point})`: `admin` signer ([IDL L1445][idl-upd]).
- No IDL instruction closes a `MerkleRootConfig` or updates an escrow's `max_cap`.
- Merkle leaf: `sha256(0x00 || sha256(owner || max_cap as u64 LE))`, sorted-pair parents, so a one-leaf tree's root is the leaf and its proof is empty ([balance-tree.ts L31][sdk-leaf]).
- The SDK's authority test creates escrows after waiting for `DEPOSITING` ([test L145-L147][sdk-test]).

### E3. Production PDA authorities (on-chain history)

- Of 1,244 mainnet vaults, 530 are authority mode (469 on DAMM v2), and 3 have an off-curve authority; of 1,828 devnet vaults, 304 are authority mode and 77 have an off-curve authority (decoded with the SDK's coder, curve test with `PublicKey.isOnCurve`).
- Mainnet vault `fkJ21UcrGGsF62P4CgNDipUDQaVJK5Ay8gayVnWMydS` (DAMM v2, Pro Rata): created on 2026-10-06 at 20:08:14 UTC by a CPI from `2nHzAK...` into `initialize_prorata_vault` with `funder` and `base` both the PDA `J7Hj3ebEhH3pZWbicURTNSkUcdger6JejEwUJKuz9VrG`, in transaction `3o5vaLFMBnn3whzFmF8f5ZKf3o39cihxKjkwiwy2wgcrhKdGFSpbhLg4y3J38UV4Q8EkBBYZ2E4soUzq3tZoGae7`.
- Its escrow `cQg4Y639xAw6j13CUwsxobvyvmyJmnFJMwpX6SYVX8p` was created in transaction `j9apvxQumNaAaiZW8xDvVnZnnW8vEGEEjU8YunGu4APacdgZanABXTUZDbBUXX5gX9p91Zu8Umz67bb9hHC1cLZ`, signed only by the owner `GsSJUj...`, in which:
  - `2nHzAK...` logs `Instruction: Join`;
  - the user transfers 10,000,000 lamports to the PDA;
  - Alpha Vault logs `CreatePermissionedEscrowWithAuthority` with `payer` the PDA, which creates the 136-byte escrow for 1,341,120 lamports;
  - the PDA returns 8,658,880 lamports to the user;
  - the user then calls `deposit` at top level.
- All 46 escrows of that vault have `max_cap` 1,282,051,282 lamports, and none holds more than its cap.
- Mainnet vault `E5rmTS7xMdn2imSc5ZZiCZqnpmq9CojjkkAi2mVkHhzb`: authority and `base` are the PDA `2j7Dx9iweSTWfhunocc1MtexMRN3peHVZiWg58PhkXg8`, its escrows are created through CPI from `83YHJY...` (`Instruction: AddVoice`, transaction `4hiu6oo8SwKR2GkHb95dStQTBKJEn3qfkBwwVu1BWwjX4RFkULwoYfXqyzNSvnUS3GwbLQWZYnLTbKWArb9A6fwc`, 2026-10-08), and all 55 escrows hold one cap of 1,025,641,025.
- Devnet vault `3LyASVtoEAXaMBf4yWRu8dFr5NfYVX33txaY3vnCdNRm`: created by keypair `6u165g...` on 2026-06-22 at 01:03:44 UTC, which 6 s later called `transfer_vault_authority(7RzUsnkfSYNqoM9RawbnCh4JzFhqTRfsHzW6C6pv4dPr)` (transaction `2NrcMGpceiofUVxwoCStgBLHpB8jAg9B57CCV8fFy5gVTuwvv14oPE4zVjFPax5GeMXQt2WEtnBm2c92q1K8kN3x`), after which `8rpDep...` (`Instruction: BuyIntoVault`) created escrows and deposited into them through CPI.
- The owners of those devnet escrows (`4pDvSU...`, `A7vN14...`) and of vault `BHs7hn...` (program `EqFHHY...`) are off-curve, so those programs hold the escrows themselves.
- None of the four calling programs has an on-chain Anchor IDL account.

### E4. Merkle root versions on mainnet

- 287 mainnet root configs across 199 vaults; 11 vaults have more than one version, up to 44.
- Vault `BpnZsa8zx3D9DSTRapsVNmT9WvtdW4iWGhwrDEj6PZMj` (Pro Rata Merkle, authority `2iit3Y...`): `depositing_point` 2025-07-21 09:00:00 UTC.
  - Root v0 was created at 08:24:36, and no later transaction referenced it.
  - Root v1 was created at 09:13:59 (+839 s) in transaction `2pT8YEJzhgBVrtn98y3PULkGD4pVrQqcLdHVAkEiBv9Q913CdM9GM4JqFo5xFXyZb2BrmL2WnaAAANNHWrAnwuPS`, signed by the authority.
  - 2,787 later successful transactions referenced v1, from 09:17:27 to 2025-07-24 08:26:08, the first being `create_permissioned_escrow` plus `deposit` (`2n5MJVTLEkZ3RMvpP3QFvoPRkx98JRHzcjPdY1myh6zrGMnGBaWuUdDjTs5CBxtxTCz4vKADZjD4pHinMT3LYUBu`).
- Vault `Gu1onXKo8XxCZbXbJj8jG3GVDL9JrL1Qs6yRo9JknRQ5`: root v4 created 2026-02-12 at 03:02:28, 3,748 s after `depositing_point`, in transaction `4pMX58ezt6s4oP6hDWGNnJMJBRVw3AEThLh8WwEVRNG4d3GLbrK88217CckkxLATzE6dFbFG9e4R431AR5vWyQzw`.
- Vaults `HNmH5ZjC...` and `3xXtsXui...` hold versions `[0, 3]` and `[0, 2]`.
- Root counts per vault and creation times come from `getProgramAccounts` with a vault filter and the oldest signature of each root config account.

### E5. Live simulations on current state

| Id | Cluster, vault | Transaction | Response |
| - | - | - | - |
| L1 | mainnet `HgS8Rog...` (DLMM, Pro Rata, authority, ended 2025-03-10) | `transfer_vault_authority(our PDA)` as authority `2yRC3SXX...` | `success` |
| L2 | same | same, signed by a random key | 2001 `ConstraintHasOne` |
| L3 | same | `transfer_vault_authority` then escrow creation with our unfunded PDA as payer | `Transfer: insufficient lamports 0, need 1341120` |
| L4 | same | fund our PDA with 0.01 SOL, transfer authority, create escrow with PDA payer | ix 2: 6004 `NotPermitThisActionInThisTimePoint` (authority check passed, window closed) |
| L5 | same | fund a random key, create escrow with it as payer | 6030 `InvalidCreator`, account `payer` |
| L6 | same | `update_prorata_vault_parameters` as the vault authority | 6013 `InvalidAdmin` |
| L7 | mainnet `8fDs4V...` (DLMM, Pro Rata, Merkle, window closed 2026-10-20) | `create_merkle_root_config(version 1)` as its authority | `success` |
| L8 | same | `create_merkle_root_config(version 0)` (exists) | `already in use` |
| L9 | same | fund a random key, `create_merkle_root_config(version 1)` as it | 6013 `InvalidAdmin` |
| L10 | mainnet `fkJ21U...` (production PDA authority) | escrow creation for an existing owner at a 100 SOL cap, payer the PDA `J7Hj3e...` | `already in use` |
| L11 | same | `close_escrow` signed by the PDA authority | 2001 `ConstraintHasOne`, account `escrow` |
| D1 | devnet `3LyASV...` (authority PDA `7RzUsn...`) | `transfer_vault_authority(our PDA)` signed by the PDA | `success` |
| D2 | same | same, signed by its former keypair authority | 2001 `ConstraintHasOne` |

### E6. Local replay inside the deposit window

Authority mode, vault `HgS8RogmnL3h71tejTkNpawoKAAr663SdYCRc6UX1ren` (DLMM, Pro Rata, USDC), clock 2025-03-09 16:40 UTC (window 16:30 to 01:55):

| Id | Transaction | Response |
| - | - | - |
| R1 | escrow for U1 with our PDA as payer, before it is the authority | 6030 `InvalidCreator` |
| R2 | `transfer_vault_authority(our PDA)` by a random key | 2001 `ConstraintHasOne` |
| R3 | `transfer_vault_authority(our PDA)` by the real authority, mid-window | `success`, 1,259 CU |
| R4 | `create_permissioned_escrow_with_authority(1 USDC)` for U1, payer our PDA | `success`, `max_cap 1000000` |
| R5 | the same for U1 again at 50 USDC | `already in use` |
| R6 | escrow for U2 with the old authority as payer | 6030 |
| R7 | escrow for U2 with `max_cap 0` | 6035 `MaxDepositingCapIsTooSmall` |
| R8 | U1 deposits 0.6 USDC | `success` |
| R9 | U1 deposits 0.6 USDC again | `success`, escrow total 1.0 USDC, 0.4 taken |
| R10 | U1 deposits 0.1 USDC with the cap full | 6017 `DepositAmountIsZero` (`deposit.rs:54`) |
| R11 | `close_escrow` of U1 signed by our PDA | 2001 `ConstraintHasOne` |
| R12 | `close_escrow` by U1 holding a deposit | 6006 `EscrowIsNotClosable` (`close_escrow.rs:29`) |
| R13 | `update_prorata_vault_parameters` by our PDA | 6013 `InvalidAdmin` |
| R14 | U1 withdraws 1 USDC | `success`, escrow total 0 |
| R15 | `close_escrow` by U1 with zero deposit | `success`, escrow gone |
| R16 | escrow for U1 again at 5 USDC, payer our PDA | `success`, `max_cap 5000000` |
| R17 | `transfer_vault_authority(K)` by our PDA | `success` |
| R18 | U1 deposits 2 USDC under the new authority | `success` |
| R19 | `transfer_vault_authority(our PDA)` by K | `success` |
| R20 | escrow for U2, 60 s before `depositing_point` | 6004 (`activation.rs:189`) |
| R21 | escrow for U2, 1 s after `last_join_point` | 6004 (`activation.rs:193`) |
| R22 | U1 deposits, 1 s after `last_join_point` | 6004 (`activation.rs:193`) |

Merkle mode, vault `8fDs4VnU789XcSsGkKmZRjd6UZ3FBHqJGtyCpmtqEPMA` (DLMM, Pro Rata, USDC, one real escrow of 5,000 USDC), clock 2026-10-20 12:00 UTC (window 09:00 to 14:25):

| Id | Transaction | Response |
| - | - | - |
| R23 | root v1 = leaf(U3, 2 USDC) by a random key | 6013 `InvalidAdmin` |
| R24 | the same by the vault authority, 3 h after opening | `success` |
| R25 | root v1 again with another root | `already in use` |
| R26 | U3 creates an escrow against v1 with an empty proof | `success`, `max_cap 2000000` |
| R27 | U4 (not in v1) claims 9 USDC against v1 | 6026 `InvalidProof` |
| R28 | root v2 = leaf(U3, 100 USDC) | `success` |
| R29 | U3 creates an escrow against v2 | `already in use` |
| R30 | root v3 for the real escrow owner `EtU4Y5...`, then its escrow | ix 1: `already in use` |
| R31 | U3 deposits 5 USDC | `success`, escrow total 2 USDC |
| R32 | U3 deposits 1 USDC with the cap full | 6017 |
| R33 | roots v5 = leaf(U4, 1 USDC) and v6 = leaf(U4, 50 USDC), then U4's escrow against v6 | `success`, `max_cap 50000000` |
| R34 | clock 1 h after `last_join_point`: root v4 | `success` |
| R35 | U5's escrow against v4 | 6004 (`activation.rs:193`) |

Custody design, vault `HgS8Rog...`, with our PDA as the authority and the escrow owned by U6's custody PDA:

| Id | Transaction | Response |
| - | - | - |
| R36 | `transfer_vault_authority(our PDA)` | `success` |
| R37 | escrow with owner = custody PDA, payer our PDA, 3 USDC | `success` |
| R38 | deposit 3 USDC from the custody PDA's token account | `success` |
| R39 | `withdraw(3 USDC)` then `close_escrow`, custody PDA signing | `success`, escrow gone, 10 USDC back in custody |
| R40 | deposit into the revoked slot | 3007 `AccountOwnedByWrongProgram` |

Real CPI through our compiled program, vault `HgS8Rog...`:

| Id | Transaction | Response |
| - | - | - |
| C1 | CPI escrow creation, PDA signing, before the authority transfer | 6030 |
| C2 | top level `transfer_vault_authority(our PDA)` | `success` |
| C3 | CPI `create_permissioned_escrow_with_authority(1 USDC)`, PDA signs with `invoke_signed` | `success`, 23,718 CU, `max_cap 1000000` |
| C4 | the same with custody seeds, so the authority PDA does not sign | 3010 `AccountNotSigner`, account `payer` |
| C5 | CPI escrow for owner = custody PDA, payer the authority PDA | `success` |
| C6 | CPI deposit of 3 USDC, custody PDA signing as owner | `success` |
| C7 | CPI `withdraw` then `close_escrow`, custody PDA signing | `success`, escrow gone |

All 47 steps give the same outcome and error text, including source line numbers, with the devnet binary.

### E7. Docs and knowledge base

- Meteora's docs: "The Merkle root account is versioned, so teams can publish multiple root versions for the same vault when needed"; the vault authority "can ... Transfer vault authority to a new pubkey"; program admins "also create Merkle root configs or metadata" ([whitelist and access][docs-access], mirrored in the owner's knowledge base).
- The knowledge base records the roles and error codes ([KB dev 03, Alpha Vault][kb-dev]; [KB 6.4][kb]) but not the timing, immutability and CPI behaviour above.

[dlmm-fo]: https://github.com/imDev2023/top-pad/blob/research/dlmm-fair-open/research/dlmm-fair-open.md
[bundle]: https://github.com/imDev2023/top-pad/blob/research/bundle-detection/research/bundle-detection.md
[sdk]: https://github.com/MeteoraAg/alpha-vault-sdk/tree/1bfa0c8277b336d5ee80e698970696bab5829873
[idl-ewa]: https://github.com/MeteoraAg/alpha-vault-sdk/blob/1bfa0c8277b336d5ee80e698970696bab5829873/idls/alpha_vault.json#L602
[idl-tva]: https://github.com/MeteoraAg/alpha-vault-sdk/blob/1bfa0c8277b336d5ee80e698970696bab5829873/idls/alpha_vault.json#L1379
[idl-mrc]: https://github.com/MeteoraAg/alpha-vault-sdk/blob/1bfa0c8277b336d5ee80e698970696bab5829873/idls/alpha_vault.json#L379
[idl-close]: https://github.com/MeteoraAg/alpha-vault-sdk/blob/1bfa0c8277b336d5ee80e698970696bab5829873/idls/alpha_vault.json#L101
[idl-dep]: https://github.com/MeteoraAg/alpha-vault-sdk/blob/1bfa0c8277b336d5ee80e698970696bab5829873/idls/alpha_vault.json#L715
[idl-upd]: https://github.com/MeteoraAg/alpha-vault-sdk/blob/1bfa0c8277b336d5ee80e698970696bab5829873/idls/alpha_vault.json#L1445
[sdk-ewa]: https://github.com/MeteoraAg/alpha-vault-sdk/blob/1bfa0c8277b336d5ee80e698970696bab5829873/ts-client/src/alpha-vault/index.ts#L831
[sdk-mrc]: https://github.com/MeteoraAg/alpha-vault-sdk/blob/1bfa0c8277b336d5ee80e698970696bab5829873/ts-client/src/alpha-vault/index.ts#L1198
[sdk-derive]: https://github.com/MeteoraAg/alpha-vault-sdk/blob/1bfa0c8277b336d5ee80e698970696bab5829873/ts-client/src/alpha-vault/helper/index.ts#L147
[sdk-leaf]: https://github.com/MeteoraAg/alpha-vault-sdk/blob/1bfa0c8277b336d5ee80e698970696bab5829873/ts-client/src/alpha-vault/merkle_tree/balance-tree.ts#L31
[sdk-test]: https://github.com/MeteoraAg/alpha-vault-sdk/blob/1bfa0c8277b336d5ee80e698970696bab5829873/ts-client/src/test/dlmm_authority_prorata_slot.test.ts#L145-L147
[docs-access]: https://docs.meteora.ag/helper-products/alpha-vault/whitelist-and-access
[kb]: https://github.com/imDev2023/jupiter-meteora-resources/blob/main/meteora/01-products-and-protocol.md
[kb-dev]: https://github.com/imDev2023/jupiter-meteora-resources/blob/main/meteora/03-dev-dbc-vaults-launch.md
