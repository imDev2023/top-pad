# Can Fair Open run end to end on a DLMM launch, on devnet?

Research for ticket #3 of the Top-pad wayfinder map (issue #1), captured 2026-10-26.
Sources are Meteora's live docs (fetched 2026-10-26 and unchanged in substance from the 2026-10-04 snapshot in the owner's Jupiter + Meteora knowledge base), the source of the TypeScript SDKs `@meteora-ag/dlmm` (repo `MeteoraAg/dlmm-sdk` at [`af36dd5`](https://github.com/MeteoraAg/dlmm-sdk/tree/af36dd53ab180783ccecda306926189a4700953c), npm 1.9.14) and `@meteora-ag/alpha-vault` (repo `MeteoraAg/alpha-vault-sdk` at [`1bfa0c8`](https://github.com/MeteoraAg/alpha-vault-sdk/tree/1bfa0c8277b336d5ee80e698970696bab5829873), npm 1.1.16), the published IDLs (`lb_clmm` 0.12.0, `alpha_vault` 0.4.1), Meteora Invent (`MeteoraAg/meteora-invent` at [`dd77ef3`](https://github.com/MeteoraAg/meteora-invent/tree/dd77ef3d5aede3f0ff21d566d052097200417f5e)), and on-chain reads of mainnet and devnet through Helius on 2026-10-26.
Both programs are closed source, so where a rule mattered it was checked by simulating a transaction against the live mainnet program with signature verification switched off; nothing was signed or sent.
Claims that could not be checked are marked **Unverified**.

Naming note: GLOSSARY's **Creator lock** is the cap on the creator's own buy plus its release; ticket item 5 is a different thing, the lock on the seeded liquidity position, called the **seed lock** below.

## Answer

Yes, with three caveats.
Every step in the ticket runs today, on mainnet and on devnet, with Meteora's own programs: a customizable permissionless DLMM pool (the "DLMM Launch Pool") plus an Alpha Vault in Pro Rata mode.
Caveat 1: vault depositors all get one average price, but the public opens at the higher marginal price the vault's buy leaves behind (1.8x on CLOUD, 8.1x on a 2026 launch), unless the vault's whole buy fits inside one seeded bin.
Caveat 2: per-wallet caps work only in Merkle or authority mode, so an open-to-everyone capped sale needs our own program (or server) as the vault authority.
Caveat 3: DLMM has no opening fee scheduler and a hard 10% total fee cap, and nobody is obliged to crank the vault's buy, so Top-pad must run its own cranker and cannot get a pump-style anti-sniper fee from DLMM.

### The five capabilities

| # | Capability | Verdict | SDK call (instruction) |
| - | - | - | - |
| 1 | Seed the whole supply single-sided along a chosen curve | Yes | `DLMM.createCustomizablePermissionlessLbPair2` (`initialize_customizable_permissionless_lb_pair2`), then `dlmm.seedLiquidity` or `dlmm.seedLiquiditySingleBin` (`initialize_bin_array`, `initialize_position_by_operator`, `add_liquidity_one_side_precise2`) |
| 2 | Open at a set time, no trading before it | Yes | `activationType` and `activationPoint` of `createCustomizablePermissionlessLbPair2`, with `creatorPoolOnOffControl = false` |
| 3 | Deposit window, one price for all, pro rata, per-wallet caps, optional Merkle allowlist | Partly | `AlphaVault.createCustomizableProrataVault` (`initialize_prorata_vault`), `deposit`, `withdraw`, `fillVault` (`fill_dlmm`), `withdrawRemainingQuote`; caps via `createMerkleRootConfig` or `createStakeEscrowByAuthority` |
| 4 | Release the vault's tokens gradually | Yes, linear only | `startVestingPoint` and `endVestingPoint` of the vault, `claimToken` (`claim_token`) |
| 5 | Lock the creator's position so buyers' SOL cannot be withdrawn | Yes | the `lockReleasePoint` argument of `seedLiquidity` (`initialize_position_by_operator(lower_bin_id, width, fee_owner, lock_release_point)`) |

**1. Seeding.**
`seedLiquidity(owner, seedAmount, curvature, minPrice, maxPrice, base, payer, feeOwner, operator, lockReleasePoint, shouldSeedPositionOwner)` deposits only the base token across bins from `minPrice` to `maxPrice` (E2).
The SDK's curve is one family: the tokens placed below price p are `seedAmount x ((p - minPrice) / (maxPrice - minPrice))^(1 / curvature)`, so curvature below 1 puts more tokens near the top and above 1 near the start (E2).
Any other shape is possible because `add_liquidity_one_side_precise2` takes an explicit per-bin amount list; a custom builder for it is **Unverified** (untested).
`minPrice` may not be below the pool's active price, seeding must finish before activation, and the seed is split into 70-bin positions, each with its own lock (E2).
Only a wallet holding a non-zero balance of the base token, and by inference of the quote token too, can create the pool, because the program demands a "token launch owner proof" (E3).

**2. Opening time.**
The activation point is fixed at pool creation, and with an Alpha Vault it must lie between about 70 minutes and about 31 days ahead (simulated, E3).
The creator cannot move it, nor the pre-activation window or buyer (simulated `UnauthorizedAccess`, E3); only Meteora's admin can.
Until activation nobody can swap except the Alpha Vault, and the vault only in the last 3,600 seconds (or 9,000 slots), a fixed program default (E3).
With `creatorPoolOnOffControl = true` the creator could pause the pool before open, so Top-pad should create pools with it off (E3).

**3. Fair Open sale.**
A Pro Rata vault takes deposits from `depositing_point` until `activation - 3,600 s - 300 s`; users may withdraw freely until then (E4).
In the last hour any cranker calls `fill_dlmm`, which buys from the pool with `min(total_deposit, max_buying_cap)` of quote and minimum-out 0 (E4, E5).
Every escrow gets `bought_token x escrow.total_deposit / vault.total_deposit`, so all depositors pay one average price, pro rata, and the overflow is refunded (E4).
Permissionless Pro Rata has no per-wallet cap (the vault stores `u64::MAX`); Merkle mode (leaf = wallet + `max_cap`) and authority mode (authority creates each escrow with a `max_cap`) enforce caps on chain, proven on the HUMA vault where none of 3,567 escrows exceeds its cap (E4).
So caps come only with an allowlist (Merkle) or with escrows the vault authority creates; for a sale open to everyone with caps, the vault authority (transferable by `transfer_vault_authority`) would have to be our program's PDA that creates a capped escrow for any wallet that asks; **Unverified** (untested design).
The vault's buy walks up the bins, so the public opening price is the marginal price after the buy, above the vault's average (E5).
Seeding one bin at the opening price that is large enough to absorb `max_buying_cap` (with `seedLiquiditySingleBin`), and the curve above it, would make the vault price equal the opening price and avoid the dynamic fee on the vault's buy; **Unverified** (untested design).

**4. Release.**
Claims unlock linearly from `start_vesting_point` to `end_vesting_point` (inclusive; equal points release everything at once), capped at about one year on mainnet, and the start may not precede activation (E6).
There is one schedule for every depositor, with no cliff other than a later start.

**5. Seed lock.**
A locked position rejects every liquidity removal with `LiquidityLocked` (6055) while its fee owner can still claim fees (both simulated on a live locked position, E7).
`u64::MAX` is accepted, which is a permanent lock: 84 mainnet positions carry it (E7).
No instruction changes `lock_release_point` later (E7).
The buyers' SOL sits in the locked position's bins, so it stays in the pool as liquidity for sellers and cannot be pulled by the creator.

### Cost per launch

Rent at the 2026-10-26 mainnet rate, which devnet matches (E9).

| Item | SOL | Who pays, refundable? |
| - | - | - |
| Pool: `LbPair` (904 B) + `Oracle` (3,232 B) + 2 reserve token accounts | 0.0253 | creator; not refundable |
| Each 70-bin seed position (8,120 B) | 0.0419 | seeder; refundable only by closing the position, so never under a permanent lock |
| Each bin array (70 bins, 10,136 B) | 0.0521 | first user to touch the bins (the seeder); `close_bin_array` can reclaim an empty one |
| Bin-array bitmap extension, only for extreme prices | 0.0086 | seeder |
| Alpha Vault (472 B) + its 2 token accounts | 0.0060 | creator |
| Merkle root config (144 B) | 0.0014 | vault authority |
| Escrow (136 B), per depositor | 0.0013 | depositor, or the vault authority in authority mode; refundable by `close_escrow` |
| Crank fee, per fill transaction | 0.0001 | cranker, to Meteora's treasury (waived for whitelisted crankers) |
| Escrow fee, per escrow | 0 to 0.01 | permissionless vaults only, to Meteora's treasury; Merkle and authority vaults must charge 0 |

Seed rent depends on bin step and price range (one position and about one bin array per 70 bins):

| Price range | Bin step 25 | Bin step 100 | Bin step 250 | Bin step 400 |
| - | - | - | - | - |
| 100x | 2.59 SOL | 0.71 SOL | 0.33 SOL | 0.24 SOL |
| 1,000x | 3.81 SOL | 0.99 SOL | 0.43 SOL | 0.33 SOL |
| 10,000x | 5.04 SOL | 1.37 SOL | 0.62 SOL | 0.43 SOL |

Two real 2026 launches need 0.56 SOL (6 positions, 6 bin arrays) and 0.94 SOL (10 and 10) of seed rent at today's rate (E9).
There is no DLMM pool-creation fee: the creation instruction has no fee account (E9).
Meteora's ongoing take is 20% of every swap fee on a customizable pool for the pool's life (only its operator can change that), including the fee the vault pays on its own buy (E8).

### Limits

- Timing: pool created 70 minutes to 31 days before open; deposit window at least 1,200 s (3,000 slots); deposits close 65 minutes before open (60-minute buy window plus a 5-minute gap); so a Fair Open takes at least about 85 minutes from pool creation to trading (derived from E3 and E4).
- Caps: Pro Rata `max_buying_cap` limits what the vault spends, not what it accepts; FCFS `max_depositing_cap` and `individual_depositing_cap` limit what it accepts; lock and vesting are each capped at about one year on mainnet (E4, E6).
- Who cranks: anyone, permissionlessly; Meteora's keeper bought for launches made in its app (GOLD post-mortem), but on mainnet 29 of 192 activated customizable vaults with deposits were never filled, at least 3 of them with tokens in the pool, so Top-pad must crank its own launches (E5).
- Fill size: the SDK passes 3 bin arrays (up to 210 bins) per fill and the program allows at most 260 bins per swap; a 140-bin fill used 845,120 compute units of the 1.4M limit; wider buys need several fills, each paying the crank fee (E5).
- Price reaction: a fill walks up the curve; one 2026 fill of 326 SOL crossed 140 bins at bin step 250, a 31.7x price rise inside the vault's own buy (E5).
- Fill fee: the vault pays the pool's base fee plus the dynamic fee like any swap; that fill paid 31.95 SOL (9.8%) because the fee hit the 10% cap, 80% of it to the seed position's fee owner and 20% to Meteora (E5).
- Partial fills: if the pool runs out of tokens the vault spends less and refunds the rest (GOLD spent 2.927M of a 3M cap); 14 of 192 activated mainnet customizable vaults with deposits were partly filled (E5).
- MEV on the fill: minimum-out is 0, but nobody else can swap during the buy window, so a sandwich is not possible (inference from E3 and E5).

### What protects the first minutes

- The vault takes the cheapest bins before anyone else can trade, so snipers start from the post-vault price (E5).
- Base fee: chosen once at creation, 0.01% to 10%, and fixed for the pool's life; only Meteora's operator can change it (E8).
- Dynamic fee: every customizable launch pool opened since 2025-01-31 uses the same defaults (filter 10 s, decay 120 s, reduction 50%, variable fee control 50,000, max volatility accumulator 150,000), which the creator cannot set (E8).
  Its ceiling depends on bin step: 0.11% at bin step 10, 0.70% at 25, 2.81% at 50, 7.2% at 80, and above the 10% total cap from bin step 100 up, reached after about 14 bins crossed at bin step 100 with a 1% base fee (E8).
  It decays after 10 seconds of quiet and resets after 120 seconds, so it taxes bursts, not the first minutes as such.
- No fee scheduler exists on DLMM: no instruction or parameter for one (schedulers exist on DAMM v2 and DBC), and the total fee is capped at 10% (E8).
- The 20% launch-pool protocol share is Meteora's cut of fees, not a protection (E8).
- Bots are active at the boundary: 358 non-swap transactions hit one 2026 launch pool in the two seconds before open, and the first swaps landed 1 second after it (E10).
- Fee-aware cranking (fills spaced more than 120 s apart, each crossing few bins) would keep the variable fee off the vault's own buy; derived from the fee formula, **Unverified** (untested).

### Jupiter routing

- Jupiter lists Meteora DLMM as eligible for "instant routing": new markets are added automatically, and liquidity checks start only after a grace period based on token age (E10).
- On a 2026-05-21 launch, a Jupiter-routed swap landed 1 second after activation, among the first three swaps (E10).
- How fast Jupiter picks up a pool created only minutes before open is **Unverified**; that pool existed for more than an hour before open.
- Jupiter runs on mainnet only, so routing cannot be tested on devnet (E10).

### Devnet status today

| Piece | Works on devnet? |
| - | - |
| DLMM program `LBUZK...` | Yes, deployed 2026-06-01 (mainnet 2026-06-03), same program ID |
| Alpha Vault program `vaU6k...` | Yes, deployed 2025-06-16 (mainnet 2025-06-26), same program ID |
| Byte-identical to mainnet | No: both binaries hash differently, so parity is behavioural, not proven |
| Customizable pools with vaults | 812 on devnet; 2026 pools show the mainnet defaults (3,600 s window, 20% share, same dynamic fee) |
| A full fill | Yes: a 0.5 SOL Pro Rata fill on 2026-10-11 crossed 3 bins at a 1.45% fee with a 20% protocol share |
| SDKs and Invent studio | Yes, `cluster: "devnet"`; studio has devnet RPC and airdrop |
| Meteora devnet app and DLMM data API | Respond (`devnet.meteora.ag`, `dlmm.dev.metdev.io`) |
| Merkle proof hosting | SDK default is `worker-dev.meteora.ag`; serving our own proofs through `create_merkle_proof_metadata` is safer; **Unverified** |
| Cranking | Our own: 86 of 249 activated devnet vaults with deposits were never filled |
| Jupiter | No (mainnet only) |
| Rent | Same as mainnet |

### How Meteora's big DLMM launches were configured

All from mainnet vault and pool accounts (E12).

| Launch | Opened | Pool kind | Bin step | Base fee | Dynamic fee | Protocol share | Vault | Cap and deposits | Escrows | Claims |
| - | - | - | - | - | - | - | - | - | - | - |
| CLOUD (Sanctum, LFG) | 2024-07-18 | permission pair | 400 | 2.5% | off | 10% | Pro Rata, open | 7.5M / 31.12M USDC | 5,011 | linear over about 156 days from open |
| UPT (UpRock, LFG) | 2024-05-30 | permission pair | 80 | 2.5% | off | 10% | Pro Rata, open | 5M / 2.42M USDC | 3,663 | from about 19 h after open, over about 5 days |
| GOLD | 2025-03-20 | customizable | 50 | 0.01% | on | 20% | Pro Rata, open | 3M / 130.37M USDC | 8,655 | all at 5 minutes after open |
| HUMA (two vaults) | 2025-05-25 | permission pair | 1 | 0.01% | off | 10% | Pro Rata, Merkle | 0.75M each / 2.19M and 1.20M USDC | 3,567 and 26,568 | all at about 92 days after open |
| XLAB | 2025-08-22 | customizable | 1 | 0.01% | on | 20% | Pro Rata, Merkle | 0.6M / 1.0M USDC | 13,312 | all at about 7 days after open |
| SONIC | 2025-01-07 | customizable | 80 | 0.01% | off (pre-2025-01-31) | 20% | Pro Rata, Merkle | 0.297M / 2.97M USDC | 7,748 | 10 minutes after open, over 60 s |
| PAR | 2025-02-18 | customizable | 100 | 2% | on | 20% | Pro Rata, open | 1,500 / 1,584.6 SOL | 208 | all at 1 day after open |

Partner launches run with Meteora (CLOUD, UPT, HUMA) used operator-created permission pairs with a 10% protocol share and no dynamic fee, which Top-pad cannot create itself.
Self-serve launches use customizable pools, which always carry the 20% share.

### Unverified and open

- A custom-shape seed through `add_liquidity_one_side_precise2`, the single-bin "vault price = opening price" design, fee-aware cranking, and a program PDA as vault authority were reasoned from source and docs, not tested.
- The exact minimum and maximum activation delays with an Alpha Vault (simulation brackets them between 4,140 s rejected and 4,260 s accepted, and between 31 days accepted and 32 days rejected), and the limits without a vault.
- Whether pool creation requires a non-zero quote-token balance as well: a wallet holding the base token but no USDC failed the same proof check at a later line, which strongly suggests it, but the program is closed source.
- Whether Meteora's keeper cranks vaults not made through its app, and on devnet.
- Jupiter's pickup time for a pool created just before open.

## Evidence

### E1. Versions and deployments

- The DLMM IDL is `lb_clmm` 0.12.0 and the Alpha Vault IDL is `alpha_vault` 0.4.1 ([dlmm.json](https://github.com/MeteoraAg/dlmm-sdk/blob/af36dd53ab180783ccecda306926189a4700953c/idls/dlmm.json), [alpha_vault.json](https://github.com/MeteoraAg/alpha-vault-sdk/blob/1bfa0c8277b336d5ee80e698970696bab5829873/idls/alpha_vault.json)).
- The live changelogs list no newer program release (docs.meteora.ag `developer-guides/dlmm/changelog` and `developer-guides/alpha-vault/changelog`, fetched 2026-10-26).
- Program accounts read on 2026-10-26: DLMM `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo` was last deployed at mainnet slot 423,977,638 (2026-06-03) and devnet slot 466,305,525 (2026-06-01); Alpha Vault `vaU6kP7iNEGkbmPkLmZfGwiGxd4Mob24QQCie5R9kd2` at mainnet slot 349,243,341 (2025-06-26) and devnet slot 387,997,458 (2025-06-16).
- SHA-256 of the deployed program bytes differs between clusters (DLMM `cc25380f...` mainnet vs `d8bdaade...` devnet, ELF 2,198,017 vs 2,198,033 bytes; Alpha Vault `28fe6539...` vs `98ab8643...`, 799,433 vs 827,841 bytes).
- The live Alpha Vault pages (what-is, vault-modes, whitelist-and-access, launch-design-guide, formulas) matched the knowledge-base snapshot except for Markdown formatting (diffed 2026-10-26).

### E2. Pool creation and seeding

- `createCustomizablePermissionlessLbPair2(connection, binStep, tokenX, tokenY, activeId, feeBps, activationType, hasAlphaVault, creatorKey, activationPoint?, creatorPoolOnOffControl?, concreteFunctionType?, collectFeeMode?, opt?)` builds `initialize_customizable_permissionless_lb_pair2` and wraps 1 lamport of SOL into the creator's wSOL account when a mint is SOL ([index.ts L1635](https://github.com/MeteoraAg/dlmm-sdk/blob/af36dd53ab180783ccecda306926189a4700953c/ts-client/src/dlmm/index.ts#L1635)).
- Its `CustomizableParams` carry `active_id`, `bin_step`, `base_factor`, `activation_type`, `has_alpha_vault`, `activation_point`, `creator_pool_on_off_control`, `base_fee_power_factor`, `concrete_function_type` and `collect_fee_mode`, and no dynamic-fee or fee-schedule fields (IDL type `CustomizableParams`).
- There is one customizable pool per token pair, a PDA of `ILM_BASE` and the two mints (`deriveCustomizablePermissionlessLbPair`; knowledge base `02-dev-dlmm-damm.md` section 1.3).
- The base fee is set as `base_factor = feeBps x 10,000 / binStep` ([math.ts L36](https://github.com/MeteoraAg/dlmm-sdk/blob/af36dd53ab180783ccecda306926189a4700953c/ts-client/src/dlmm/helpers/math.ts#L36)), within the IDL constants `MIN_BASE_FEE` 100,000 (0.01%) and `MAX_BASE_FEE` 100,000,000 (10%).
- `seedLiquidity` throws `minPrice < current pair price` when the start bin is below the active bin ([index.ts L6571](https://github.com/MeteoraAg/dlmm-sdk/blob/af36dd53ab180783ccecda306926189a4700953c/ts-client/src/dlmm/index.ts#L6571)), sets `k = 1 / curvature` (L6579), and per 70-bin chunk emits `initializePositionByOperator(lowerBinId, 70, feeOwner, lockReleasePoint)` (L6780) and `addLiquidityOneSidePrecise2` with an explicit bins list (L6860).
- The per-bin amount is the difference of `getC = amount x ((binPrice - minPrice) / (maxPrice - minPrice))^k` between neighbouring bins ([math.ts L86](https://github.com/MeteoraAg/dlmm-sdk/blob/af36dd53ab180783ccecda306926189a4700953c/ts-client/src/dlmm/helpers/math.ts#L86), `generateAmountForBinRange` L211).
- The docs' UI guide says "Higher curvature concentrates more liquidity near the Initial Price", consistent with the formula (docs.meteora.ag `user-guides/creating-a-liquidity-pool`).
- `seedLiquiditySingleBin(payer, base, seedAmount, price, roundingUp, positionOwner, feeOwner, operator, lockReleasePoint, shouldSeedPositionOwner)` seeds one bin with a width-1 position ([index.ts L6989](https://github.com/MeteoraAg/dlmm-sdk/blob/af36dd53ab180783ccecda306926189a4700953c/ts-client/src/dlmm/index.ts#L6989)).
- Its doc comment says an operator can manage the position but "liquidity withdrawal issue by the operator can only send to the position owner".
- Invent's `dlmm-seed-liquidity-lfg` and `dlmm-seed-liquidity-single-bin` "only work when your DLMM launch pool is not activated yet" (docs.meteora.ag `invent/launch-pools/dlmm-launch-pool`).

### E3. Activation, pre-activation and creator powers

- `isSwapDisabled` blocks swaps on customizable and permission pairs before `activation_point`, except for `pre_activation_swap_address`, which may swap from `activation_point - pre_activation_duration` ([index.ts L7676](https://github.com/MeteoraAg/dlmm-sdk/blob/af36dd53ab180783ccecda306926189a4700953c/ts-client/src/dlmm/index.ts#L7676)).
- On mainnet, every one of 411 DLMM-type Alpha Vaults, and on devnet every one of 819, is its pool's `pre_activation_swap_address` (all vault and pool accounts decoded 2026-10-26).
- The 364 mainnet vaults on customizable pools all have `vault.base == pool.creator`, and their pools have `pre_activation_duration` 3,600 (342 timestamp pools) or 9,000 (22 slot pools).
- Across all 6,655 mainnet customizable pools, `pre_activation_duration` is 0 (no vault), 3,600 s or 9,000 slots; devnet also has 300 s and 750-slot pools, and the 401 vault-linked 300 s pools all activated between 2025-05-27 and 2025-06-30.
- Meteora's CLI files `SetActivationPoint`, `SetPreActivationDuration` and `SetPreActivationSwapAddress` under `AdminCommand` ([args.rs L163-L176](https://github.com/MeteoraAg/dlmm-sdk/blob/af36dd53ab180783ccecda306926189a4700953c/cli/src/args.rs#L163-L176)).
- Simulations on pending mainnet pool `GyKJ3u6hrNEEeHhjMwU6KQrF8E8N87B5ZYBkqKW7Bg9e` (customizable, on/off control on), signed as its creator, 2026-10-26:
  - `set_activation_point`, later or earlier: `UnauthorizedAccess` (6031).
  - `set_pre_activation_duration` and `set_pre_activation_swap_address`: `UnauthorizedAccess` (6031).
  - `set_pair_status_permissionless(disable)`: success; signed by any other key: `InvalidPoolCreator` (6094).
- The SDK documents that with `creator_pool_on_off_control` the creator "can enable/disable the pair anytime before the pool is opened" and afterwards "can only enable" ([index.ts L2322](https://github.com/MeteoraAg/dlmm-sdk/blob/af36dd53ab180783ccecda306926189a4700953c/ts-client/src/dlmm/index.ts#L2322)).
- Simulations of `initialize_customizable_permissionless_lb_pair2` with an Alpha Vault for the unused pair `xddwJXwtmWTh3WpWvYX15KyrLm957yeDXdsiGn9QerA`/USDC, 2026-10-26:
  - by a wallet holding the base token: success at 4,260 s, 4,380 s, 4,500 s, 2 h and 1, 3, 7, 14 and 31 days ahead;
  - `InvalidActivationDuration` (6059) at 600, 3,660, 3,960 and 4,140 s ahead (`pair_action_access/base.rs:85`) and at 32, 35, 40, 45, 60, 75, 90 and 366 days ahead (`initialize_customizable_permissionless_lb_pair.rs:131` in the runs logged in full);
  - by a wallet holding USDC but not the base token: `MissingTokenAmountAsTokenLaunchProof` (6060) at line 284;
  - for the pair `B8FCj8MPSzLG21yxoBff3jdZmQSZDMt8WCVZTkFUMnEQ`/USDC, by a wallet holding 1,000,000 base units and no USDC: the same error at line 289.
- The docs warn that anyone who receives the token before trading starts "can create their own pool and markets" (docs.meteora.ag `user-guides/creating-a-liquidity-pool`).

### E4. Alpha Vault deposits, modes and caps

- The SDK computes `lastJoinPoint = activationPoint - preActivationDuration - 300 s (750 slots)` and `lastBuyingPoint = activationPoint - 1` ([index.ts L89-L108](https://github.com/MeteoraAg/alpha-vault-sdk/blob/1bfa0c8277b336d5ee80e698970696bab5829873/ts-client/src/alpha-vault/index.ts#L89)).
- The docs give `3,000` slots or `1,200` seconds as the minimum deposit duration (docs.meteora.ag `helper-products/alpha-vault/what-is-alpha-vault`); the shortest deposit windows observed on chain are exactly 1,200 s and 3,000 slots, in Pro Rata and FCFS vaults alike.
- Invent's skill states the ordering "depositing <= pool activation <= startVesting <= endVesting" ([studio-actions.md L440](https://github.com/MeteoraAg/meteora-invent/blob/dd77ef3d5aede3f0ff21d566d052097200417f5e/skills/meteora/references/studio-actions.md#L440)).
- `createCustomizableProrataVault` derives the vault from `["vault", owner, pool]` with `initialize_prorata_vault` ([index.ts L360](https://github.com/MeteoraAg/alpha-vault-sdk/blob/1bfa0c8277b336d5ee80e698970696bab5829873/ts-client/src/alpha-vault/index.ts#L360)).
- Pro Rata swaps at most `min(total_deposit, max_buying_cap)`, lets users withdraw until `last_join_point`, withdraw overflow until `last_buying_point`, and take the rest with `withdraw_remaining_quote` (docs.meteora.ag `helper-products/alpha-vault/vault-modes`).
- Each escrow's allocation is `bought_token x escrow.total_deposit / vault.total_deposit` ([getClaimInfo L525](https://github.com/MeteoraAg/alpha-vault-sdk/blob/1bfa0c8277b336d5ee80e698970696bab5829873/ts-client/src/alpha-vault/index.ts#L525); docs `formulas`).
- Per-wallet cap: "Ignored for permissionless Pro Rata because the vault returns `u64::MAX` as the individual cap", "Applied in permissionless FCFS and permissioned vaults" (docs `vault-modes`); `getAvailableDepositQuota` uses the Merkle proof's `maxCap` or the escrow's `maxCap` ([L583](https://github.com/MeteoraAg/alpha-vault-sdk/blob/1bfa0c8277b336d5ee80e698970696bab5829873/ts-client/src/alpha-vault/index.ts#L583)).
- 205 of 214 mainnet DLMM Pro Rata vaults store `individual_depositing_cap = u64::MAX`.
- HUMA's Merkle Pro Rata vault `8gCqHrCcP5PxUf2fPR1nre5B9t2HjWQu6StujDCor4oW`: 3,567 escrows, 0 with `total_deposit > max_cap`, 3,356 exactly at their cap.
- GOLD's permissionless Pro Rata vault `GUrbZv7TPeRYYk38GDqidNS3NoUJUESEew22j4MUWaW`: 8,655 escrows, all `max_cap = 0`.
- Merkle leaves are "owner pubkey + max_cap", roots are versioned, the vault authority or an admin creates them, and permissioned vaults must charge no escrow fee (docs `whitelist-and-access`).
- `create_permissioned_escrow_with_authority(max_cap)` has the payer as its only signer and the SDK passes the vault authority as payer ([createStakeEscrowByAuthority L831](https://github.com/MeteoraAg/alpha-vault-sdk/blob/1bfa0c8277b336d5ee80e698970696bab5829873/ts-client/src/alpha-vault/index.ts#L831)); `transfer_vault_authority(new_authority)` is in the IDL.
- The SDK's default Merkle proof API is `worker-dev.meteora.ag` on devnet and `worker.meteora.ag` on mainnet, overridable by on-chain proof metadata (constant.ts `MERKLE_PROOF_API`).
- Escrow fees on mainnet DLMM vaults: 0 on 381, 0.01 SOL on 20, 0.005 SOL on 10; all 819 devnet vaults charge 0.

### E5. Fills: cranking, price walk and fee

- `fillDlmmTransaction` asks for 1.4M compute units, takes 3 bin arrays in the swap direction, quotes with partial fill allowed, and returns null when the pool is out of liquidity ([helper/index.ts L330-L400](https://github.com/MeteoraAg/alpha-vault-sdk/blob/1bfa0c8277b336d5ee80e698970696bab5829873/ts-client/src/alpha-vault/helper/index.ts#L330)).
- Fills are permissionless, a non-whitelisted cranker pays 0.0001 SOL, and fills call the pool swap with `minimum_amount_out = 0` (docs `launch-design-guide`); one crank-fee whitelist account exists on mainnet (owner `Gk8VSoDbJw5uveoqBHV6FP4NYPmhhhxoGU7p1R8sqHp4`).
- Invent's `crankFill` loops `fillVault` until it returns null, sent by the launcher's own wallet ([participant.ts L403](https://github.com/MeteoraAg/meteora-invent/blob/dd77ef3d5aede3f0ff21d566d052097200417f5e/studio/src/lib/alpha_vault/participant.ts#L403)).
- The GOLD post-mortem names "keeper infrastructure (that executes the buy)" and reports that the vault spent only about 2.9269M of its 3M cap because the pool held too few tokens ([Meteora, 2025-03-25](https://meteoraag.medium.com/post-mortem-gold-usdc-alpha-vault-5b388c0c6656)).
- Of 192 activated mainnet customizable timestamp vaults with deposits, 149 were fully filled, 14 partly and 29 not at all; unfilled vaults whose pools still hold tokens include `8fDs4VnU789XcSsGkKmZRjd6UZ3FBHqJGtyCpmtqEPMA`, `ABa6TtSSbTvzpJy225GfJm9hityFBx4ne3YEoLq4kiKs` and `5gwFRXL2senRsqhH24aeWfLPowUeKucHMnmACxRNCRSr`; devnet: 159, 4 and 86 of 249.
- Fill `37PQBtELohn36fsKYteBY9jyja32JPRw58DA6bhGMooPnUhcVZMH2VQKqBKrAw5jC9gWEj4ShtUQG11DJxrvU7bM` (mainnet, 2026-05-21, FCFS Merkle vault `HqbRkCTKmGzBiUzkYG8XRTL89WDPjQbDHBtxRsak6XLv`, pool `57DYHtHiYbjoboMLvZnAbymruNsW5AZ3LAPuMypu3iA`, bin step 250, 2% base fee):
  - one crank 1 hour before open swapped 326.15 SOL from bin -631 to bin -491 (140 bins) for 484.62M tokens, leaving 8.34 SOL unfilled;
  - fee 31.95 SOL with an end fee rate of 10%, protocol fee 6.39 SOL (20%);
  - 845,120 compute units;
  - vault average price 6.73e-7 SOL per token, opening bin price 5.43e-6 (8.06x the average, 31.7x the starting bin).
- Fill `2c4y84ZviP7vHFwrUA7nBMx5D6BDvrkNbbE9vgoq6xzobMP2YrDLG6bPQRGV9mnA5wk2FA9wFVQstGvNEn4EnhqD` (mainnet, 2026-10-11, Pro Rata vault `4XHvRr8Zo3GhBYsR3SHat8PUL9W2WRFfu9Y2Yt4xc9i9`, pool `HpWdga7dnyaMKszeoow98reTqcyDyuipzdfyJSBMmaGR`, bin step 100, 1% base fee): 1.0267 SOL across 5 bins, end fee rate 2.25%, protocol fee exactly 20% of the fee, cranked by a wallet that is not whitelisted.
- The program caps a swap at 260 bins since 0.12.0 (knowledge base `02-dev-dlmm-damm.md` section 1.13, from the DLMM changelog).

### E6. Vesting

- "Claims unlock linearly from `start_vesting_point` through `end_vesting_point`, with inclusive endpoints"; "the program caps lock duration and vesting duration at roughly one year" on mainnet (docs `launch-design-guide`).
- The `Vault` account holds only `start_vesting_point` and `end_vesting_point` for the schedule (IDL type `Vault`).
- On chain, `start_vesting_point - activation_point` is never below 1 s on customizable pools (0 on CLOUD's slot-based permission pair); the longest devnet vesting is 23,328,000 s (270 days).

### E7. Seed lock

- `initialize_position_by_operator(lower_bin_id, width, fee_owner, lock_release_point)` (IDL); `PositionV2.lock_release_point` is "Earliest point (slot/timestamp per pool) when locked liquidity can be withdrawn" (docs `developer-guides/dlmm/program/accounts`).
- Simulated on mainnet position `EUJeYv9JxGQ2hRBJkP8rUXzWPKt37AmVWvRN7XoTD2qK` (pool `HpWdga...`, locked to 2027-04-10, holding 1.18 SOL): `remove_liquidity_by_range2` for 100% by its owner fails with `LiquidityLocked` (6055, `remove_liquidity2.rs:227`); `claim_fee2` by its fee owner succeeds.
- 84 mainnet positions have `lock_release_point = u64::MAX`, for example `9j4J7SAK9hmgjoZ5zUzEkiLqh4kdnm9HhzdPNRK8QT8i` (a single-bin position).
- The seed positions of pool `57DYH...` are locked to 2036-05-18, those of `HpWdga...` to 2027-04-10, and none of GOLD's 35 positions is locked.
- No IDL instruction updates `lock_release_point`, and the docs say the declared event `UpdatePositionLockReleasePoint` is not emitted by any handler (docs `developer-guides/dlmm/program/events`).

### E8. Fees and protocol share

- `total fee = min(base + variable, 10%)`; `variable = ceil(variable_fee_control x (volatility_accumulator x bin_step)^2 / 1e11)`; the accumulator grows by 10,000 per bin crossed from the reference bin, keeps its reference within `filter_period`, decays by `reduction_factor` until `decay_period`, then resets (knowledge base `01-products-and-protocol.md` section 2.4, from docs `core-products/dlmm/formulas`).
- The formula with the on-chain defaults reproduces both decoded fills exactly: 1% + 1.25% = 2.25% after 5 bins at bin step 100, and the 10% cap after 140 bins at bin step 250.
- On-chain dynamic-fee parameters: all 314 mainnet customizable timestamp pools with vaults activated since 2025-01-31 have (10, 120, 5,000, 50,000, 150,000); the 28 earlier ones, 14 of the 22 slot-based ones and all 47 permission pairs have zeros; on devnet 785 of 812 have the defaults.
- Protocol share: 2,000 bps on all 364 mainnet and 812 devnet customizable pools with vaults; 1,000 or 500 bps on permission pairs; the IDL constant `ILM_PROTOCOL_SHARE` is 2,000.
- `update_base_fee_parameters` (base factor and protocol share) and `update_dynamic_fee_parameters` take an `operator` account and are operator commands in the CLI (IDL; CLI `instructions/operator/update_base_fee.rs`).
- The IDL has no fee-scheduler instruction or parameter; Meteora's docs list time and market-cap schedulers only for DAMM v2 and DBC (docs.meteora.ag llms.txt index).

### E9. Costs

- Rent-exempt minimums from mainnet `getMinimumBalanceForRentExemption` on 2026-10-26: 165 B token account 1,488,440 lamports, 904 B `LbPair` 5,242,560, 3,232 B `Oracle` 17,068,800, 10,136 B `BinArray` 52,141,120, 8,120 B `PositionV2` 41,899,840, 472 B `Vault` 3,048,000, 136 B `Escrow` 1,341,120, 144 B `MerkleRootConfig` 1,381,760; devnet returned the same values.
- Meteora updated the SDK's rent constants on 2026-10-23 (bin array 0.07144 to 0.05214 SOL, position 0.05741 to 0.04190 SOL, token account 0.00204 to 0.00149 SOL) in [commit fe37a30](https://github.com/MeteoraAg/dlmm-sdk/commit/fe37a3000fae4f9619f4f92083a180241761e1e1).
- `initialize_customizable_permissionless_lb_pair2` takes no fee-receiver account (IDL accounts: pair, bitmap extension, mints, reserves, oracle, user token accounts, funder, token badges, token programs, system program, event authority, program).
- The seed-rent table assumes one 70-bin position and one bin array per 70 bins plus one extra array; real counts: pool `HpWdga...` 6 positions and 6 bin arrays, pool `57DYH...` 10 and 10.
- Escrow and crank fees: `MAX_ESCROW_FEE_IN_LAMPORT` 10,000,000 and `CRANK_FEE` 100,000 lamports to treasury `BJQbRiRWhJCyTYZcAuAL3ngDCx3AyFQGKDq8zhiZAKUw` (docs `whitelist-and-access` and `launch-design-guide`; SDK `ALPHA_VAULT_TREASURY_ID`).

### E10. Jupiter and the opening seconds

- Jupiter's market-listing page lists "Meteora DLMM" among "DEXes eligible for instant routing" and bases the grace period on token age, after which every market is rechecked every 30 minutes against liquidity criteria ([developers.jup.ag market listing](https://developers.jup.ag/docs/swap/routing/amm/market-listing)).
- Jupiter is deployed on mainnet only (knowledge base `jupiter/02-developer-platform-and-apis.md` section 1.1).
- Pool `57DYH...` activated at unix time 1,779,384,388 (2026-05-21 17:26:28 UTC); Helius enhanced transactions classify the successful transactions around it as 358 non-swaps in the two seconds before open, then at +1 s two direct DLMM swaps and one Jupiter-routed swap, with more Jupiter swaps at +4, +12 and +28 s.

### E11. Devnet

- Devnet DLMM-type vaults: 819, of which 812 on customizable pools; activations run up to 2026-10-24.
- Devnet fill `ZUnJaJ7kNoJrviMBkNFRasPTeEB6JpVwBXwFBFsEk2AK2h24nFqpKfLYpXnfyXotkugaCNL72vR5XcHRBZuWvwM` (2026-10-11, vault `6N5eLf2pQuCeaHHJmUAGSRapZ6BGz1zhCrYSXRKQVedt`, pool `4RwMsu8xgPxsa4M3qi14suXDakEHschkMbaqNLySGd2N`): 0.5 SOL across bins -816 to -813, end fee rate 1.45% (1% + 0.45%), protocol fee 20%.
- `https://devnet.meteora.ag` and `https://dlmm.dev.metdev.io/pools` returned HTTP 200 on 2026-10-26.
- Invent's DLMM guide documents `pnpm studio generate-keypair --network devnet --airdrop` and a devnet `rpcUrl` (docs `invent/launch-pools/dlmm-launch-pool`).

### E12. Meteora's big DLMM launches

- The launch table decodes the vault and pool accounts of the largest mainnet DLMM Alpha Vaults by quote spent: CLOUD vault `6PpD39XuSbLNrVPqCVf7TkXsHqJBwZQpJAfSnKGgGurV` (pool `3v94LDobJYJGu4knmPKpWvB9pmtqwJwN9GtSr4UULtPV`), GOLD `GUrbZv7T...` (pool `9ZKpn4BhHigQYeH7tyWhpqk6AkGUZsYiFu2cFsgwLHYT`), UPT pool `9pdoDV7m4brB6Pboz6oeoNVNkrRGL4t6M4BqhKcVB4Ju`, HUMA pools `Ex3x6Two22ypWzvfXM8hdeJq6CWGG74k7wi4ZSafeyGj` and `SiBZPdZzTp5SKc1DgpBZcfLd7kHPHRRf147GrMetJuZ`, XLAB pool `4ZqdoerRvNJLg2eSiEz5FE2DFZ2e2qvvTAoS1ecwrP6Z`, SONIC pool `ErVxodDE1KD9Stwr63FG6SjJx4sa9BCrBB3ffLNupLUH`, PAR pool `54znaXLPProQ9YXcXqZpJwv8w3qQdULXEH3VZjE7ELAZ`; symbols from Helius DAS.
- On chain the CLOUD vault spent 7.5M USDC for 48.92M CLOUD, an average of 0.1533 USDC, and Meteora's case study says trading began at 0.27744 USDC (1.81x), with 423.66% oversubscription and 5,043 depositors ([Meteora, 2025-04-08](https://meteoraag.medium.com/dlmm-case-study-the-cloud-launch-08eaa5ab3b9c)).
- The case study's curve link uses bin step 80, while the pool account holds bin step 400 and base factor 6,250 (2.5%); it dates the launch to June 2024, while the pool's activation slot 278,270,109 has block time 2024-07-18 14:57 UTC.
- UPT's activation slot 268,867,828 has block time 2024-05-30 16:11 UTC, the date the knowledge base gives for UpRock, the first Alpha Vault launch.
- The docs describe `initialize_permission_lb_pair` as "Operator-controlled pool creation for permissioned launches" (docs `developer-guides/dlmm/program/instructions`).

### E13. Method

- Account data was decoded with the Anchor coders shipped in `@meteora-ag/alpha-vault` 1.1.16 and `@meteora-ag/dlmm` 1.9.14, and byte offsets were computed from the IDLs (`Vault.pool_type` at byte 305, `PositionV2.lock_release_point` at byte 7,992, `LbPair.pair_type` at byte 75).
- Fill events were decoded from the event-CPI inner instructions (`Swap`, `Swap2Evt`, `SwapFill`).
- Simulations used `simulateTransaction` with `sigVerify: false` and `replaceRecentBlockhash: true` against the mainnet program; no transaction was signed or sent and no funded keypair was created.
