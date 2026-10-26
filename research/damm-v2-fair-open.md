# Can Fair Open run on a DAMM v2 launch pool, with its fee scheduler as the sniper tax?

Research for ticket #24 of the Top-pad wayfinder map (issue #1), captured 2026-10-26.
It is the DAMM v2 counterpart of [the DLMM Fair Open research][DLMM-FO] (ticket #3) and follows its layout so the two can be read side by side.
Sources are the DAMM v2 program source (`MeteoraAg/damm-v2` at [`5398b5c`][P-root], release 0.2.5), the source of `@meteora-ag/cp-amm-sdk` (`MeteoraAg/damm-v2-sdk` at [`7ba4162`][S-root], npm 1.5.1, the latest), the source of `@meteora-ag/alpha-vault` (`MeteoraAg/alpha-vault-sdk` at [`1bfa0c8`][A-root], npm 1.1.16, IDL `alpha_vault` 0.4.1), Meteora's live docs (fetched 2026-10-26), the owner's Jupiter + Meteora knowledge base (snapshot 2026-10-04), and on-chain reads of mainnet and devnet through Helius and Alchemy on 2026-10-26.
DAMM v2 is open source, so its rules are quoted from the code and then checked against the live program.
The Alpha Vault is closed source, so its rules were checked by simulating transactions against the live mainnet program with signature verification switched off; nothing was signed or sent.
Claims that could not be checked are marked **Unverified**.

Naming notes: as in the DLMM file, the **seed lock** is the lock on the seeded liquidity position, which is not GLOSSARY's **Creator lock** (the cap on the creator's own buy).
Below, **f** is the share of the pool's coins that the vault's buy takes.

## Answer

Yes, and DAMM v2 fixes the DLMM version's weakest point, the sniper tax.
Every step in the ticket runs today, on mainnet and on devnet, with Meteora's own programs: a customizable DAMM v2 pool seeded single-sided, a Pro Rata Alpha Vault, a permanent seed lock, and a time or market-cap fee scheduler whose cliff can reach 99%.
The scheduler counts from the activation point, the vault's pre-open buy is charged only the scheduler's ending fee, and bots in the activation second and Jupiter-routed buys after it pay the fee in force, all observed on mainnet launches.
Caveat 1: the public still opens above the vault's average price, by exactly `1/(1 - f)` on a full-width range (1.25x when the vault buys 20% of the pool's coins, 2x at 50%), and DAMM v2 has no way to flatten that part of the curve.
Caveat 2: per-wallet caps still need Merkle or authority mode, but a live third-party program already runs an open, capped sale on DAMM v2 with its own program address as the vault authority.
Caveat 3: the Alpha Vault and its timing are the same as on DLMM: the pool must be created 70 minutes to 31 days before the open (85 minutes if deposits start at creation), the buy window is a fixed hour, and nobody is obliged to crank (66 of 528 activated mainnet DAMM v2 vaults with deposits were never filled).
Caveat 4: pool, seed lock and vault do not fit in one transaction (1,712 bytes against the 1,232-byte limit), so a launch takes two transactions or a lookup table.

### DLMM versus DAMM v2 for Fair Open

