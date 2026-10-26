# What an instant DBC launch can do against snipers and bundlers

Research for ticket #4 of the Top-pad wayfinder map, captured 2026-10-26.
It covers a pump.fun-style instant launch on Meteora's Dynamic Bonding Curve (DBC): the sniper tax, the creator's own buy, zero-block buys, graduation to DAMM v2, devnet graduation, and whether a Fair Open can sit on top of DBC.
Every claim is tied to a source in the list at the end.
Program facts come from the DBC program source at commit `91e696e` (2026-10-16, program 0.2.2), which the docs say is live on mainnet and devnet ([D-changelog]); SDK facts come from `@meteora-ag/dynamic-bonding-curve-sdk` 2.0.0 (published 2026-10-15) and its repo at commit `3a965ec`.
On-chain facts were read from mainnet and devnet through Helius RPC on 2026-10-26, read-only, with no transactions sent.
Anything not checked against a primary source is marked **unverified**.

## Answer

### 1. Sniper tax: which scheduler, how fast, slot or timestamp, who gets paid

- The sniper tax is the DBC base-fee scheduler in `PoolConfig.pool_fees.base_fee` (`BaseFeeConfig`): `cliff_fee_numerator`, `first_factor` = number of periods, `second_factor` = period frequency, `third_factor` = reduction factor, `base_fee_mode` 0 linear or 1 exponential ([P-config-fees], [P-sched]).
- In the SDK it is `fee.baseFeeParams = { baseFeeMode: BaseFeeMode.FeeSchedulerLinear | FeeSchedulerExponential, feeSchedulerParam: { startingFeeBps, endingFeeBps, numberOfPeriod, totalDuration } }`, and `getFeeSchedulerParams` sets the period frequency to `floor(totalDuration / numberOfPeriod)` ([SDK-types], [SDK-feeparams]).
- The fee at any swap is `cliff - periods * reduction` (linear) or `cliff * (1 - reduction/10000)^periods` (exponential), with `periods = floor((now - activation_point) / period_frequency)`, capped at `number_of_period` ([P-sched]).
- The cliff can be at most 99% (`MAX_FEE_NUMERATOR = 990_000_000`, base plus dynamic fee) and the ending fee at least 0.25% (`MIN_FEE_NUMERATOR = 2_500_000`) ([P-const]).
- Decay can be as fast as one period of one slot (99% for the creation slot only) or as slow as 65,535 periods (`number_of_period` is a `u16`) of any length ([P-sched]).
- A strong, explainable setting is a 99% cliff decaying to about 1% over roughly 60 seconds; the table in [E1](#e1-fee-scheduler-math) shows how linear keeps the tax above 50% for 30 seconds while exponential falls under 50% after about 10 seconds.
- The rate limiter (fee that grows with buy size) is deprecated since program 0.2.1 and rejected for new configs and pools, so a size-based sniper tax is no longer available ([P-changelog], [D-fees]).
- An optional dynamic fee (`dynamicFeeEnabled`) adds a volatility-based fee on top, still inside the 99% cap ([D-fees], [P-const]).
- Slot versus timestamp (`activation_type` 0 or 1): both charge the full cliff to every buy in the pool's creation slot, because the period counter is 0 for the whole slot and every transaction in a slot sees the same `Clock` ([P-act], [Sol-clock]).
- Slot mode counts exact blocks, so "the first K slots pay 99%" is precise.
- Timestamp mode counts seconds of `Clock.unix_timestamp`, so its periods are stable in wall-clock terms but the cliff can end after a single slot if the pool is created late in a second.
- Slot mode's wall-clock length is no longer what Meteora's guides assume: the guides convert seconds to slots with `duration / 0.4` ([D-invent-dbc]), but mainnet has run 200 ms target slots since SIMD-0525 activated on 2026-10-08, and the measured mean was 212 ms per slot on 2026-10-26 ([SIMD-0525], [E8](#e8-slot-time-changed-under-the-guides)).
- So a "60 second" slot-mode schedule built with the guide's formula now lasts about 32 seconds, which favours timestamp mode for decays measured in seconds.
- Who receives the tax: 20% of every trading fee goes to Meteora (`PROTOCOL_FEE_PERCENT = 20`); if the swap passes a referral account, 20% of that protocol slice goes to the referrer; the other 80% is split `creator_trading_fee_percentage` to the creator and the rest to the partner (`fee_claimer`) ([P-fees], [P-split], [D-fees]).
- The split is one number for the pool's whole life, so the creator's share of the sniper tax equals their share of normal fees; DBC cannot route the sniper-window fees differently by itself.
- The partner share can go to a program-owned account: the `fee_claimer` may be a Dynamic Fee Sharing PDA vault (QuoteToken mode required) or a PDA of our own program, which is where a "sniper tax paid to holders" feature would plug in ([KB-03]).
- Use `collect_fee_mode = 0` (QuoteToken) for a sniper tax: a buy's fee is taken from its SOL or USDC input, so a 99% buy moves the curve by only 1% of its input ([P-feemode], [D-fees]).
- With mode 1 (OutputToken) a buy's whole input moves the curve and the fee is taken from the coins bought, so the price jumps as if the sniper bought everything and 99% of those cheap coins go to the protocol, partner and creator ([P-feemode]).
- Partner and creator fees are claimable at any time, not only after graduation ([D-fees]).
- A sniper can recover at most 4% of what they paid (the referral slice) by passing their own referral account; the first-swap discount explicitly refuses a referral ([P-fees], [P-swap-firstfn]).

### 2. The creator's own buy: cap and gradual release

- `enable_first_swap_with_min_fee` (SDK `fee.enableFirstSwapWithMinFee`) lets exactly one swap skip the sniper tax and pay the scheduler's ending fee ([P-config], [P-swap-first]).
- That swap must be the pool's first swap ever (`has_swap == 0`), must be a top-level DBC instruction (not a CPI from another program), must come after a top-level DBC `initialize_virtual_pool_*` for the same pool in the same transaction, must pass the instructions sysvar, and must have no referral account ([P-swap-firstfn], [P-hasswap]).
- Every later swap in the same transaction or slot pays the cliff, which Meteora's own test shows ([P-test-first]).
- SDK calls: `client.creator.createPoolWithFirstBuy({ createPoolParam, firstBuyParam: { buyer, receiver?, buyAmount, minimumAmountOut, referralTokenAccount: null } })` builds one transaction with the pool and the first buy ([SDK-creator], [SDK-types]).
- `createPoolWithPartnerAndCreatorFirstBuy` appends the partner's buy before the creator's, so only the partner's buy gets the discount and the creator's pays the cliff ([SDK-creator]).
- The cap cannot be set in DBC: no config field limits the size of a swap or of the first swap, and pool creation on a config is permissionless, needing only a `creator` signer ([P-config], [P-init-creator]).
- So with a standard config the cap can only be offered (our server builds and co-signs a capped transaction) and verified after the fact (anyone can read the first swap in the creation transaction); while the discount is on, a creator who calls DBC directly on our config can buy any amount at the ending fee.
- Three ways to make it binding, from least to most work:
  - Turn the discount off (`enable_first_swap_with_min_fee = false`), as all 600 sampled Jupiter Studio configs do: then any creator bundle in the creation slot pays the 99% cliff like everyone else, which makes a large bundled creator buy uneconomic without capping it ([E9](#e9-how-the-big-dbc-platforms-configure-it)).
  - Have Top-pad's launch key sign every pool creation as `creator` (handing the role to the real creator afterwards with `transfer_pool_creator` if wanted); the server then refuses to sign an uncapped first buy, and anyone can verify which pools carry Top-pad's signature, but pools made directly on the config still exist and must be filtered out (**unverified** as a pattern: no big platform was seen doing exactly this; Bags does the reverse, see [E9](#e9-how-the-big-dbc-platforms-configure-it), [P-ix-list]).
  - Use a transfer-hook config whose hook (our program) rejects base-token transfers out of the pool vault above the cap, or to any account other than a lock escrow, while the curve is live ([E6](#e6-the-transfer-hook-path)).
- Gradual release has two native pieces and one that needs a lock:
  - `locked_vesting_config` (SDK `lockedVesting: { totalLockedVestingAmount, numberOfVestingPeriod, cliffUnlockAmount, totalVestingDuration, cliffDurationFromMigrationTime }`) reserves an allocation for the creator that DBC locks in a Meteora Locker escrow at graduation and releases from `finish_curve_timestamp + cliff` ([P-vest], [P-locker], [SDK-types]).
  - That allocation is part of the supply minted into the pool vault at creation, not bought; it is the same size for every pool on the config, the recipient is the pool creator, and the escrow is created with `cancel_mode: 1` and `update_recipient_mode: 2` ([D-launchcfg], [P-vest], [P-locker]).
  - Tokens the creator buys are liquid; DBC does not lock them.
  - The first buy's output can go to any token account (`receiver`, and the swap's `output_token_account` has no owner check), so a creation transaction can send the creator's buy straight into a vesting escrow, but only a program of ours or the hook can make that mandatory ([P-swapctx], [SDK-program]).

### 3. Zero-block buys by anyone other than the creator

- No one can buy before the creator's first swap, because the pool does not exist until the creation transaction runs and the first swap sits inside it ([P-swap-firstfn]).
- A third party can still land in the creation slot, for example through shred streaming or a Jito bundle the creator hands out; DBC does not stop that, it only makes it cost the cliff fee ([P-sched], [P-act]).
- With a 99% cliff, `period_frequency >= 1` and QuoteToken fee collection, a zero-block buy puts only 1% of its input on the curve, so sniping block 0 loses about 99% of the stake (minus at most 4% back through a referral) ([P-fees], [P-feemode]).
- Keep the mint address private until the pool lands: the base mint is a fresh keypair that signs the creation (Meteora's fun-launch scaffold generates it in the browser), and the creation transaction can be sent privately; uselaunch.fun does this with a private bundle ([P-init-creator], [KB-03-fl], [Top-pad-ref]).
- A hard block needs our own code: a transfer hook can reject every buy in the first N slots except the swaps in the creation transaction, because the hook can read the instructions sysvar and the pool account during the swap ([E6](#e6-the-transfer-hook-path)) (**unverified**: designed from the source, not prototyped).
- Detection stays necessary in every design, since a creator can buy at the ending fee and then spread the tokens over many wallets by plain transfers.

### 4. Graduation to DAMM v2: LP lock and token authority

- New configs must migrate to DAMM v2 (`migration_option = 1`); DAMM v1 is rejected for new configs and pools since 0.2.1 ([P-changelog], [D-migr]).
- Migrated liquidity is split into six buckets that must add up to 100: `partner_liquidity_percentage` (unlocked), `partner_permanent_locked_liquidity_percentage`, `partner_liquidity_vesting_info.vesting_percentage`, and the same three for the creator ([P-cfgval], [D-launchcfg]).
- Permanently locked liquidity can never be withdrawn but keeps earning fees; vesting liquidity unlocks per `LiquidityVestingInfoParams { vestingPercentage, bpsPerPeriod, numberOfPeriods, cliffDurationFromMigrationTime, totalDuration }` ([D-migr], [KB-03], [SDK-types]).
- At least 10% of migrated liquidity must still be locked one day after migration (`MIN_LOCKED_LIQUIDITY_BPS = 1000`), checked when a pool is created, and vesting is capped at two years (`MAX_LOCK_DURATION_IN_SECONDS`) ([P-init-lock], [P-const]).
- The positions are DAMM v2 position NFTs handed to the partner and the creator after locks are applied ([D-migr]).
- Base-mint authority is fixed at pool creation and does not change at graduation:
  - Mint authority is revoked at creation for every non-hook pool, and freeze authority is never set ([P-init-mint], [P-t22mint]).
  - `token_update_authority` (SDK `tokenAuthorityOption`) gives metadata update authority to the creator (0), no one (1, immutable), or the partner (2) ([P-tao]).
  - Options 3 and 4 also keep mint authority with the creator or partner, and are allowed only on transfer-hook configs, where that mint authority survives graduation ([P-tao], [P-cfgval]).
- Since 0.2.2 a Token-2022 base mint can carry a transfer fee of up to 10% (`create_config2` with `transfer_fee_parameters`), with `MigratedTransferFeeAuthorityOption` deciding what happens to the fee authority at migration: `Immutable`, `RevokeZeroFee`, `Creator` or `Partner` ([P-mtfao], [D-changelog]).
- That fee path forces a constant supply, no locked vesting, `MigrationFeeOption.Customizable` and compounding DAMM v2 mode, and it cannot be combined with a transfer hook ([D-changelog], [D-sdkhook]).
- After migration the DAMM v2 pool opens immediately (`activation_point: None`) at the curve's migration price, with fees set by `migration_fee_option` or the `migrated_pool_fee` block, including an optional market-cap fee scheduler ([P-migr], [D-launchcfg]).

### 5. Graduating on devnet without the mainnet keeper

- Migration is permissionless: `migration_damm_v2` needs only a payer and the position NFT mint signers, and `create_locker` needs only a payer ([P-migr], [P-locker]).
- Steps: wait for `quote_reserve >= migration_quote_threshold`; if locked vesting is configured call `client.migration.createLocker({ payer, pool })`; then `client.migration.migrateToDammV2({ payer, pool, dammConfig })`, signing with the payer and the two returned position NFT keypairs ([KB-03], [SDK-types]).
- `dammConfig` is the DAMM v2 config key for the config's `migration_fee_option`; all seven keys (options 0 to 6) exist on devnet as well as mainnet, owned by DAMM v2, and DAMM v2, Locker and DBC are deployed on devnet ([E7](#e7-migration-keepers-and-devnet)).
- Meteora's Manual Migrator (https://migrator.meteora.ag/) runs the same two steps from a base mint address and has a Mainnet/Devnet switch in its code ([E7](#e7-migration-keepers-and-devnet)).
- The docs now list one mainnet keeper, `9rpVELNUXLoMjAcc19UCVLJ73xjXNoYKENvRMHcci2V2`, which migrates only pools whose quote mint and threshold match its list (10 SOL, 750 USDC, and others); a Top-pad devnet prototype needs its own keeper job either way ([D-migr]).

### 6. Can a Fair Open sit on a DBC launch?

- Not natively.
- DBC has no pre-activation period: the activation point is set to the current slot or second when the pool is created, and swaps are open from that moment ([P-init-act]).
- The Alpha Vault supports only DLMM, DAMM v1 and DAMM v2 pools ([D-av]).
- The Presale Vault needs the creator to deposit already-existing base tokens, while DBC creates the base mint inside its own pool-creation instruction, so a presale cannot hold a DBC coin before the pool exists ([KB-01-8], [P-init-creator]).
- The transfer-hook path cannot give one price to many buyers on its own: a hook can only allow or reject transfers, and every DBC swap moves the curve, so buyers inside any "window" still get rising prices ([D-hook], [Th-iface]).
- A hook-gated window also clashes with the sniper tax, because the fee clock starts at pool creation: if the pool is created when the window opens, the tax has decayed by the time the public gets in ([P-init-act], [P-sched]).
- What does work is a small program of ours that holds deposits before the pool exists and then makes its buy the pool's first swap, atomically, in the creation transaction (**unverified**: designed from the source, not prototyped):
  - During the window, buyers deposit SOL into our vault program, which can cap each deposit and treat the creator's deposit as their Creator lock.
  - At open, one transaction does: our instruction approves a crank key as SPL delegate for exactly the pot and checks the rest of the transaction by introspection; the DBC `initialize_virtual_pool_with_spl_token`; creation of the vault's base-token account; a top-level DBC `swap2` paid from the vault (the delegate signs as `payer`) into the vault's base account; our instruction that revokes the delegate and records the fill.
  - The vault's swap is the first swap, top-level, after the init, with no referral, so it gets the ending fee instead of the cliff ([P-swap-firstfn], [P-token]).
  - Nobody can trade before it, since the pool is born in the same transaction, and every depositor gets the same average price when they claim pro rata.
  - Public trading starts in the same slot under the full sniper tax, so Fair Open and the sniper tax work together.
  - Use `SwapMode.PartialFill` and cap the pot below the migration threshold, or an oversubscribed window would graduate the coin in its first transaction ([KB-03]).
- This keeps every Meteora program unmodified; the parts our program must own are the deposit window, the pro-rata claim, any per-wallet cap, and the creator's vesting.

### 7. How the main DBC platforms configure anti-sniper settings

- Jupiter Studio: in a random sample of 600 of its 45,243 configs (all that had pools by 2026-09-26), 36% use a linear 99% cliff falling to 1% or 2% in 6 to 30 periods of 3 to 25 slots, in slot mode; the rest charge a flat 1% or 2%; none enables the first-swap discount; the creator gets 50% of the non-protocol fee ([E9](#e9-how-the-big-dbc-platforms-configure-it)).
- Those Studio schedules last 30 to 150 slots, which was 12 to 60 seconds at 400 ms slots (matching Jupiter's "randomised 15 to 60 seconds") and is about 6 to 32 seconds at today's slot time ([KB-jup-01], [E8](#e8-slot-time-changed-under-the-guides)).
- Moonshot (175,044 pools on one config): flat 0.5%, no scheduler, no first-swap discount, creator gets 100% of the non-protocol fee, 100% of graduated LP permanently locked by the creator, immutable metadata.
- Bags: recent launches use a flat 1% fee (scheduler fields zero) collected in the output token, with 30% of graduated LP permanently locked and 70% left unlocked to the partner wallet; one sampled config charged a flat 2% with the first-swap discount on; in most sampled launches the creator's wallet creates the pool and hands the creator role to Bags' wallet with `transfer_pool_creator` in the same transaction.
- Anoncoin: some configs use a linear 99% to 2% schedule over 97 one-second periods in timestamp mode with dynamic fee on; others charge a flat 2%.
- Believe: no DBC pool creation was found in the last 300 transactions of its known signer, so its settings are **unverified**.
- The sniper tax is common but short, and none of the sampled big-platform configs pairs it with a hard block, a creator cap or a Fair Open.

## Evidence

### E1. Fee scheduler math

- `FeeSchedulerMode::Linear` computes `cliff_fee_numerator - passed_period * reduction_factor`; `Exponential` computes `cliff_fee_numerator * (1 - reduction_factor/10_000)^passed_period` ([P-sched]).
- `get_base_fee_numerator` returns the cliff when `period_frequency == 0` (fixed fee), otherwise `period = (current_point - activation_point) / period_frequency`, capped at `number_of_period` ([P-sched]).
- `validate` requires the three scheduler fields to be all zero or all non-zero, the minimum fee to be at least `MIN_FEE_NUMERATOR` and the cliff at most `MAX_FEE_NUMERATOR` ([P-sched]).
- The SDK helper `getFeeSchedulerParams(startingBaseFeeBps, endingBaseFeeBps, baseFeeMode, numberOfPeriod, totalDuration)` rejects an ending fee above the start, requires both counts above zero for a decaying fee, and throws if `totalDuration < numberOfPeriod` ([SDK-feeparams]).
- Example, 99% cliff to 1% over 60 periods of one second (timestamp mode): linear reduction is `16_333_333` per period; exponential reduction is `737` bps per period.

| Seconds after launch | Linear fee | Exponential fee |
| - | - | - |
| 0 | 99.0% | 99.0% |
| 1 | 97.4% | 91.7% |
| 2 | 95.7% | 84.9% |
| 5 | 90.8% | 67.5% |
| 10 | 82.7% | 46.0% |
| 20 | 66.3% | 21.4% |
| 30 | 50.0% | 10.0% |
| 45 | 25.5% | 3.2% |
| 60 | 1.0% | 1.0% |

- The table is computed from the program's formulas; the exponential column uses floating point, while the program uses Q64 fixed point, so the last digit may differ.

### E2. Activation and the first-swap path

- `get_current_point` returns `Clock.slot` in slot mode and `Clock.unix_timestamp` in timestamp mode ([P-act]).
- Pool creation sets `activation_point = get_current_point(config.activation_type)`; there is no parameter for a later start ([P-init-act]).
- `process_swap` sets `eligible_for_first_swap_with_min_fee = config.is_first_swap_with_min_fee_enabled() && pool.is_first_swap() && validate_contain_initialize_pool_ix_and_no_cpi(...)` ([P-swap-first]).
- `validate_contain_initialize_pool_ix_and_no_cpi` rejects a referral account, requires the instructions sysvar, requires the current top-level instruction to be DBC, and scans earlier top-level instructions for a DBC `initialize_virtual_pool_with_spl_token`, `_with_token2022` or `_with_token2022_transfer_hook` whose account 5 is this pool ([P-swap-firstfn]).
- The eligible swap is charged `get_min_base_fee_numerator()`, the scheduler's ending fee without any dynamic fee ([P-vpool-fee]).
- `apply_swap_result` sets `has_swap = 1`, so a second swap is never eligible ([P-hasswap]).
- The single-swap-per-transaction check that blocked packing 16 sniper swaps into one transaction applies only to the deprecated rate limiter ([P-swap-rl]).

### E3. Fee split

- `get_fee_on_amount` takes `protocol_fee = trading_fee * 20 / 100`, then `referral_fee = protocol_fee * 20 / 100` when a referral account is present, leaving the remaining 80% as the partner and creator pool ([P-fees]).
- `split_partner_and_creator_fee` gives the creator `fee * creator_trading_fee_percentage / 100` and the partner the rest ([P-split]).
- Constants: `PROTOCOL_FEE_PERCENT = 20`, `HOST_FEE_PERCENT = 20`, `MIN_FEE_NUMERATOR = 2_500_000` ("previous is 100_000"), `MAX_FEE_NUMERATOR = 990_000_000` ([P-const]).

### E4. Locked vesting and liquidity vesting

- `LockedVestingParams::to_create_vesting_escrow_params` starts vesting at `finish_curve_timestamp`, sets `cliff_time = finish_curve_timestamp + cliff_duration_from_migration_time`, and uses `update_recipient_mode: 2` and `cancel_mode: 1` ([P-vest]).
- `create_locker` requires `MigrationProgress::PostBondingCurve`, creates the escrow through the Locker program with the pool authority as sender, and names `virtual_pool.creator` as recipient ([P-locker]).
- A swap that completes the curve moves the pool to `PostBondingCurve` when locked vesting is configured and to `LockedVesting` otherwise ([P-swap-complete]).
- `ConfigParameters::validate` checks that the six liquidity percentages sum to 100 and validates both `LiquidityVestingInfoParams` against `MAX_LOCK_DURATION_IN_SECONDS` ([P-cfgval]).
- Pool creation rejects a config whose `get_total_liquidity_locked_bps_at_n_seconds(SECONDS_PER_DAY)` is below `MIN_LOCKED_LIQUIDITY_BPS`; this rule arrived in program 0.1.8, so older configs that break it can no longer create pools ([P-init-lock], [P-changelog]).

### E5. Token authority

- `TokenAuthorityOption` has `CreatorUpdateAuthority`, `Immutable`, `PartnerUpdateAuthority`, `CreatorUpdateAndMintAuthority` and `PartnerUpdateAndMintAuthority`, the last two "only allowed for transfer-hook configs" ([P-tao]).
- Config creation requires `is_transfer_hook || !token_authority_option.has_mint_authority()` ([P-cfgval]).
- SPL pool creation revokes `MintTokens` authority after minting the initial supply; Token-2022 creation calls `initialize_mint2` with no freeze authority and sets mint authority to `None` unless a hook config grants it ([P-init-mint], [P-t22mint]).
- For SPL mints the Metaplex metadata is created with `is_mutable = (option != Immutable)` and update authority handed to the creator, the partner, or the system program ([P-meta]).

### E6. The transfer-hook path

- A `ConfigWithTransferHook` is a `PoolConfig` plus `transfer_hook_program`; it needs `token_type = Token2022` and an executable hook program that is not DBC, SPL Token, Token-2022 or the default key ([D-hook], [P-config]).
- Pool creation initializes the mint's transfer-hook extension with the pool authority as hook authority and the configured program as hook ([P-hookinit], [P-t22mint]).
- The DBC program source has no code that creates the hook's extra-account-meta list (the name appears only in its tests); the Meteora test hook `transfer_hook_counter` exposes `initialize_extra_account_meta_list` signed only by a payer, so the hook program decides who may create it ([P-hookinit], [P-idl-hook]).
- The standard interface's `InitializeExtraAccountMetaList` expects the mint authority to sign, which a DBC pool no longer has, so a Top-pad hook needs its own initialization rule ([Th-iface]).
- The hook's `Execute` sees the source, mint, destination, owner or delegate, the amount, and any extra accounts in its list, all passed read-only unless the list marks them writable ([Th-iface]).
- DBC drops its borrow of the pool and config before the token transfers "since transfer hook program may borrow the account", so a hook can read the pool's `activation_point` and the config during a swap ([P-swap-drop]).
- Trading must use `swap2_with_transfer_hook` (SDK `client.pool.swap2WithTransferHook`), and fee claims use `claim_trading_fee2` and `claim_creator_trading_fee2` ([D-hook], [D-sdkhook]).
- When the curve completes, DBC revokes the hook program id and hook authority before migration, so any rule the hook enforces ends at graduation ([P-swap-complete], [D-hook]).
- Mainnet usage: 3,926 `ConfigWithTransferHook` accounts and 7,272 `TransferHookPool` accounts exist; the busiest hook program (`AvVQRmi5LwnTN64pkHbUEeAwwMgR2ms3FcL8VbfZV7FH`) serves 2,728 pools of one partner.
- In 218 recent transactions on 16 sampled hook pools (the two busiest pools of each of the eight busiest hook programs), none went through Jupiter's v6 aggregator program (`JUP6LkbZ...`); 95 were direct top-level DBC calls and the rest came through other routing programs, one of them `DF1ow4tspfHX9JwWJsAb9epbkA8hmpSEAtxXy1V27QBH` (believed to be DFlow's aggregator, **unverified** label).
- Jupiter's Trigger and DCA products reject transfer-hook mints unless whitelisted ([KB-jup-02]); whether Jupiter's swap routing quotes DBC hook pools is **unverified**, and the sample above suggests it does not.

### E7. Migration, keepers and devnet

- `MigrateDammV2Ctx` has `payer: Signer` and position NFT mint signers, and no partner or creator signer, so anyone can migrate a completed pool ([P-migr]).
- The migrated DAMM v2 pool is created with `activation_point: None` ([P-migr]).
- The live docs list one mainnet keeper, `9rpVELNUXLoMjAcc19UCVLJ73xjXNoYKENvRMHcci2V2`, and say keepers run on mainnet only and the manual migrator supports mainnet and devnet ([D-migr]).
- On-chain on 2026-10-26: `9rpVELN...` had transactions that day; the two keepers in the knowledge base (`Asi5DTGE...`, `DeQ8dPv6...`) still show transactions, the latest on 2026-10-21 and 2026-10-26, so whether they still migrate pools is **unverified**.
- The seven DAMM v2 migration config keys (`7F6dnUcR...` for option 0 through `A8gMrEPJ...` for option 6) exist on both mainnet and devnet, owned by `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG`.
- The DBC program (`dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN`), DAMM v2 and the Locker (`LocpQgucEQHbqNABEYvBvwoxCPsSbG91A1QaQhQQqjn`) are executable on devnet.
- DBC's program data was last deployed at mainnet slot 457,502,600 (2026-10-16) and devnet slot 508,712,305 (2026-10-08), consistent with the docs' note that 0.2.2 is live on both ([D-changelog]).
- The Manual Migrator's page describes the DAMM v2 flow as "Create Locker" then "Migrate to DAMM V2", and its JavaScript bundle contains a Mainnet/Devnet selector and devnet RPC endpoints ([Migrator]).

### E8. Slot time changed under the guides

- Meteora's DBC config template says slot-mode durations are `duration / 0.4` ([D-invent-dbc]).
- SIMD-0525 cuts the target slot time from 400 ms to 200 ms in four feature-gated steps ([SIMD-0525]).
- Its four feature accounts are active on mainnet: 350 ms at slot 440,208,000 (2026-08-19), 300 ms at 441,936,000 (2026-08-26), 250 ms at 447,552,000 (2026-09-16), and 200 ms at 454,464,000 (2026-10-08); devnet activated all four between 2026-08-06 and 2026-08-24.
- `getRecentPerformanceSamples` over 600 seconds on 2026-10-26 gave 211.6 ms per slot on mainnet and 238.2 ms on devnet.
- The Solana SDK's `Clock` now defaults to 200 ms slots and warns that slot-based time estimates drift ([Sol-clock]).

### E9. How the big DBC platforms configure it

Method: config accounts were read with `getMultipleAccounts` and decoded with the `PoolConfig` layout from `state/config.rs` ([P-config]).
Platforms were named the way the owner's Stoker scan named them (DefiLlama adapters or self-declared partner metadata), and Bags and Believe pools were found from the transaction signers DefiLlama uses for them ([Stoker-scan], [DL-bags], [DL-believe]).
Pool counts per config are from the Stoker scan of 2026-09-26.

| Platform | Sample | Base fee | Schedule | Mode | First-swap discount | Creator share of non-protocol fee | Graduated LP |
| - | - | - | - | - | - | - | - |
| Jupiter Studio | 600 random configs of 45,243 | 99% falling to 1% or 2% in 36%; flat 1% or 2% in the rest | linear, 6 to 30 periods of 3 to 25 slots | slot | off in all 600 | 50% | 50/50 partner and creator permanent lock in 268; 100% partner unlocked in 331 |
| Moonshot | 6 configs, main one 175,044 pools | flat 0.5% | none | slot | off | 100% | 100% creator permanent lock |
| Bags | 12 launches on 2026-10-26 | flat 1% (one config flat 2%) | none | slot | off (on in the 2% config) | 0% | 30% partner permanent lock, 70% partner unlocked (100% partner lock in the 2% config) |
| Anoncoin | 11 configs | 99% to 2% in some, flat 2% in others | linear, 97 periods of 1 second | timestamp | off | 0% | 37/63 or 50/50 permanent lock |
| Trends | 5 configs | flat 1% to 2% | none | slot | off | 0% to 5% | mostly partner unlocked |
| Believe | none found | **unverified** | | | | | |

- Example Jupiter Studio anti-sniper config: `Hhkjc8Fq4sgV9J7aNprusZpddmGsf1WutLcgJVJpSAPH` (cliff 99%, 10 periods of 7 slots, ending 1%).
- Example Moonshot config: `FbKf76ucsQssF7XZBuzScdJfugtsSKwZFYztKsMEhWZM`.
- Example Bags configs: `HS6gdPBCb1ZNGrGiBbMqeRz4ujHasjNB4EtQA5B4WBjw` and three others with the same settings (flat 1%, output-token fees, 10 SOL threshold, version 1), and `4JZYDZb48o5BhWxekqYDyb91LJkC84pMRf1DueztjbHt` (flat 2%, quote-token fees, 85 SOL threshold, first-swap discount on, 100% partner permanent lock, fee claimer owned by program `FEE2tBhCKAt7shrod19QttSVREUYPiyMzoku1mL1gqVK`).
- Example Anoncoin config: `Cw4zur4EtTu3vWT5vyQmrNKHyXztidGpyiRoYEobqYQ5`.
- In 8 of the 12 sampled Bags launches the creator's wallet signs `initialize_virtual_pool_with_spl_token` and, in the same transaction, `transfer_pool_creator` moves the creator role to `BAGSB9TpGrZxQbEsrEznv5jXXdwyP6AXerN8aVRiAmcv` (a plain system-owned wallet); in 3 the creator also creates a fresh config in the same transaction; in 1 `BAGSB9...` is itself the creator and makes the first swap.
- So Bags' wallet ends up holding each pool's creator role (creator fee share, creator surplus share, creator LP and any locked vesting); why Bags takes the role is **unverified**.
- Jupiter's own description of Studio's anti-sniper fee (99% decaying over a randomised 15 to 60 seconds, "100% goes to the creator") does not match the on-chain split, which gives the creator 50% of the non-protocol fee; how Jupiter routes the rest is **unverified** ([KB-jup-01]).
- The Jupiter Studio and Trends configs that leave all graduated LP unlocked have no permanent lock and no LP vesting, so they break the 10% rule from program 0.1.8 and can no longer create pools; they are older configs ([E4](#e4-locked-vesting-and-liquidity-vesting)).
- The Stoker scan lists every config that had a pool by 2026-09-26, so the Jupiter Studio sample mixes old and new launches.
- Studio's fee-claimer wallet `CWcERiVd...` shows no DBC transaction among its last 100 (the newest dated 2026-10-03), so Studio may now use another fee claimer and its current settings are **unverified**.
- Bags' configs give the creator share 0%, so the partner (`fee_claimer`, for `HS6gdPBC...` the system-owned wallet `8TPACXaKotSZ7WXktfmKDRhgoypyGXNzo1ctr2YBzxLc`) receives all non-protocol trading fees; Bags' own fee-share program was not inspected ([DL-bags]).

### E10. What changed since the knowledge base snapshot (2026-10-04)

- Program 0.2.2 and SDK 2.0.0 are live: `create_config2` (the old `create_config` is deprecated), base-mint transfer fees up to 10% with `TransferFeeWithheldAuthority` and `MigratedTransferFeeAuthorityOption`, `PoolConfig.version` 1, and new `EvtCreateConfig3`, `EvtSwap3` and `EvtSwap3WithTransferHook` events ([D-changelog], [SDK-changelog]).
- SDK 2.0.0 moves curve and fee math to `@meteora-ag/dynamic-bonding-curve-sdk/math`, removes `DynamicBondingCurveClient.create` (use the constructor), and renames `deriveEscrow` to `deriveLockerEscrowAddress` ([SDK-changelog]).
- The migration docs list a single keeper `9rpVELN...` instead of the two in the knowledge base ([D-migr]).
- Mainnet slots are about 200 ms, so every "seconds / 0.4" conversion in Meteora's guides now gives half the intended duration ([E8](#e8-slot-time-changed-under-the-guides)).

## Contradictions found

- Meteora's DBC config template says the ending fee minimum is "0.01% fee === 1 bps", but the program's minimum has been 0.25% since 0.1.7 ([D-invent-dbc], [P-const]).
- The same template converts seconds to slots with `/ 0.4`, which is stale since SIMD-0525 ([D-invent-dbc], [SIMD-0525]).
- Jupiter's Studio docs say the anti-sniper fee goes 100% to the creator; the sampled Studio configs split non-protocol fees 50/50 ([KB-jup-01], [E9](#e9-how-the-big-dbc-platforms-configure-it)).
- The knowledge base lists two mainnet keepers; the live docs list one different keeper ([KB-01-4], [D-migr]).

## Open points (unverified)

- The atomic Fair Open transaction (delegate approval, DBC init, ATA creation, vault swap, settlement) has not been built; its fit within one transaction with address lookup tables is untested.
- A transfer hook that reads the instructions sysvar and the pool account to block block-0 buys has not been built.
- Whether Jupiter's swap API routes DBC transfer-hook pools.
- Believe's current DBC settings, if it still launches on DBC.
- Whether `Clock.unix_timestamp` can ever step backwards between slots; if it did, DBC's `safe_sub` would make the swap fail rather than undercharge ([P-sched]).

## Sources

Program source, MeteoraAg/dynamic-bonding-curve at `91e696eef6a3764157220f6c104f079b7830fc04`:

- [P-sched]: `base_fee/fee_scheduler.rs` lines 16 to 130.
- [P-act]: `utils/activation_handler.rs` lines 24 to 33.
- [P-init-act], [P-init-creator], [P-init-lock], [P-init-mint]: `instructions/initialize_pool/ix_initialize_virtual_pool_with_spl_token.rs` lines 269, 61 to 70, 165 to 168, and 241 to 253.
- [P-swap-first], [P-swap-rl], [P-swap-drop], [P-swap-complete], [P-swap-firstfn]: `instructions/swap/process_swap.rs` lines 214 to 220, 199 to 212, 274, 347 to 372, and 506 to 560.
- [P-swapctx]: `instructions/swap/ix_swap.rs` lines 29 to 50.
- [P-token]: `utils/token.rs` lines 63 to 110.
- [P-hasswap], [P-vpool-fee]: `state/virtual_pool.rs` lines 940 to 998 and 1037 to 1039, and lines 535 to 560.
- [P-fees], [P-split], [P-config-fees], [P-tao], [P-mtfao], [P-config]: `state/config.rs` lines 145 to 178, 1184 to 1205, 235 to 244, 377 to 389, 465 to 497, and 590 to 700.
- [P-feemode]: `state/fee.rs` lines 121 to 144.
- [P-cfgval], [P-vest]: `instructions/partner/create_config/process_create_config.rs` lines 442 to 560 and 343 to 381.
- [P-locker]: `instructions/migration/create_locker.rs` lines 80 to 150.
- [P-hookinit]: `instructions/initialize_pool/ix_initialize_virtual_pool_with_token2022_transfer_hook.rs` lines 24 to 125.
- [P-t22mint]: `utils/token.rs` lines 411 to 498 and `instructions/initialize_pool/process_initialize_virtual_pool_with_token2022.rs` lines 140 to 166.
- [P-meta]: `instructions/initialize_pool/process_create_token_metadata.rs` lines 29 to 65.
- [P-migr]: `instructions/migration/dynamic_amm_v2/migrate_damm_v2_initialize_pool.rs` lines 45 to 130 and 176.
- [P-const]: `constants.rs` lines 60 to 115.
- [P-changelog]: `CHANGELOG.md`, entries 0.1.7, 0.1.8, 0.1.9, 0.2.0, 0.2.1 and 0.2.2.
- [P-test-first]: `tests/first_swap.tests.ts` lines 56 to 120.
- [P-idl-hook]: `idls/transfer_hook_counter.json`.
- [P-ix-list]: the program IDL in the SDK repo, `packages/dynamic-bonding-curve/src/idl/dynamic-bonding-curve/idl.json` (instruction `transfer_pool_creator`).

Base URL for the lines above: https://github.com/MeteoraAg/dynamic-bonding-curve/blob/91e696eef6a3764157220f6c104f079b7830fc04/programs/dynamic-bonding-curve/src/

SDK:

- [SDK-types]: `@meteora-ag/dynamic-bonding-curve-sdk@2.0.0`, `dist/swapQuote-CURAm57K.d.ts` (types `FeeSchedulerParams`, `FeeConfig`, `FirstBuyParams`, `LockedVestingParams`, `LiquidityVestingInfoParams`), https://unpkg.com/@meteora-ag/dynamic-bonding-curve-sdk@2.0.0/dist/swapQuote-CURAm57K.d.ts
- [SDK-changelog]: https://unpkg.com/@meteora-ag/dynamic-bonding-curve-sdk@2.0.0/CHANGELOG.md
- [SDK-creator]: https://github.com/MeteoraAg/dynamic-bonding-curve-sdk/blob/3a965ec0c0a527c2be3c48b8b479366705bf4926/packages/dynamic-bonding-curve/src/services/creator.ts#L231-L291
- [SDK-program]: https://github.com/MeteoraAg/dynamic-bonding-curve-sdk/blob/3a965ec0c0a527c2be3c48b8b479366705bf4926/packages/dynamic-bonding-curve/src/services/program.ts#L520-L560
- [SDK-feeparams]: https://github.com/MeteoraAg/dynamic-bonding-curve-sdk/blob/3a965ec0c0a527c2be3c48b8b479366705bf4926/packages/dynamic-bonding-curve/src/helpers/feeParams.ts#L111-L180

Meteora docs, fetched 2026-10-26:

- [D-changelog]: https://docs.meteora.ag/developer-guides/dbc/changelog
- [D-fees]: https://docs.meteora.ag/core-products/dbc/fees/overview
- [D-launchcfg]: https://docs.meteora.ag/core-products/dbc/launch-configurations
- [D-migr]: https://docs.meteora.ag/core-products/dbc/migration-and-liquidity
- [D-hook]: https://docs.meteora.ag/core-products/dbc/transfer-hook-pools
- [D-sdkhook]: https://docs.meteora.ag/developer-guides/dbc/typescript-sdk/transfer-hooks
- [D-av]: https://docs.meteora.ag/helper-products/alpha-vault/what-is-alpha-vault
- [D-invent-dbc]: https://docs.meteora.ag/invent/launch-pools/dbc-token-launch-pool
- [Migrator]: https://migrator.meteora.ag/

Solana:

- [Sol-clock]: https://github.com/anza-xyz/solana-sdk/blob/master/clock/src/lib.rs
- [SIMD-0525]: https://github.com/solana-foundation/solana-improvement-documents/blob/main/proposals/0525-reduce-slot-times.md
- [Th-iface]: https://github.com/solana-program/transfer-hook/blob/main/interface/src/instruction.rs

Owner's knowledge base (`/Volumes/Farhan/Work Folder/Dev/AI/Research-Projects/jupiter-meteora`, snapshot 2026-10-04):

- [KB-01-4]: `meteora/01-products-and-protocol.md` section 4.10.
- [KB-01-8]: `meteora/01-products-and-protocol.md` section 8.1 (Presale Vault).
- [KB-03]: `meteora/03-dev-dbc-vaults-launch.md`, "Flow: migrate to DAMM v2", "Code patterns" and "Build hooks".
- [KB-03-fl]: `meteora/03-dev-dbc-vaults-launch.md`, "Fun Launch scaffold" (create flow), checked against `scaffolds/fun-launch/src/pages/api/upload.ts` in MeteoraAg/meteora-invent at `dd77ef3`.
- [KB-jup-01]: `jupiter/01-products-user-docs.md`, Studio section (from Jupiter's user docs).
- [KB-jup-02]: `jupiter/02-developer-platform-and-apis.md`, Trigger and DCA table (Token-2022 row) and section 7 (Studio API).

Other:

- [Stoker-scan]: the owner's Stoker repo, `research/competitors/README.md`, `meteora_dbc_platforms.json` and `meteora_dbc_configs.json` (snapshot 2026-09-26, read-only).
- [DL-bags]: https://github.com/DefiLlama/dimension-adapters/blob/master/helpers/queries/bags.sql and `fees/launch-on-bags/index.ts` (signer `BAGSB9...`).
- [DL-believe]: https://github.com/DefiLlama/dimension-adapters/blob/master/fees/believe/index.ts (signer `5qWya6...`).
- [Top-pad-ref]: `research/reference-launchpads.md` on branch `research/reference-launchpads` of this repo (uselaunch.fun section).
- On-chain reads: Helius mainnet and devnet RPC on 2026-10-26 (`getMultipleAccounts`, `getProgramAccounts` with `dataSize` 1128 for transfer-hook configs and the `TransferHookPool` discriminator for hook pools, `getSignaturesForAddress`, `getTransaction`, `getRecentPerformanceSamples`, feature accounts of SIMD-0525).