| Question | DLMM launch pool ([ticket #3][DLMM-FO]) | DAMM v2 customizable pool (this ticket) |
| - | - | - |
| Seeding | coins spread over bins; curve family with a curvature parameter, or explicit per-bin amounts; 70-bin positions | one pool-wide price range with constant liquidity and one position; the shape is fixed by supply, start price and max price (E2) |
| Vault's average price | depends on the bins it crosses | `1/(1 - f)` times the start price on a full-width range (E5) |
| Public opening price over the vault's average | 1.8x (CLOUD), 8.1x (a 2026 launch); one large bin could make it 1x (**Unverified** there) | exactly `1/(1 - f)` on a full-width range; 1.05x to 96x on seven mainnet fills; never 1x without capping the max price (E5) |
| Fee on the vault's own buy | base plus dynamic fee, up to the 10% cap (9.8% on one 2026 fill) | the scheduler's ending fee, no dynamic fee on a first fill; 0.01% to 4.0% on eight mainnet fills, against cliffs of up to 50% (E5) |
| Sniper tax | none: no scheduler, 10% total fee cap, fixed default dynamic fee | time or market-cap scheduler, linear or exponential, cliff up to 99%, end down to 0.01%, optional creator-set dynamic fee, 99% total cap (E6) |
| Buy window before open | 3,600 s or 9,000 slots, fixed | same (E3) |
| Deposits close | 300 s before the buy window | same (E4) |
| Earliest open with a vault | about 70 minutes after pool creation (4,140 s rejected, 4,260 s accepted) | exactly 4,200 s; 5,100 s if deposits start at pool creation (E3, E4) |
| Latest open | about 31 days | exactly 31 days, with or without a vault (E3) |
| Who can move the open | Meteora's admin | nobody: no instruction writes the activation point after creation (E9) |
| Creator pause switch | optional (`creator_pool_on_off_control`) | none (E9) |
| Pool and seed rent | 0.0253 SOL pool plus 0.24 to 5 SOL of positions and bin arrays | 0.0165 SOL in total, whatever the range (E11) |
| Vault fill | up to 210 bins per fill, 845,120 compute units for 140 bins, several fills for wide buys | one exact-in swap for the whole deposit, 47,549 to 98,578 compute units (E5) |
| Crank fee | 0.0001 SOL per fill | 0.0001 SOL, one fill (E5) |
| Meteora's take | 20% of every fee on customizable pools | 20% of every fee, a program constant (E6) |
| Per-wallet caps | Merkle or authority mode | same vault program, same modes (E4) |
| Release | linear, about one year at most | linear; start at least 1 s after open, at most 365 days long (E4) |
| Seed lock | `lock_release_point` per position, `u64::MAX` permanent | `permanent_lock_position`, irreversible, or a vesting lock up to 10 years; nobody can withdraw before the open at all (E7) |
| Activated mainnet vaults never filled | 29 of 192 | 66 of 528 (E10) |
| Devnet | both programs deployed, 812 vaults | both deployed, 821 DAMM v2 vaults; the devnet DAMM v2 build predates 0.2.5 (E1, E10) |
| Jupiter | instant routing; routed swap 1 s after open | instant routing; routed buys at +3 s, +12 s and +51 s paid the scheduler fee in force (E8) |

### The six capabilities

| # | Capability | Verdict | SDK call (instruction) |
| - | - | - | - |
| 1 | Seed the whole supply single-sided along a chosen price range | Yes, one constant-liquidity range | `cpAmm.preparePoolCreationSingleSide`, then `cpAmm.createCustomPool` (`initialize_customizable_pool`) |
| 2 | Open at a set time, no trading before it | Yes, fixed for good | `activationType` and `activationPoint` of `createCustomPool` |
| 3 | Deposit window, one price for all, pro rata, per-wallet caps | Partly | `AlphaVault.createCustomizableProrataVault` with `poolType: PoolType.DAMMV2` (`initialize_prorata_vault`), `deposit`, `fillVault` (`fill_damm_v2`); caps via `createMerkleRootConfig` or `createStakeEscrowByAuthority` |
| 4 | Release the vault's coins gradually | Yes, linear only | `startVestingPoint` and `endVestingPoint`, `claimToken` |
| 5 | Lock the creator's position permanently | Yes | `isLockLiquidity: true` in `createCustomPool` (`permanent_lock_position`) |
| 6 | Sniper tax after the open | Yes | `poolFees.baseFee = getBaseFeeParams({ baseFeeMode, feeTimeSchedulerParam or feeMarketCapSchedulerParam })` with `collectFeeMode: 1` |

**1. Seeding.**
`createCustomPool` creates the customizable pool (one per token pair, a PDA of `cpool` and the two sorted mints), its two token vaults, and a first position held as a Token-2022 NFT ([P-init], E2).
Single-sided seeding starts the pool at its minimum price: `preparePoolCreationSingleSide` refuses any other initial price and turns the coin amount into liquidity for the range from that price to the max ([S-single]).
The price range belongs to the pool and positions carry no range of their own, so the liquidity is the same at every price in the range and adding liquidity later scales the whole range ([P-pool], [P-pos], [KB-01-3]).
The curve is therefore fixed by three numbers, supply, start price and max price, with no curvature parameter and no per-bin amounts.
With the max at `MAX_SQRT_PRICE` it is the curve of a constant-product pool: selling a share f of the coins raises the price by `1/(1 - f)^2` (E5).
The coin must be token A and the quote token B: the Alpha Vault SDK's DAMM v2 fill buys token A, and so do all 1,519 DAMM v2 vaults on mainnet and devnet ([A-fill], E10).
The payer must transfer at least one base unit of each token as proof of ownership; the SDK wraps 1 lamport of SOL when the quote is SOL ([P-init], [S-create]).
The pool's `creator` field is neither checked nor signed; the vault is tied to the payer instead ([P-init]).

**2. Opening time.**
With `has_alpha_vault`, the activation point must lie between 4,200 s (70 minutes) and 31 days after pool creation in timestamp mode ([P-act-params], [P-timing], [P-const]).
The rule is `activation - 3,600 - 300 - 300 >= now` and `3,600 <= activation - now <= 2,678,400`, and the live program rejected 4,150 s and 4,190 s, accepted 4,215 s, 4,260 s and 31 days minus 60 s, and rejected 31 days plus 60 s, each at the source line that the code predicts (E3).
Without a vault, any activation point from now to 31 days ahead is allowed, and leaving it empty opens the pool at once ([P-act-params], [P-init], E3).
Until activation only the pool's whitelisted vault can swap, and only from `activation - 3,600 s` (or 9,000 slots); nobody can remove liquidity before activation, locked or not ([P-access], [P-swap]).
No instruction changes the activation point or the whitelisted vault after creation, not even Meteora's operator, and DAMM v2 has no creator pause switch (E9).
In slot mode the windows are counted in slots that the code comments assume last 400 ms ([P-const]); at the 212 ms measured on 2026-10-26 ([DBC-IL] E8) the 9,000-slot buy window lasts about 32 minutes and the 31-day cap about 16 days.

**3. Fair Open sale.**
The vault side is the same closed program as on DLMM: deposits close 300 s before the buy window, and Pro Rata buys `min(total_deposit, max_buying_cap)` and refunds the rest ([A-point], [DLMM-FO] E4).
The vault demands `last_join_point - depositing_point >= 1,200 s` (1,199 s rejected, 1,200 s accepted), but it accepts a depositing point in the past, so a vault created 4,260 s before the open was accepted with only 360 s of real deposit time (E4).
With deposits starting when the vault is created, the open must be at least 5,100 s after creation (5,080 s rejected, 5,130 s accepted) (E4).
`fill_damm_v2` buys the whole swappable amount in one exact-in swap with minimum out 0; every sampled fill took one transaction, and no activated mainnet DAMM v2 vault is left partly filled ([A-fill], E5, E10).
Each depositor's allocation is `bought_token x escrow.total_deposit / vault.total_deposit`, so all depositors pay one average price ([DLMM-FO] E4).
Permissionless Pro Rata stores `u64::MAX` as the per-wallet cap on all 68 DAMM v2 vaults of that kind, so caps again need Merkle or authority mode (E10, [DLMM-FO] E4).
On DAMM v2 a third-party program, `2nHzAKCrTNyyau8h3bMnszQohmmc4p8Ar893371JD5Hv`, already runs the open, capped sale that the DLMM research left untested: its program address is the pool's payer, the vault's `base` and the vault authority, and each buyer's `Join` creates an authority escrow with a fixed cap just before `Deposit` (E4).
Its two filled vaults hold 46 and 55 escrows, every cap equal to 1/39 of the raise, and no deposit above its cap (E4).
That program's identity and source are unknown, so the pattern is shown to work on chain but is **Unverified** as a design for Top-pad's own program.

**4. Release.**
Claims vest linearly from `start_vesting_point` to `end_vesting_point`, one schedule for every depositor ([DLMM-FO] E6).
Simulated on a DAMM v2 pool: the start must be at least 1 s after activation, the vesting may last at most 365 days (366 rejected), and a start 366 days after activation was rejected as too long a lock (E4).

**5. Seed lock.**
`permanent_lock_position` moves unlocked liquidity into `permanent_locked_liquidity`, which no instruction withdraws; `split_position` can move it to another position, where it stays locked ([P-pos], E7).
Locked liquidity keeps earning fees, which the holder of the position NFT claims, and the SDK puts the lock in the pool-creation transaction with `isLockLiquidity: true` ([P-pos], [S-create]).
A vesting lock (`lock_position`, a cliff then periods, up to 10 years) is the alternative to a permanent lock ([P-lockpos], [P-const]).
227 of the 698 mainnet DAMM v2 vault pools are fully permanently locked (E10).

**6. Sniper tax.**
The base fee can follow a time scheduler (the fee falls each period after activation) or a market-cap scheduler (the fee falls each step of sqrt price above the pool's initial sqrt price and settles at the end fee after an expiry), either linear or exponential ([P-tsched], [P-msched], [D-tsched], [D-msched]).
Bounds: a cliff of at most 99%, an end fee of at least 0.01%, and up to 65,535 periods of any length ([P-tsched], [P-const]).
Constants named for a one-day "fee curve" and a ten-minute "high tax" exist, but no code checks them, so a schedule can last any time ([P-const], [P-timing], E6).
The fee is computed once per swap from the state before it: the scheduler's base fee plus the dynamic fee stored by the previous swap, capped at 99% ([P-pool], [P-fee]).
Use `collectFeeMode: 1` (OnlyB): a buy then pays its fee out of its SOL input, so a 99% buy moves the curve by 1% of its input; with mode 0 the fee is taken from the coins bought and the whole input moves the price ([P-fee], [P-pool]).
Before activation the time scheduler uses its final period, so the vault pays the ending fee, as six scheduler fills on mainnet and two on devnet show (2.0% under a 50% cliff, 1.25% under a 20% cliff) ([P-tsched], E5).
The market-cap scheduler also charges the vault its final fee, but it measures steps from the pool's creation price, so the vault's buy has already used `(1/(1 - f) - 1) x 10,000 / sqrt_price_step_bps` steps on a full-width range when trading opens ([P-msched]).
That interaction is derived from the source and **Unverified** on chain, because the one mainnet market-cap pool with a vault was never filled (E10).
So the time scheduler is the cleaner sniper tax for a Fair Open, while a market-cap scheduler would have to be sized from the post-vault price, which depends on deposits.
Who receives it: 80% goes to the position holder and 20% to Meteora, and a referral account takes 20% of Meteora's slice, so a sniper can claw back at most 4% of the fee it pays ([P-fee], [P-const]).
The dynamic fee is optional and set by the creator (the SDK default caps it at 20% of the base fee), and because the stored accumulator carries over, the first public buy after the vault's buy pays the dynamic fee that buy created: 7.2% (6% base plus the full 1.2% dynamic fee) on one 2026 launch, then 6.0% for the next buys ([S-dyn], [P-pool], E8).

A 99% cliff falling to 1% over 60 one-second periods, computed from the program's formulas (exponential in floating point, so the last digit may differ):

| Seconds after the open | Linear | Exponential |
| - | - | - |
| 0 | 99.0% | 99.0% |
| 1 | 97.4% | 91.7% |
| 5 | 90.8% | 67.5% |
| 10 | 82.7% | 46.0% |
| 20 | 66.3% | 21.4% |
| 30 | 50.0% | 10.0% |
| 45 | 25.5% | 3.2% |
| 60 | 1.0% | 1.0% |

### The opening price after the vault's buy

On a constant-liquidity range, a buy that moves the sqrt price from `s0` to `s1` costs `L x (s1 - s0)` of quote before fees and returns `L x (1/s0 - 1/s1)` coins, so its average price is `s0 x s1` ([P-cl], [KB-01-3]).
The spot price after it is `s1^2`, so the public opens at `s1/s0` times the vault's average, and the vault's average is itself `s1/s0` above the start price.
If the buy takes a share f of the coins in the range, `s1/s0 = 1/(1 - f x (1 - s0/s_max))`, which is `1/(1 - f)` on a full-width range.
The formula matched all seven decoded mainnet fills to four decimals (E5).

| Share of the pool's coins the vault buys (f) | Vault average over start price | Public open over vault average | Public open over start price |
| - | - | - | - |
| 5% | 1.05x | 1.05x | 1.11x |
| 10% | 1.11x | 1.11x | 1.23x |
| 20% | 1.25x | 1.25x | 1.56x |
| 33% | 1.5x | 1.5x | 2.25x |
| 50% | 2x | 2x | 4x |
| 75% | 4x | 4x | 16x |
| 90% | 10x | 10x | 100x |

Real mainnet launches span that whole table (E5):

| Vault | Raise | f | Public open over vault average |
| - | - | - | - |
| `AFRkcaeQ` | 2,001.2 SOL | 4.8% | 1.046x (capped max price) |
| `3Nj9vSKa` | 6.26 SOL | 32.0% | 1.467x (capped max price) |
| `4VtB1CLj` | raised in another quote token (`CARDSccU...`) | 42.7% | 1.746x |
| `9h9KqxDG` | 339 SOL | 87.0% | 7.70x |
| `FyQnEq6H` | 585.9 SOL | 97.5% | 39.8x |
| `5PSGKJn5` | 73,233.5 USDC | 98.0% | 49.1x |
| `BEuXMnwp` | 95.2 SOL | 99.0% | 96.0x |

Consequences for the design:
- The only lever for a small gap is a small f.
- On a full-width range the starting fully diluted value is `L x s0`, and a raise R buys the share `f` given by `R = starting FDV x f/(1 - f)`, so keeping the public within 1.25x of the vault means raising at most a quarter of the coin's starting fully diluted value (derived from the formulas above, **Unverified** as a launch design).
- Put the other way, the raise sets the starting price: a 100 SOL raise with a 1.25x gap needs a starting fully diluted value of 400 SOL, the vault then pays the equivalent of 500 SOL and the public opens at 625 SOL (derived).
- A narrow range shrinks the gap but caps the price, because no coins remain above the max and an exact-in buy that would cross it fails with `PriceRangeViolation`, which would also fail the vault's own fill if deposits outgrow the range ([P-cl]; **Unverified** on chain).
- DLMM can in principle put the vault's whole buy into one bin (**Unverified** there); DAMM v2 cannot.

### Timing constraints

| Constraint | Timestamp pools | Slot pools (at 212 ms per slot) | Source |
| - | - | - | - |
| Vault buy window before the open | 3,600 s | 9,000 slots, about 32 min | [P-const], [P-access] |
| Deposits close | 3,900 s before the open | 9,750 slots, about 34 min | [P-act-handler], [A-point] |
| Shortest deposit window (`last_join - depositing_point`) | 1,200 s | 3,000 slots, about 11 min ([D-av]) | E4 |
| Earliest open after pool creation, with a vault | 4,200 s (70 min) | 10,500 slots, about 37 min | [P-act-params], E3 |
| Earliest open if deposits start at creation | 5,100 s (85 min) | 12,750 slots, about 45 min (derived) | E4 |
| Latest open after pool creation | 31 days (2,678,400 s) | 6,696,000 slots, about 16 days | [P-const], E3 |
| Open without a vault | now to 31 days ahead | now to 6,696,000 slots ahead | [P-act-params] |
| Vesting start | at least 1 s after the open; 366 days after was rejected | **Unverified** | E4 |
| Vesting length | at most 365 days | **Unverified** | E4 |

The slot-mode figures are computed from the source and the measured slot time, not simulated.

### Cost per launch

Rent at the 2026-10-26 mainnet rate, read from simulated account states (E11).

| Item | SOL | Who pays, refundable? |
| - | - | - |
| Pool account (1,112 B) | 0.0063 | payer; not refundable |
| First position (408 B), its NFT mint (Token-2022, 465 B) and NFT account (165 B) | 0.0072 | payer; a position closes only when empty, so never under a permanent lock |
| Two pool token vaults (165 B each) | 0.0030 | payer |
| **Pool total** | **0.0165** | the simulated payer spent 0.0180 SOL, the rest being a 0.0015 SOL wrapped-SOL account and fees |
| Alpha Vault (472 B) | 0.0030 | vault creator |
| Vault's quote and coin token accounts (165 B each) | 0.0015 each | the first depositor (SDK `deposit`) and the first cranker (SDK fill helper) |
| Escrow (136 B), per depositor | 0.0013 | depositor, or the vault authority in authority mode; refundable by `close_escrow` ([DLMM-FO] E9) |
| Crank fee | 0.0001 | cranker, once, to Meteora's treasury |
| Escrow fee | 0 to 0.01 | permissionless vaults only; all 684 timestamp DAMM v2 vaults on mainnet charge 0 |
| Pool-creation fee | none | `initialize_customizable_pool` has no fee account ([P-init]) |
| Meteora's take | 20% of every swap fee | including the vault's fill fee and the sniper tax ([P-const]) |

Seeding costs the same whatever the price range, unlike DLMM, where a wide range cost 0.24 to 5 SOL of position and bin-array rent.

### Limits

- Transaction size: the SDK's pool creation with the lock fits in one transaction, and so does pool creation with the vault, but all three make 1,712 bytes against the 1,232-byte limit, so a launch takes two transactions or a lookup table (E3).
- Two transactions are safe: the pool's whitelisted vault is derived from the payer, and `initialize_prorata_vault` requires that payer (`base`) to sign, so nobody else can attach a vault in between ([P-init], [A-idl]).
- Pool squatting: anyone who holds one base unit of the coin and of the quote can create the one customizable pool for that pair first, or open other pools for the coin, so no coin may leave the creator before the launch pool exists; the vault's coins cannot leave before the open, because claims start after it ([P-init], E4).
- Fill size: one swap with no bin limit, so the whole deposit up to `max_buying_cap` goes in one instruction (E5).
- Who cranks: anyone; in 7 of 8 sampled mainnet fills the pool's creator cranked its own vault, 6 of the 8 within 63 s of the buy window opening, and each paid the 0.0001 SOL crank fee (E5).
- Unfilled vaults: 66 of 528 activated mainnet DAMM v2 vaults with deposits and 175 of 418 on devnet were never filled, so Top-pad must crank its own launches (E10).
- MEV on the fill: minimum out is 0, but nobody else can swap before the open, so the fill cannot be sandwiched ([P-access], [A-fill]).
- Trust: Meteora's operator can still disable a pool, change its dynamic fee at any time, and change its base fee once the scheduler has ended, to at most 10% (E9).

### What protects the first minutes

Observed on mainnet DAMM v2 launches with a vault and a time scheduler (E8):

| Pool | Schedule | What happened |
| - | - | - |
| `3mUYGDy...` (2026-04-14, 339 SOL vault) | 20% linear, 30 periods of 60 s | at least 100 non-swap transactions in the last seconds before the open; a 250 SOL buy and two 15 SOL buys in the activation second; 87 buys from 50 wallets worth 513 SOL in the first 30 s, all at 20%, paying 102.6 SOL of fees; first Jupiter-routed buy at +3 s |
| `BuGuxSH...` (2026-10-12, 6.26 SOL vault) | 50% linear, 20 periods of 9 s | two 0.495 SOL bot buys at +2 s at 50.0%; 45.2% at +26 s; a Jupiter-routed buy at 38.0% at +51 s; 4.4% at +175 s; 2.0% from +183 s |
| `4pBedygx...` (2026-10-13, 73,234 USDC vault) | 6% linear over about 8 days, dynamic fee on | first public buy at +12 s, routed through Jupiter, paid 7.2% (6% plus the carried-over dynamic fee); the next three, also routed, paid 6.0% |

- Snipers do arrive in the activation second and do pay the cliff, and so do routed buys, because the fee lives in the pool program.
- The period length sets how long the cliff holds: with 60 s periods every buy in the first minute paid the full 20%, while with 9 s periods the fee was down to 38% by +51 s.
- Fee-aware cranking is unnecessary on DAMM v2: the vault pays the end fee whatever the price move, unlike DLMM, where the vault's own fill hit the 10% cap.

### Jupiter routing

- Jupiter lists Meteora DAMM V2 among the DEXes eligible for instant routing ([J-listing]).
- Routed buys landed 3 s, 12 s and 51 s after the open on the three pools above, each paying the fee in force (E8).
- A pool with a vault exists at least 70 minutes before its open, so the open question from the DLMM research, how fast Jupiter picks up a pool created minutes before open, does not arise here.
- Jupiter runs on mainnet only, so routing cannot be tested on devnet ([DLMM-FO] E10).

### Devnet status today

| Piece | Works on devnet? |
| - | - |
| DAMM v2 program `cpamdp...` | Yes, same program ID, last deployed 2026-09-23 (mainnet 2026-10-15) |
| Byte-identical to mainnet | No: the devnet build predates the 0.2.5 release and hashes differently; 0.2.5 only changes overflow handling and compounding fees, nothing used here (E1) |
| Alpha Vault program `vaU6k...` | Yes, deployed 2025-06-16 (mainnet 2025-06-26), different hash ([DLMM-FO] E1) |
| DAMM v2 vaults | 821, activations up to 2026-10-25; time schedulers on 249 of their pools, market-cap on 40 (E10) |
| A full fill under a scheduler | Yes: a 2026-10-25 devnet fill paid 1.0008% under a 20% cliff with a 20% protocol share (E5) |
| SDKs and Invent studio | Yes: the cp-amm SDK has no cluster switch (same program ID), the Alpha Vault SDK takes `cluster: "devnet"`, and Invent's `damm-v2-create-one-sided-pool` supports an Alpha Vault and a devnet RPC with airdrop ([KB-02], [DLMM-FO] E11, [D-invent]) |
| Cranking | Our own: 175 of 418 activated devnet vaults with deposits were never filled (E10) |
| Jupiter | No (mainnet only) |
| Rent | Same as mainnet ([DLMM-FO] E9) |

### How DAMM v2 vault launches are configured on mainnet

All 698 DAMM v2-type Alpha Vaults and their pools, decoded on 2026-10-26 (E10):
- All are on customizable pools; 684 use timestamps and 14 slots; activations run from 2025-06-01 to 2026-10-23.
- Modes: 461 Pro Rata and 237 FCFS; access: 469 authority, 94 Merkle and 135 permissionless.
- Base fee: 547 flat, 93 time-linear, 56 time-exponential, 1 market-cap, 1 old rate limiter.
- Scheduler cliffs: 50% on 76 pools, 8% on 20, 20% on 19 and 99% on 3 (the three 99% pools fall to 1% over 900 one-second periods).
- 626 collect fees in the quote only (mode 1), 233 have a dynamic fee, 227 are fully permanently locked, and 174 are old fee-version-0 pools capped at 50%.
- Quote tokens: 382 USDC, 290 SOL, 10 USD1.
- The largest raise is 176,748 USDC (2025-10-07, authority Pro Rata, time-linear 8% falling to 4% over two days); the largest in SOL is 2,001 SOL (2026-08-03, flat 2%).

### Unverified and open

- The market-cap scheduler's interaction with the vault's buy, and a fill failing against a capped max price, come from the source only.
- Slot-mode limits are computed from the source and the measured slot time, not simulated.
- Devnet parity with mainnet 0.2.5 is behavioural (fills match), not proven byte for byte.
- The two-transaction launch and a single transaction with a lookup table are untested.
- The identity, source and audit status of program `2nHzAKCr...`, and whether Top-pad's own program could act the same way.
- Whether Meteora's keeper cranks DAMM v2 vaults made outside its app; 7 of the 8 sampled fills were cranked by the pools' creators themselves.
- The sizing rule for the raise (at most `f/(1 - f)` of the starting fully diluted value) is exact algebra that fits seven fills, but has not been tested as a launch design.

## Evidence

### E1. Versions and deployments

- The program source is release 0.2.5 (commit `5398b5c`, 2026-10-15 03:18 UTC); its changelog adds zero compounding fees and wrapping overflow counters ([P-changelog]).
- The live changelog lists cp-amm 0.2.5 without a date; 0.2.4 was planned for 2026-09-08 ([D-changelog]).
- The mainnet program data `AUh8bm2XsMfex3KjYGcM3G4uBqUNSDw6HEhWaWMYnyPH` was last deployed at slot 457,080,014 (2026-10-15 03:00 UTC), ELF 1,430,777 bytes, SHA-256 `0712ca6d...`, upgrade authority `JADaUV8kvDpDbJr55wxXJHVaBS3VCj8thZZHjfeuCVLd`.
- On devnet the same program data was last deployed at slot 503,166,267 (2026-09-23 22:37 UTC), ELF 1,430,785 bytes, SHA-256 `f838b2ae...`, upgrade authority `DHLXnJdACTY83yKwnUkeoDjqi4QBbsYGa1v8tJL76ViX`.
- The Alpha Vault program was last deployed on 2025-06-26 (mainnet) and 2025-06-16 (devnet), unchanged since the DLMM research ([DLMM-FO] E1).
- `@meteora-ag/cp-amm-sdk` 1.5.1 (2026-09-30) and `@meteora-ag/alpha-vault` 1.1.16 are the latest on npm.

### E2. Pool creation, seeding and the curve

- `InitializeCustomizablePoolParameters` holds `pool_fees`, `sqrt_min_price`, `sqrt_max_price`, `has_alpha_vault`, `liquidity`, `sqrt_price`, `activation_type`, `collect_fee_mode` and `activation_point: Option<u64>` ([P-init] L31-L51).
- The pool PDA is `["cpool", max(mint A, mint B), min(mint A, mint B)]`, so there is one customizable pool per pair ([P-init] L161-L172).
- `creator` is an `UncheckedAccount`; `payer` is the signer ([P-init] L120-L152).
- A missing activation point becomes the current point; the whitelisted vault is `alpha_vault::derive_vault_pubkey(payer, pool)` ([P-init] L304-L310, L429-L435).
- "require at least 1 lamport to prove ownership of token mints": both transfers are at least 1 unit ([P-init] L381-L400).
- `preparePoolCreationSingleSide` throws "Only support single side for base token." unless the initial price equals the min price ([S-single]).
- `createCustomPool` passes `max(tokenBAmount, 1)` when token B is wrapped SOL and appends `permanentLockPosition` when `isLockLiquidity` is set ([S-create] L2051-L2078).
- The pool account stores one `sqrt_min_price` and `sqrt_max_price`, and the `Position` account has no price fields ([P-pool] L137-L142, [P-pos]); the docs say the range is pool-level ([KB-01-3]).
- An exact-in buy whose next sqrt price would pass `sqrt_max_price` returns `PriceRangeViolation` ([P-cl] L90-L97).

### E3. Activation and pre-activation

- `TIME_BUFFER = 3600`, `SLOT_BUFFER = 9000` ("1 slot = 400 mls => 1 hour"), `MAX_ACTIVATION_TIME_DURATION = TIME_BUFFER x 24 x 31`, `FIVE_MINUTES_TIME_BUFFER = TIME_BUFFER / 12` ([P-const] L67-L93).
- `get_last_join_point` is `activation_point - buffer - buffer/12` ([P-act-handler] L83-L93).
- With a vault: `activation_point > current_point`, `min_activation_duration <= activation - current <= max_activation_duration`, and `last_join_point - last_join_buffer >= current_point`; without one: `current <= activation <= current + max` ([P-act-params] L33-L77, [P-timing] L247-L271).
- Swaps are allowed for the whitelisted vault from `activation_point - buffer` and for everyone else from `activation_point`; removing liquidity needs `current_point >= activation_point` ([P-access] L46-L60).
- The swap checks `can_swap(payer)`, so the vault's PDA must be the swap signer ([P-swap] L80-L86).
- Simulations of `initialize_customizable_pool` (single-sided, 99% time scheduler, `has_alpha_vault`) plus `permanent_lock_position` for the unused pair `xddwJXwtmWTh3WpWvYX15KyrLm957yeDXdsiGn9QerA`/wrapped SOL, payer `7Da5dpUbNG8nbvCCJMennTssbhkpZNi8NfE6uawcpwPh`, 2026-10-26, delays measured from the cluster clock:
  - 4,150 s and 4,190 s: `InvalidActivationPoint` (6011) at `params/activation.rs:60`;
  - 4,215 s, 4,260 s and 2,678,340 s: success, 118,946 to 124,946 compute units;
  - 2,678,460 s: `InvalidActivationPoint` at `params/activation.rs:44`;
  - without a vault, 120 s in the past and 2,678,460 s ahead: `InvalidActivationPoint` at `params/activation.rs:72`.
- The line numbers in the live program's errors match the 0.2.5 source.
- Pool creation, lock and vault creation together: "VersionedTransaction too large: 1712 bytes (max: encoded/raw 1644/1232)"; pool plus vault without the lock simulated successfully.

### E4. The Alpha Vault on DAMM v2: windows, vesting and caps

- The SDK uses a pre-activation duration of 3,600 s or 9,000 slots for DAMM v2 pools and computes `lastJoinPoint = activationPoint - preActivationDuration - 300 s (750 slots)` ([A-create] L262-L279, [A-point]).
- `initialize_prorata_vault` requires `funder` and `base` to sign; the vault is the PDA of `base` and the pool ([A-idl], [A-create] L381-L385).
- Simulations of pool creation plus `initialize_prorata_vault` (permissionless, `max_buying_cap` 100 SOL unless stated), 2026-10-26:
  - depositing point now, open at 4,260 s and 5,080 s: `DepositingTimePointIsInvalid` (6021) at `alpha-vault/src/activation.rs:156`; at 5,130 s, 5,400 s, 5,460 s, 5,520 s and 7,200 s: success;
  - depositing point 0, open at 4,260 s and 7,200 s: success;
  - open at 7,200 s, depositing point `last_join - 1,199`: error 6021; `last_join - 1,200`: success;
  - vesting start at the open or 1 s before it: `TimePointOrdersAreIncorrect` (6007) at line 150; 1 s after: success;
  - vesting length 365 days: success; 366 days: `VestingDurationIsInValid` (6016) at line 138;
  - vesting start 366 days after the open: `LockDurationInvalid` (6033) at line 129;
  - `max_buying_cap` of 1 lamport: success.
- The docs give the 3,000-slot or 1,200-second minimum for FCFS only ([D-av]); the simulation shows it for Pro Rata too.
- On mainnet, 10 DAMM v2 vaults have a deposit window of exactly 1,200 s and none shorter; on devnet, 12 (E10).
- Program `2nHzAKCrTNyyau8h3bMnszQohmmc4p8Ar893371JD5Hv`:
  - its PDAs `J7Hj3ebEhH3pZWbicURTNSkUcdger6JejEwUJKuz9VrG` and `2j7Dx9iweSTWfhunocc1MtexMRN3peHVZiWg58PhkXg8` are both `base` and `vault_authority` of Pro Rata vaults `fkJ21UcrGGsF62P4CgNDipUDQaVJK5Ay8gayVnWMydS` (pool `BuGdkbRGB539RWTLJNA9BSH16XxRdoWeKCXhZRPGniXU`), `9CteRs8wABdzLzm5QMcsRoTwwuxXfmyQXgcBVYqFV9Lq` and `E5rmTS7xMdn2imSc5ZZiCZqnpmq9CojjkkAi2mVkHhzb` (pool `6GiMQxa5vAJPKwmUWAxAz62w6eDhbMpyCpomL85WSQVw`);
  - the vault's first transaction (2026-10-06 20:08 UTC) runs the program's `CreateLaunch`, which mints the coin; the transactions after it each run the program's `Join`, then `CreatePermissionedEscrowWithAuthority`, then `Deposit`, and the latest ones are buyers' `WithdrawRemainingQuote` and `ClaimToken`;
  - `fkJ21U...`: 46 escrows, every `max_cap` 1,282,051,282 lamports (50 SOL / 39), 19 at their cap, none above; `E5rmTS...`: 55 escrows, every cap 1,025,641,025 (40 SOL / 39), none above.
- Only 3 of the 698 mainnet DAMM v2 vaults have an off-curve authority; 389 of the 395 distinct authorities are the `base` address of every vault they control.

### E5. Fills: the fee paid, compute and the price ratio

Fill transactions, decoded from the `EvtSwap2` events in their inner instructions:

| Vault | Pool | Fill | Seconds before open | Schedule (cliff to end) | Fee paid on input | Compute units |
| - | - | - | - | - | - | - |
| `AFRkcaeQwZxRtXtrKSKX4QZzRjjZ41YsPtMUbV34KXAe` | `4w8WTfdtzfwj878cEd3JBZne7FRqMSpjTzxai13bxqY8` | `ADXzV7pnwtZ5sdX2KzERA3RyPSrVtgVhSs2h4mxTRCHsmZsptyTK2hEQgsUDhYceN1zhNdDy5KwZbHksMTCjby9` | 3,598 | flat 2% | 2.0000% | 55,169 |
| `FyQnEq6HEkiJGUym5CZ6P6b4vm7VH2vueB9TgxDsemKJ` | `D4bJASQWHvr9CdxZnjyZs9RF52F1nc1hQgMKUqn7UqmE` | `676ZT1JiRUJTczn3MDRV81w5MVUENchXHmqXbUMxNeGVfJvAEYJo8D7CGSFKtjJgt9iqoERYPNmEYprWvhCywEJD` | 3,588 | flat 0.01% | 0.0100% | 73,891 |
| `4VtB1CLjqTNYegapLDWDkyNyc2r2Y3foXau1wCvPYaH1` | `FYwVTPYYzdr63ER4hNwcygEie7DVfJGwr1FZXPn7K8Pd` | `5ZdcdFx8gGM6EXgNyeyBq8FB9jTNDKEBM6KQANBLfqG8r8Q24p51tX3NSB4Loz5GxnDqgEa8NA6EA2XUk4K82AMd` | 3,549 | linear 50% to 2% | 2.0000% | 47,549 |
| `3Nj9vSKa7E3qS5TvifjxPtKTR6yu4JcLGBSFWDtPVRwE` | `BuGuxSHqAu4tNJQkKbC9tvGg4FKVg6HZby2MfgV1LjSm` | `2Nj9g28mEaMZtcLXQ8eAz9nDkRjcujd3tK144V33pCqabYYFo8hx7h5nk4N5423bFtJimk9E1uMB5iHNk7Qqq5Ro` | 3,537 | linear 50% to 2% | 2.0000% | 63,991 |
| `5PSGKJn5dJFciXQFJa5icaUJNFjvTE8tNtfmqs6ty1cC` | `4pBedygxZVUVR94sgTJC6C5CX7nMGBdnv1x8ac9oPJ7o` | `5TmBhpzDjq4VHyDxWXdHRntdxXwHD9dm5Ywu6sUPDvHLYxq7Y6MbMP26Ep9AJcP9ho8M76J6C1AbdwWtxvsFqw9z` | 3,538 | linear 6% to 4.002%, dynamic fee on | 4.0018% | 61,332 |
| `9h9KqxDGrZt3RDjGcsP5GiYdSSdQM9n9znQQCPrxQoTZ` | `3mUYGDyckEqv9kfwQzmctnDwHtJnyGNQFKUFm4zJa6TV` | `dASMLsWbBXTwvmF5uuqTm3SBcFaxxc9ub1ejDo1uBftMqtPxREekhN45LcQdjFLrSwumU6LSJR5fRL8iQoheNyM` | 2,765 | linear 20% to 1.25% | 1.2500% | 76,838 |
| `BEuXMnwpoWUY3Dd296woSKbRrrdzjaaGPwtPP9HijaYT` | `DbTpxfUsuAZPaoCQ5Q2ekUyEbyr3YmvYHmh7pUR3rUn8` | `ZwuRtwNqVfgwwct3ua1abJPa7hU4KyJnGYiVKfCQyQg1H5GKm2H4gwX7cpPWeeVCKLzBEws1nLMu3mTxGNb9xGj` | 1,737 | exponential 50% to 0.251%, dynamic fee on | 0.2506% | 75,859 |
| `4evCLq8YwXh6zcNCnGuyz9nAfFQXfovUiWQyHRWuLQQw` | `F2KX5y1odNHZJzJUukCzapcNpQ6gej5pv9hLoTgnXWz3` | `48wwqar26En9N9xV1VKoEyQSjDBPrK6NY16YcE6RFo98h33cP27nuyRt29RtM2E3ocFuVXPJFnENGcBdRnApSiGX` | 3,599 | linear 10% to 4.001%, dynamic fee on | 4.0014% | 98,578 |

- Every fill above had swap mode 0 (exact in), `amount_1` (minimum out) 0, `amount_left` 0, and a protocol fee of exactly 20% of the fee.
- Devnet fills: vault `3A4JKZMHaFyDvVJhMwTjw7dNqGujdtTbgUcJ3sYRM4ia` (pool `7pjb1qBRphaRDihqNRpDzzZoCfVCQ1kGAXv3gpsvGPAb`, exponential 20% cliff) paid 1.0008% in `2oheiVkLXwCwW7SBw8zuoFUknzeJjg2RYixSeADs6XjbooppdcLCt35aqwLvbLHeRpTNC2SsA8EHuvZti7PXco7N` on 2026-10-25; vault `DAuQKdA2UQ5973bdXZhr59SFtuamPWJPgWPaLiPTEuTJ` (10% cliff) paid 0.7509% in `5oDGPtotuBk7tbD7sovPy1BweeCNFFuWCbDwjyc5HJMSr3dZDzfrXfevfVKJjvmbmd6R2PywzSNt95bLGDTkpB4r`; both with a 20% protocol share.
- `fillDammV2Transaction` sends one `fill_damm_v2(vault.totalDeposit)` with no compute-budget instruction, after creating the vault's coin account for token A if missing ([A-fill]).
- Ratio check: the measured `s1/s0` (next sqrt price over the pool's initial sqrt price) equalled the post-fill spot price over the vault's fee-excluded average price, and equalled `1/(1 - f x (1 - s0/s_max))` computed from the coins bought and the coins left, to four decimals, on all seven fills with an initial price recorded (the pool of `4evCLq8Y...` stores an `init_sqrt_price` of 0).
- In 7 of the 8 mainnet fills the fee payer was the pool's creator wallet (for example `TRUMPJ4GUFfr52fxcG4EZJmEhRSdmHa19mkQ22mJAfV` for `FyQnEq6H...`), and every fill sent 100,000 lamports to the treasury `BJQbRiRWhJCyTYZcAuAL3ngDCx3AyFQGKDq8zhiZAKUw`.

### E6. The fee scheduler and fee split

- Time scheduler: `period = (current_point - activation_point) / period_frequency`, capped at `number_of_period`; "it means alpha-vault is buying" when `current_point < activation_point`, which returns the final period ([P-tsched] L121-L135).
- Validation: all three schedule fields zero or all non-zero, end fee at least `MIN_FEE_NUMERATOR` (100,000, 0.01%), cliff at most `MAX_FEE_NUMERATOR_V1` (990,000,000, 99%); `number_of_period` is a `u16` ([P-tsched] L19-L29, L139-L162, [P-const] L116-L129).
- Market-cap scheduler: the final period applies when "Expired or alpha vault is buying"; otherwise `passed_period = (current_sqrt_price - init_sqrt_price) x 10,000 / init_sqrt_price / sqrt_price_step_bps`, and period 0 applies at or below the initial price ([P-msched] L122-L162); `init_sqrt_price` is the pool's creation price ([P-init] L315, [P-fee] L91).
- `computeSqrtPriceStepBps(priceMultiple, numberOfPeriod)` sets the step so the schedule ends at that multiple of the initial price ([S-msched]).
- `max_fee_curve_duration` and `max_high_tax_duration` are filled into `TimingConstraint` but read nowhere else in the program ([P-timing] L231-L271; searched the whole `src` tree).
- The trade fee is computed once from `self.sqrt_price` before the swap; the dynamic fee reads the stored `volatility_accumulator`, which only `update_post_swap` rewrites; the total is capped at `get_max_fee_numerator(fee_version)` ([P-pool] L722-L737, L1033-L1059, [P-fee] L122-L138, L376-L393).
- Fee modes: OnlyB takes a buy's fee from its input in token B, BothToken from its output in token A ([P-fee] L404-L428).
- Split: protocol 20% of the fee, referral 20% of the protocol part when a referral account is passed ([P-fee] L240-L283, [P-const] L146-L148).
- The SDK's default dynamic fee caps the dynamic part at 20% of the base fee, with filter 10, decay 120 and reduction 5,000 ([S-dyn]).
- The SDK helper derives the period length as `totalDuration / numberOfPeriod` and refuses an end fee above the start ([S-tsched]).
- The live time-scheduler page: "If the current slot or timestamp is before the pool activation point, the time scheduler uses the final period", "used for pre-activation alpha-vault buying" ([D-tsched]); the market-cap page: "if a pre-activation alpha-vault buy is being processed, the program uses the final period" ([D-msched]).

### E7. The seed lock

- `permanent_lock_liquidity` moves liquidity from unlocked to permanently locked; total position liquidity, which earns fees, includes locked and vesting liquidity ([P-pos] L157-L188).
- The only code that reduces `permanent_locked_liquidity` is `apply_split_position`, which adds the same amount to the second position ([P-pool] L960-L980).
- `lock_position` takes a cliff point, period frequency, cliff unlock, liquidity per period and number of periods, capped at `MAX_VESTING_TIME_DURATION` (10 years) ([P-lockpos] L13-L70, [P-const] L88-L89).
- The simulated launch with `isLockLiquidity: true` ran `PermanentLockPosition` successfully in the pool-creation transaction (E3).

### E8. The opening seconds

Swaps decoded from `EvtSwap2` events, using Helius `getTransactionsForAddress` in ascending order from the activation second:

- Pool `3mUYGDyckEqv9kfwQzmctnDwHtJnyGNQFKUFm4zJa6TV` (activation 1,776,171,600, 2026-04-14 13:00 UTC):
  - the first 100 successful transactions touching the pool from 5 s before the open contained no swap, and the 30 inspected were all sent through program `CTTjzq...` in the second before the open;
  - at +0 s: 250 SOL by `6YRJLzw5J99qm9FTr1ezMqwp8o2oeqeSn3o8m6Bs753j` in `2CF3yG36bdQJWMStFBHWacBXdVHctiFE2ZqthwGQcRvwhBGQhHzdGWqoFsN4mTaMfBnGgo5gLPopEToSwdhJSCj8`, fee 20%;
  - at +3 s: a Jupiter-routed 11.6 SOL buy in `3FGrNKE6aDQ5sGtxUGQHLEh6gfa4xqwx4pFuQ7arkJ6KJfZqbWj8xo3W6L4L2G6FcNRXKkGFCJStEhiaCPd3EYEH`, fee 20%;
  - by +30 s: 87 buys by 50 signers, 513.07 SOL in, 102.61 SOL of fees, many sent through third-party programs such as `FLASHX...` and `Maestr...`.
- Pool `BuGuxSHqAu4tNJQkKbC9tvGg4FKVg6HZby2MfgV1LjSm` (activation 1,791,783,121, 2026-10-12 05:32 UTC):
  - at +2 s: two 0.495 SOL buys by `FYTiZbk17NNPQ5j1aRH67mhJZH3ggYcmwbQqqEN9GAk5` at 50.0% (`5yiNkjAq...`, `4FCmfPNq...`);
  - at +51 s: a Jupiter-routed buy at 38.0% in `5aHTaYpN2j8fbUYGNLDADHixDCwvAxTX3YGfguexfE2kpy7GxZgLLPi9rMDFY3hdHunEG8U2txYQCNdKwsLGxZxe`;
  - the rates 50.0%, 45.2%, 38.0%, 4.4% and 2.0% at +2, +26, +51, +175 and +183 s are exactly `50% - floor(t / 9) x 2.4%`.
- Pool `4pBedygxZVUVR94sgTJC6C5CX7nMGBdnv1x8ac9oPJ7o` (activation 1,791,933,401, dynamic fee with max volatility accumulator 14,460,000 and variable fee control 5,739, a 1.2% ceiling):
  - at +12 s: a Jupiter-routed buy at 7.2000% in `4n7DbFJCq4wE5snQwUfFHHMb42ik8HiFdeCxcn8DCBogpLoeLwCCqPrTN1PH8xQt6NeFnDT9LedUCcYRCJWeUAQi`;
  - at +56, +68 and +78 s: Jupiter-routed buys at 6.0%.

### E9. Operator powers

- The only write of `activation_point` is in `Pool::initialize` ([P-pool] L411-L454); no instruction in the program takes a new activation point ([P-lib]).
- `set_pool_status` lets an operator enable or disable a pool; a disabled pool refuses swaps and new liquidity ([P-status], [P-access]).
- `update_pool_fees` changes the cliff only once `validate_base_fee_is_static` holds (the schedule has ended) and to at most `MAX_FEE_NUMERATOR_POST_UPDATE` (10%), and can enable, change or disable the dynamic fee at any time ([P-pool] L1180-L1269, [P-const] L121).

### E10. Mainnet and devnet survey

- Method: `getProgramAccounts` on the Alpha Vault program filtered by the `Vault` discriminator and `pool_type = 2` at byte 305, decoded with the coder of `@meteora-ag/alpha-vault` 1.1.16; pools decoded with the coder of `@meteora-ag/cp-amm-sdk` 1.5.1; 2026-10-26.
- Mainnet: 698 vaults on 698 customizable pools, every pool's `whitelisted_vault` equal to its vault, 655 with `vault.base == pool.creator`.
- Mainnet activated timestamp vaults with deposits: 462 fully filled, 0 partly, 66 not filled.
- Devnet: 821 vaults, 245 with a swap; activated timestamp vaults with deposits: 243 fully filled, 175 not filled.
- All 1,519 vaults have `base_mint == pool.token_a_mint`.
- All 68 mainnet permissionless Pro Rata DAMM v2 vaults store `individual_depositing_cap = u64::MAX`; all 684 mainnet timestamp vaults charge no escrow fee.
- The configuration counts in the Answer are from this survey.

### E11. Costs

- Simulated launch accounts (pool `7xA1tBEnctX6A6TAZEDVNnADNELZ2PL26dZeQsuqzBfE`, never created): pool 1,112 B 6,299,200 lamports; position 408 B 2,722,880; position NFT mint (Token-2022) 465 B 3,012,440; NFT account 165 B 1,488,440; token vaults 1,488,440 each (token B holds 1 extra lamport); Alpha Vault 472 B 3,048,000; the payer's new wrapped-SOL account 1,488,440.
- The payer spent 0.017998 SOL for pool and lock, and 0.021046 SOL for pool and vault, including 10,000 lamports of signature fees.
- The SDK's `deposit` creates the vault's quote token account for the depositor to pay, and the fill helper creates its coin account for the cranker to pay ([A-deposit], [A-fill]).

### E12. Method

- Simulations used `simulateTransaction` with `sigVerify: false` and `replaceRecentBlockhash: true` against the mainnet programs, with delays measured from the cluster's `Clock` sysvar; no transaction was signed or sent and no funded keypair was created.
- Scripts and data are in the session scratchpad under `damm-fo/` (`dammv2_vaults.cjs`, `analyze_dammv2.py`, `fills.cjs`, `opening.cjs`, `sim_launch.cjs`, `authorities.cjs`, `deploy.cjs`, `crankers.cjs`).

## Contradictions found

- Invent's `damm_v2_config.jsonc` template defaults to `baseFeeMode: 2` (rate limiter), which the program rejects for new pools since 0.2.3 ([D-invent], [P-fee-params] L33-L45).
- The same template converts seconds to slots with `/ 0.4`, stale since 200 ms slots ([D-invent], [DBC-IL] E8), and the program's own comments still assume 400 ms ([P-const] L69).
- The same template's optional dynamic fee lists `variableFeeControl: 14460000` and `maxVolatilityAccumulator: 239`; the SDK default and the on-chain pool `4pBedygx...` have them the other way round (max volatility accumulator 14,460,000, with 239 being the variable fee control for a 0.25% base fee) ([D-invent], [S-dyn], E8).
- The docs and the knowledge base give the 1,200-second minimum deposit window for FCFS vaults; the program applies it to Pro Rata vaults as well, measured from the depositing point rather than from the vault's creation ([D-av], [KB-01-6], E4).
- The live DAMM v2 changelog lists 0.2.5 without a release date, while the mainnet program was redeployed on 2026-10-15 ([D-changelog], E1).

## Sources

Program source, `MeteoraAg/damm-v2` at `5398b5c7c534de014091132da37c6478cce671a8` (paths under `programs/cp-amm/src/`):

- **P-root**: https://github.com/MeteoraAg/damm-v2/tree/5398b5c7c534de014091132da37c6478cce671a8
- **P-changelog**: https://github.com/MeteoraAg/damm-v2/blob/5398b5c7c534de014091132da37c6478cce671a8/CHANGELOG.md
- **P-const**: https://github.com/MeteoraAg/damm-v2/blob/5398b5c7c534de014091132da37c6478cce671a8/programs/cp-amm/src/constants.rs#L67-L171
- **P-act-params**: https://github.com/MeteoraAg/damm-v2/blob/5398b5c7c534de014091132da37c6478cce671a8/programs/cp-amm/src/params/activation.rs#L33-L77
- **P-act-handler**: https://github.com/MeteoraAg/damm-v2/blob/5398b5c7c534de014091132da37c6478cce671a8/programs/cp-amm/src/utils/activation_handler.rs#L83-L93
- **P-timing**: https://github.com/MeteoraAg/damm-v2/blob/5398b5c7c534de014091132da37c6478cce671a8/programs/cp-amm/src/state/config.rs#L231-L271
- **P-access**: https://github.com/MeteoraAg/damm-v2/blob/5398b5c7c534de014091132da37c6478cce671a8/programs/cp-amm/src/pool_action_access/permissionless.rs#L18-L60
- **P-init**: https://github.com/MeteoraAg/damm-v2/blob/5398b5c7c534de014091132da37c6478cce671a8/programs/cp-amm/src/instructions/initialize_pool/ix_initialize_customizable_pool.rs
- **P-tsched**: https://github.com/MeteoraAg/damm-v2/blob/5398b5c7c534de014091132da37c6478cce671a8/programs/cp-amm/src/base_fee/fee_time_scheduler.rs
- **P-msched**: https://github.com/MeteoraAg/damm-v2/blob/5398b5c7c534de014091132da37c6478cce671a8/programs/cp-amm/src/base_fee/fee_market_cap_scheduler.rs#L122-L204
- **P-fee-params**: https://github.com/MeteoraAg/damm-v2/blob/5398b5c7c534de014091132da37c6478cce671a8/programs/cp-amm/src/params/fee_parameters.rs
- **P-fee**: https://github.com/MeteoraAg/damm-v2/blob/5398b5c7c534de014091132da37c6478cce671a8/programs/cp-amm/src/state/fee.rs
- **P-pool**: https://github.com/MeteoraAg/damm-v2/blob/5398b5c7c534de014091132da37c6478cce671a8/programs/cp-amm/src/state/pool.rs
- **P-pos**: https://github.com/MeteoraAg/damm-v2/blob/5398b5c7c534de014091132da37c6478cce671a8/programs/cp-amm/src/state/position.rs#L91-L213
- **P-lockpos**: https://github.com/MeteoraAg/damm-v2/blob/5398b5c7c534de014091132da37c6478cce671a8/programs/cp-amm/src/instructions/ix_lock_position.rs#L13-L70
- **P-cl**: https://github.com/MeteoraAg/damm-v2/blob/5398b5c7c534de014091132da37c6478cce671a8/programs/cp-amm/src/liquidity_handler/concentrated_liquidity.rs#L66-L104
- **P-swap**: https://github.com/MeteoraAg/damm-v2/blob/5398b5c7c534de014091132da37c6478cce671a8/programs/cp-amm/src/instructions/swap/ix_p_swap.rs#L80-L176
- **P-status**: https://github.com/MeteoraAg/damm-v2/blob/5398b5c7c534de014091132da37c6478cce671a8/programs/cp-amm/src/instructions/operator/ix_set_pool_status.rs
- **P-lib**: https://github.com/MeteoraAg/damm-v2/blob/5398b5c7c534de014091132da37c6478cce671a8/programs/cp-amm/src/lib.rs

TypeScript SDKs:

- **S-root**: https://github.com/MeteoraAg/damm-v2-sdk/tree/7ba4162ed925c609b6737010ecd73835edf7b2cd (npm `@meteora-ag/cp-amm-sdk` 1.5.1)
- **S-single**: https://github.com/MeteoraAg/damm-v2-sdk/blob/7ba4162ed925c609b6737010ecd73835edf7b2cd/src/CpAmm.ts#L1773-L1803
- **S-create**: https://github.com/MeteoraAg/damm-v2-sdk/blob/7ba4162ed925c609b6737010ecd73835edf7b2cd/src/CpAmm.ts#L1995-L2117
- **S-tsched**: https://github.com/MeteoraAg/damm-v2-sdk/blob/7ba4162ed925c609b6737010ecd73835edf7b2cd/src/helpers/common.ts#L179-L256
- **S-msched**: https://github.com/MeteoraAg/damm-v2-sdk/blob/7ba4162ed925c609b6737010ecd73835edf7b2cd/src/helpers/common.ts#L265-L365
- **S-dyn**: https://github.com/MeteoraAg/damm-v2-sdk/blob/7ba4162ed925c609b6737010ecd73835edf7b2cd/src/helpers/common.ts#L546-L592
- **A-root**: https://github.com/MeteoraAg/alpha-vault-sdk/tree/1bfa0c8277b336d5ee80e698970696bab5829873 (npm `@meteora-ag/alpha-vault` 1.1.16)
- **A-point**: https://github.com/MeteoraAg/alpha-vault-sdk/blob/1bfa0c8277b336d5ee80e698970696bab5829873/ts-client/src/alpha-vault/index.ts#L89-L120
- **A-create**: https://github.com/MeteoraAg/alpha-vault-sdk/blob/1bfa0c8277b336d5ee80e698970696bab5829873/ts-client/src/alpha-vault/index.ts#L262-L416
- **A-deposit**: https://github.com/MeteoraAg/alpha-vault-sdk/blob/1bfa0c8277b336d5ee80e698970696bab5829873/ts-client/src/alpha-vault/index.ts#L958-L1010
- **A-fill**: https://github.com/MeteoraAg/alpha-vault-sdk/blob/1bfa0c8277b336d5ee80e698970696bab5829873/ts-client/src/alpha-vault/helper/index.ts#L252-L328
- **A-idl**: https://github.com/MeteoraAg/alpha-vault-sdk/blob/1bfa0c8277b336d5ee80e698970696bab5829873/idls/alpha_vault.json (instructions `initialize_prorata_vault`, `fill_damm_v2`, `create_permissioned_escrow_with_authority`)

Meteora and Jupiter docs:

- **D-tsched**: https://docs.meteora.ag/core-products/damm-v2/fees/time-scheduler (fetched 2026-10-26)
- **D-msched**: https://docs.meteora.ag/core-products/damm-v2/fees/market-cap-scheduler (fetched 2026-10-26)
- **D-changelog**: https://docs.meteora.ag/developer-guides/damm-v2/changelog (fetched 2026-10-26)
- **D-av**: https://docs.meteora.ag/helper-products/alpha-vault/what-is-alpha-vault (fetched 2026-10-26)
- **D-invent**: https://docs.meteora.ag/invent/launch-pools/damm-v2-launch-pool (knowledge-base snapshot of 2026-10-04, `raw/meteora-docs/pages/invent__launch-pools__damm-v2-launch-pool.md`)
- **J-listing**: https://developers.jup.ag/docs/swap/routing/amm/market-listing (knowledge-base snapshot, `raw/jupiter-developers/pages/swap__routing__amm__market-listing.md` and `jupiter/02-developer-platform-and-apis.md`)

Owner's knowledge base (local copy `/Volumes/Farhan/Work Folder/Dev/AI/Research-Projects/jupiter-meteora`, private GitHub copy `imDev2023/jupiter-meteora-resources`, snapshot 2026-10-04):

- **KB-01-3**: `meteora/01-products-and-protocol.md` section 3.3 (concentrated liquidity: "The range is pool-level; DAMM v2 positions do NOT choose independent per-position ranges", and the token formulas).
- **KB-01-6**: `meteora/01-products-and-protocol.md` section 6.2.
- **KB-02**: `meteora/02-dev-dlmm-damm.md` section 2.2 ("No cluster option is needed; the program ID is identical on devnet and mainnet").

Top-pad research branches:

- **DLMM-FO**: https://github.com/imDev2023/top-pad/blob/research/dlmm-fair-open/research/dlmm-fair-open.md
- **DBC-IL**: https://github.com/imDev2023/top-pad/blob/research/dbc-instant-launch/research/dbc-instant-launch.md (E8: slot time measured at 211.6 ms on mainnet on 2026-10-26)

On-chain reads: Helius mainnet and devnet RPC and Alchemy mainnet RPC on 2026-10-26 (`getProgramAccounts`, `getMultipleAccounts`, `getSignaturesForAddress`, `getTransaction`, Helius `getTransactionsForAddress`, `simulateTransaction`, program-data accounts).

<!-- reference link targets -->
[P-root]: https://github.com/MeteoraAg/damm-v2/tree/5398b5c7c534de014091132da37c6478cce671a8
[P-changelog]: https://github.com/MeteoraAg/damm-v2/blob/5398b5c7c534de014091132da37c6478cce671a8/CHANGELOG.md
[P-const]: https://github.com/MeteoraAg/damm-v2/blob/5398b5c7c534de014091132da37c6478cce671a8/programs/cp-amm/src/constants.rs#L67-L171
[P-act-params]: https://github.com/MeteoraAg/damm-v2/blob/5398b5c7c534de014091132da37c6478cce671a8/programs/cp-amm/src/params/activation.rs#L33-L77
[P-act-handler]: https://github.com/MeteoraAg/damm-v2/blob/5398b5c7c534de014091132da37c6478cce671a8/programs/cp-amm/src/utils/activation_handler.rs#L83-L93
[P-timing]: https://github.com/MeteoraAg/damm-v2/blob/5398b5c7c534de014091132da37c6478cce671a8/programs/cp-amm/src/state/config.rs#L231-L271
[P-access]: https://github.com/MeteoraAg/damm-v2/blob/5398b5c7c534de014091132da37c6478cce671a8/programs/cp-amm/src/pool_action_access/permissionless.rs#L18-L60
[P-init]: https://github.com/MeteoraAg/damm-v2/blob/5398b5c7c534de014091132da37c6478cce671a8/programs/cp-amm/src/instructions/initialize_pool/ix_initialize_customizable_pool.rs
[P-tsched]: https://github.com/MeteoraAg/damm-v2/blob/5398b5c7c534de014091132da37c6478cce671a8/programs/cp-amm/src/base_fee/fee_time_scheduler.rs
[P-msched]: https://github.com/MeteoraAg/damm-v2/blob/5398b5c7c534de014091132da37c6478cce671a8/programs/cp-amm/src/base_fee/fee_market_cap_scheduler.rs#L122-L204
[P-fee-params]: https://github.com/MeteoraAg/damm-v2/blob/5398b5c7c534de014091132da37c6478cce671a8/programs/cp-amm/src/params/fee_parameters.rs
[P-fee]: https://github.com/MeteoraAg/damm-v2/blob/5398b5c7c534de014091132da37c6478cce671a8/programs/cp-amm/src/state/fee.rs
[P-pool]: https://github.com/MeteoraAg/damm-v2/blob/5398b5c7c534de014091132da37c6478cce671a8/programs/cp-amm/src/state/pool.rs
[P-pos]: https://github.com/MeteoraAg/damm-v2/blob/5398b5c7c534de014091132da37c6478cce671a8/programs/cp-amm/src/state/position.rs#L91-L213
[P-lockpos]: https://github.com/MeteoraAg/damm-v2/blob/5398b5c7c534de014091132da37c6478cce671a8/programs/cp-amm/src/instructions/ix_lock_position.rs#L13-L70
[P-cl]: https://github.com/MeteoraAg/damm-v2/blob/5398b5c7c534de014091132da37c6478cce671a8/programs/cp-amm/src/liquidity_handler/concentrated_liquidity.rs#L66-L104
[P-swap]: https://github.com/MeteoraAg/damm-v2/blob/5398b5c7c534de014091132da37c6478cce671a8/programs/cp-amm/src/instructions/swap/ix_p_swap.rs#L80-L176
[P-status]: https://github.com/MeteoraAg/damm-v2/blob/5398b5c7c534de014091132da37c6478cce671a8/programs/cp-amm/src/instructions/operator/ix_set_pool_status.rs
[P-lib]: https://github.com/MeteoraAg/damm-v2/blob/5398b5c7c534de014091132da37c6478cce671a8/programs/cp-amm/src/lib.rs
[S-root]: https://github.com/MeteoraAg/damm-v2-sdk/tree/7ba4162ed925c609b6737010ecd73835edf7b2cd
[S-single]: https://github.com/MeteoraAg/damm-v2-sdk/blob/7ba4162ed925c609b6737010ecd73835edf7b2cd/src/CpAmm.ts#L1773-L1803
[S-create]: https://github.com/MeteoraAg/damm-v2-sdk/blob/7ba4162ed925c609b6737010ecd73835edf7b2cd/src/CpAmm.ts#L1995-L2117
[S-tsched]: https://github.com/MeteoraAg/damm-v2-sdk/blob/7ba4162ed925c609b6737010ecd73835edf7b2cd/src/helpers/common.ts#L179-L256
[S-msched]: https://github.com/MeteoraAg/damm-v2-sdk/blob/7ba4162ed925c609b6737010ecd73835edf7b2cd/src/helpers/common.ts#L265-L365
[S-dyn]: https://github.com/MeteoraAg/damm-v2-sdk/blob/7ba4162ed925c609b6737010ecd73835edf7b2cd/src/helpers/common.ts#L546-L592
[A-root]: https://github.com/MeteoraAg/alpha-vault-sdk/tree/1bfa0c8277b336d5ee80e698970696bab5829873
[A-point]: https://github.com/MeteoraAg/alpha-vault-sdk/blob/1bfa0c8277b336d5ee80e698970696bab5829873/ts-client/src/alpha-vault/index.ts#L89-L120
[A-create]: https://github.com/MeteoraAg/alpha-vault-sdk/blob/1bfa0c8277b336d5ee80e698970696bab5829873/ts-client/src/alpha-vault/index.ts#L262-L416
[A-deposit]: https://github.com/MeteoraAg/alpha-vault-sdk/blob/1bfa0c8277b336d5ee80e698970696bab5829873/ts-client/src/alpha-vault/index.ts#L958-L1010
[A-fill]: https://github.com/MeteoraAg/alpha-vault-sdk/blob/1bfa0c8277b336d5ee80e698970696bab5829873/ts-client/src/alpha-vault/helper/index.ts#L252-L328
[A-idl]: https://github.com/MeteoraAg/alpha-vault-sdk/blob/1bfa0c8277b336d5ee80e698970696bab5829873/idls/alpha_vault.json
[D-tsched]: https://docs.meteora.ag/core-products/damm-v2/fees/time-scheduler
[D-msched]: https://docs.meteora.ag/core-products/damm-v2/fees/market-cap-scheduler
[D-changelog]: https://docs.meteora.ag/developer-guides/damm-v2/changelog
[D-av]: https://docs.meteora.ag/helper-products/alpha-vault/what-is-alpha-vault
[D-invent]: https://docs.meteora.ag/invent/launch-pools/damm-v2-launch-pool
[J-listing]: https://developers.jup.ag/docs/swap/routing/amm/market-listing
[KB-01-3]: https://github.com/imDev2023/jupiter-meteora-resources/blob/main/meteora/01-products-and-protocol.md
[KB-01-6]: https://github.com/imDev2023/jupiter-meteora-resources/blob/main/meteora/01-products-and-protocol.md
[KB-02]: https://github.com/imDev2023/jupiter-meteora-resources/blob/main/meteora/02-dev-dlmm-damm.md
[DLMM-FO]: https://github.com/imDev2023/top-pad/blob/research/dlmm-fair-open/research/dlmm-fair-open.md
[DBC-IL]: https://github.com/imDev2023/top-pad/blob/research/dbc-instant-launch/research/dbc-instant-launch.md
