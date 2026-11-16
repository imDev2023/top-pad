# The acceptance run

The run that decides the devnet build is done (spec 11, [#62](https://github.com/imDev2023/top-pad/issues/62)): every mandatory integration test of spec 11.2 and all four attack simulations of spec 11.1, passing on devnet from one command.
This report records the run of 2026-11-15 (`2026-11-15T21-03-48`, from slot 522,675,659) and what it proved, and resolves each point spec 16 lists as unproven.

## Answer

Every stage passed: 19 of the 20 in `pnpm acceptance`'s run of 2026-11-15, and the bundler simulation, which failed when this Mac's network dropped under its browser (`net::ERR_NETWORK_CHANGED` loading a page, after its bundle had landed), and passed on `pnpm acceptance --only bundler` straight after.
So every mandatory integration test of spec 11.2 that devnet can run and all four attack simulations of spec 11.1 pass on devnet from one command.
The run took 2 hours 14 minutes and the bundler's rerun 78 minutes; the bank paid about 3.7 SOL and the keeper key about 0.1.

| Stage | Result | Minutes | Bank change (SOL) | Keeper change (SOL) | Proves |
| - | - | -: | -: | -: | - |
| verified-builds | passed | 9.3 | 0.000 | 0.000 | 11.2: both programs deployed from verified builds, rebuilt from the commit recorded on chain |
| configs | passed | 0.1 | 0.000 | 0.000 | 11.2: Heat's two DBC configs as spec 3 sets them, and the generated clients reading Meteora's accounts |
| instant-launch | passed | 0.1 | -0.034 | 0.000 | 11.2: an Instant launch as the launch service builds it, its creation-slot buy at the 99% cliff |
| fee-claims | passed | 2.9 | -0.266 | -0.000 | 11.2: the fee program's PDA claiming partner fees by CPI, the 60 s window claim, the 50/50 split to the creator role holder |
| fair-open-window | passed | 16.2 | -0.002 | 0.000 | 11.2: a Fair Open's window on chain: seats, caps, admissions, the minimum raise, the late failure and every refund |
| fair-open-open | passed | 14.5 | -1.117 | -0.000 | 11.2: a full Fair Open (the open, the lock escrow's cliff and recipient, the pushes, the Tax Share, closed seats) and a partial fill |
| graduation-8.5 | passed | 2 | -1.885 | -0.025 | 11.2: an Instant launch through to Graduation at 8.5 SOL by our deployed keeper, both LP halves locked, the fee stepping down |
| usdc-instant | passed | 1.9 | -0.025 | -0.025 | 11.2: an Instant launch in Circle's devnet USDC through Graduation, the creator's earnings claimed in USDC |
| usdc-fair-open-refunds | passed | 2.2 | -0.000 | -0.000 | 11.2: a Fair Open in USDC: deposits through the API and to the program, a withdrawal, the failure and every refund in USDC |
| usdc-fair-open | passed | 3.3 | -0.027 | -0.000 | 11.2: a Fair Open in USDC that opens: refunds, pushes, the Tax Share and the creator's earnings in USDC |
| token2022-instant | passed | 1.8 | -0.025 | -0.025 | 11.2 (the stand-in xStock's path, in T22Q until Meteora badges the stand-in, #115): an Instant launch in a Token-2022 quote through Graduation |
| token2022-fair-open | passed | 3.7 | -0.030 | -0.025 | 11.2 (the stand-in xStock's path, in T22Q, #115): a Fair Open in a Token-2022 quote through its open, Tax Share and Graduation |
| sniper | passed | 5.9 | -0.064 | -0.000 | 11.1: the sniper simulation |
| failure | passed | 18.2 | -0.000 | -0.000 | 11.1: the failure simulation |
| fair-open-scheduled | passed | 11.6 | -0.032 | -0.000 | 11.2: a Fair Open scheduled from the site, the 64-rung ladder signed in one approval (the test wallet), opened and settled by the deployed keeper; Turbo serving its metadata |
| sign-at-open | passed | 11.5 | -0.029 | -0.000 | 11.2: the sign-at-the-open fallback for a wallet that cannot sign the ladder |
| farm | passed | 22.2 | -0.063 | -0.000 | 11.1: the farm simulation |
| bundler | passed on its rerun (`2026-11-15T23-18-59`); the run's own try failed on `net::ERR_NETWORK_CHANGED`, this Mac's network dropping | 78.3 | -0.062 | -0.000 | 11.1: the bundler simulation |
| compute | passed | 0.1 | 0.000 | 0.000 | 11.2: each instruction's compute, measured from every transaction of both programs during the run |
| opens | passed | 0 | 0.000 | 0.000 | 11.2: Turbo serving each open's metadata within 10 s, before its rung; how late each open landed |

Two checks of spec 11.2 are outside the run, as the ticket allows:
- **The ladder in Phantom, Solflare and Backpack**: the acceptance criterion excepts wallet signing, which only the owner can approve; the run signs the schedule and all 64 rungs in one request with the test wallet and runs the sign-at-the-open fallback, and the three wallets' checks wait on the ticket for the owner.
- **The stand-in xStock with its devnet TokenBadge and a pause**: Meteora has not badged the stand-in on devnet (owner, 2026-11-08), so its own run is [#115](https://github.com/imDev2023/top-pad/issues/115); the run takes every Token-2022 path in T22Q, devnet's Token-2022 test quote, which DBC takes with no badge, and the pause runs in LiteSVM in mainnet NVDAx's own mint (#91).

## How to run it

`direnv exec "<main checkout>" pnpm acceptance` from the repo's root, with Docker running and Heat's devnet keys in `~/.config/top-pad/devnet`.
It runs each stage in `tests/acceptance/src/stages.ts` in turn, one at a time, since every on-chain step shares the free devnet endpoints and every UI spec the one deployed site, and keeps going past a failed stage so one run shows every result.
Each stage is an existing devnet test, UI spec or check, run exactly as it is run by hand; the bundler simulation's two operator apps are started for it and stopped after it.
Each stage's output goes to `tests/acceptance/runs/<run>/<stage>.log` (gitignored), with `results.md`, `compute.md` and `opens.md` beside them.
`--only a,b`, `--skip a,b` and `--from a` choose stages, and `--list` prints the plan.
It takes about three and a half hours and about 4 devnet SOL from Heat's bank, about 10 of it lent at once at the 8.5 SOL Graduation; the bank must hold each stage's peak plus 1 SOL before the stage starts, or the stage is not run.

## Spec 11.2, test by test

- **Both programs deployed from verified builds** (`verified-builds`): the fee program and the Fair Open program were rebuilt from GitHub by `solana-verify verify-from-repo` at the commit each one's verification records on chain (`c00ca9e` and `5781cfc`, signed by the upgrade authority), and each rebuild's executable hash equals the deployed program's (`b2a53339...` and `7211be34...`); neither program's source has changed since those commits but for its tests, so the code this repo holds is the code devnet runs.
- **Each instruction's compute measured** (`compute`): every transaction that named either program during the run, read back and walked invocation by invocation (below).
- **A full Fair Open, plus a partial fill** (`fair-open-open`, `fair-open-window`): the window on chain (seats, caps, admissions, the minimum raise, a second wallet of a seated person refused, the late failure and every refund to the lamport); then an oversubscribed pot of 3 Verified and 6 Unverified seats opened in one transaction of 1,093 bytes, the pot paying exactly 1.25% while a sniper's buy in its slot paid 99%, every seat's coins and refund equal to the reference calculation, the creator's coins in a Jupiter Lock escrow released from day 7 to day 30 to the Creator wallet, the Tax Share collected and paid to every other seat as it closed, and the launch closed; a partial fill opened on a lower rung, and a depositor claimed alone.
- **The 64-rung ladder in one approval, and the fallback** (`fair-open-scheduled`, `sign-at-open`): a creator scheduled a Fair Open from the deployed site and the test wallet signed the schedule and the 64 rungs in one request; nothing about the sealed coin reached the depositor's page before the open; the deployed keeper uploaded the metadata, opened it at its time and pushed every seat, and the revealed coin's name, ticker and metadata URI hash to what the launch committed.
  A wallet that refused the batch was offered the schedule alone and signed only the rung the pot covered, at the open.
- **Turbo serving the metadata within 10 s, before the rung** (`opens`): the deployed keeper uploaded each of the run's three keeper-opened Fair Opens' metadata 13.0 to 13.7 s before its open, and `turbo-gateway.com` served it 0.37 to 0.42 s after the upload, each time before the rung landed, so the keeper's 10 s hold never waited (below).
- **The fee program's PDA claim, the 60 s window claim and the 50/50 split** (`fee-claims`): a Heat coin's window claim, refused inside its Tax window, ran 0 s after the window ended and paid the treasury exactly the window's tax (15,318,667 lamports), whether the test's claim or the deployed keeper's landed first; the creator's claim then paid the creator and the treasury 400,000 lamports each, exactly half the fees since, and moved with the creator role when it was handed to another wallet; a pool made around Heat's flow, which no keeper claims, showed a claim 2 s late moving exactly the late seconds' fees (7,789,667 lamports of tax and 500,000 of one late trade's normal fee).
- **Graduation at 8.5 SOL by our keeper, both LP halves locked, the fee stepping down; an Instant launch through to Graduation** (`graduation-8.5`): an Instant launch on Heat's own Instant config was bought to its 8.5 SOL target, and the deployed keeper's Graduation Workflow migrated it into DAMM v2, split its surplus (0) and burnt its leftover (3 raw units), with nobody online; both positions were permanently locked, half each to within DAMM v2's rounding, the creator's to the creator and Heat's to the fee program's `fee_claimer`, and the creator's withdrawal was refused; the graduated pool's fee stood at 1.25%, stepped down to 1.23% once a buy of a fifth of the pool's quote lifted the price past a step, and back to 1.25% on a sell; Heat's LP fees reached the treasury and the creator claimed their curve earnings and LP fees in one transaction, each to the lamport.
- **One Fair Open and one Instant launch in Circle's devnet USDC** (`usdc-instant`, `usdc-fair-open-refunds`, `usdc-fair-open`): an Instant launch in USDC on USDC's rehearsal config (a test-only Graduation Target of 2.5 USDC, 0.25 SOL's worth at devnet's 10 USDC a SOL, made by the config generator, `tests/devnet/src/rehearsals.ts`) graduated with every check of the SOL Graduation, the creator's earnings claimed in USDC; a Fair Open in USDC took deposits through the API and to the program, gave one back in its window, failed below the lowest rung and refunded every deposit in USDC to the raw unit; and a Fair Open in USDC on the config USDC's `QuoteSettings` name opened on the rung below what its three seats asked, pushed each seat its coins and its refund in USDC to the raw unit, paid its Tax Share in USDC, and paid the creator their Creator Earnings in USDC, half the partner's part of the pot's fee, to the raw unit.
  The ticket's "never offered on the site" holds for mainnet, whose quotes are SOL and the cohort's xStocks (`CLUSTERS.mainnet.quotes`, spec 15); on devnet the launch form has offered USDC since #90, standing in for a stock quote until the stand-in xStock is badged, and the rehearsal configs are watched by nothing.
- **One Fair Open and one Instant launch in a Token-2022 quote, through to Graduation** (`token2022-instant`, `token2022-fair-open`): both in T22Q, standing for the stand-in xStock (above); the Fair Open's pot spent its cap of 5 T22Q and refunded the rest, its Tax Share went out in T22Q, and both coins graduated with every check of the SOL Graduation.

## Spec 11.1, the four simulations

Each passes on its own condition from spec 11.1, as #56 and #60 built them.

- **Sniper** (`sniper`): a bot that knows the mint before the coin exists sprayed 30 pre-signed buys behind each creation and bought again 1, 5, 30 and 60 s later.
  It landed 17 copies in the Instant launch's creation slot and 10 in the Fair Open's, every one at 99.000%; every later buy paid exactly the schedule at its second (97.371% at 1 s, 90.854% at 5 s, 50.125% at 30 s, 48.496% at 31 s, 1.250% at 60 s); the Fair Open's pot paid 1.250%, 6,204,767 lamports on a 496,381,335 rung; the Instant window claim paid the treasury 4,599,719 lamports, the partner's part of all 20 swaps before it, 0 s after the window, and the Fair Open's Tax Share took 4,913,516, that of its 23 swaps but the pot's.
- **Bundler** (`bundler`): a creator linked X and funded 4 wallets directly, and the Creator wallet and those 4 bought their Instant launch in its creation slot (the second try; the first's bundle missed the slot) and sold 2 minutes later, losing 98.9989% of what their creation-slot buys spent (3,000,055 lamports for 30,035 back).
  Bundle Radar linked the 4 wallets to the creator; the case opened 64.9 minutes after the launch with its evidence pack, and an operator confirmed it in a local operator app; our launch key then refused the creator's next launch (`barred`), and the creator's X direct message went out 51 s after the Bar.
  The creator alone saw the Bar, its evidence, a reply box and the appeal form in the 72-hour private window; a barred creator still deposited in another creator's Fair Open and claimed their Creator Earnings; past the window (moved to now, standing in for the 72 hours) the finding showed on the record and the coin's page; and an appeal upheld by a second operator, the first being refused it, cleared the public record while the audit log kept the finding.
- **Farm** (`farm`): a creator scheduled a Fair Open from the deployed site and the deployed keeper opened and pushed it; every deposit went through the API's admission.
  The farm's first two wallets raced to admission and the second's deposit was refused on chain; the other 98 were refused by admission in 109 s, each told which wallet holds the seat; all 4 wallets the Creator wallet funded were refused; 21 seats shared 1,699,999,995 lamports of fills at levels of 0.108333333 SOL and 0.047222222 SOL for the Unverified seats, whose fills came to 424,999,998, 25.000%; the program's levels matched `@top-pad/chain`'s reference and the API's answer to the lamport; the keeper's open landed 1 s after its time and every seat had its coins and refund 11 s after it.
- **Failure** (`failure`): every attempt landed on chain as a refusal: the creator's nonce advance, authorize and withdraw (the nonce unchanged), the right rung 20 s early, a rung one step smaller than the pot covered, a rung for the sealed coin with its name changed by a character, and the right rung 15 minutes late; then, with the keeper off, a depositor marked the launch failed and each of the four depositors withdrew their deposit and both rents, 3,042,920 lamports, from the chain alone, to the lamport.

## Compute

Every instruction of both programs, measured from the transactions the run sent, the deployed keeper's included, read back from the chain: what each invocation consumed, the Meteora and token programs it called included, as a transaction's compute budget must cover it.
The settings instructions the run never sends are simulated with the values on chain now, so nothing is written; each program's `initialize` ran once and cannot run again.
A refused invocation is the failure simulation's attempts or a window claim that lost its race to the keeper.

| Program | Instruction | Measured from | Landed | Refused | Min CU | Median CU | Max CU |
| - | - | - | -: | -: | -: | -: | -: |
| fee | `burn_leftover` | the run | 4 | 0 | 25,899 | 25,899 | 34,899 |
| fee | `claim_fair_open_window_fees` | the run | 9 | 0 | 19,121 | 25,121 | 41,266 |
| fee | `claim_fees` | the run | 10 | 0 | 14,433 | 58,718 | 70,403 |
| fee | `claim_lp_fees` | the run | 5 | 0 | 38,355 | 39,557 | 41,048 |
| fee | `claim_surplus` | the run | 4 | 0 | 29,888 | 40,617 | 41,904 |
| fee | `claim_unlisted_window_fees` | the run | 1 | 0 | 54,025 | 54,025 | 54,025 |
| fee | `claim_window_fees` | the run | 7 | 2 | 17,415 | 37,859 | 37,859 |
| fee | `initialize` | not measured | 0 | 0 | - | - | - |
| fee | `register_coin` | the run | 7 | 0 | 13,893 | 13,893 | 19,893 |
| fee | `register_fair_open_coin` | the run | 9 | 0 | 15,563 | 17,063 | 18,563 |
| fee | `update_fee_config` | simulation | 0 | 0 | 9,959 | 9,959 | 9,959 |
| fair_open | `claim` | the run | 1 | 0 | 40,904 | 40,904 | 40,904 |
| fair_open | `close_launch` | the run | 13 | 0 | 13,530 | 13,530 | 19,441 |
| fair_open | `collect_tax_share` | the run | 9 | 0 | 104,627 | 116,234 | 136,214 |
| fair_open | `create_launch` | the run | 13 | 0 | 42,759 | 45,760 | 64,058 |
| fair_open | `deposit` | the run | 59 | 2 | 40,402 | 41,902 | 50,902 |
| fair_open | `initialize` | not measured | 0 | 0 | - | - | - |
| fair_open | `lock_creator` | the run | 1 | 0 | 101,535 | 101,535 | 101,535 |
| fair_open | `mark_failed` | the run | 4 | 0 | 75,055 | 75,765 | 75,957 |
| fair_open | `open` | the run | 9 | 4 | 62,079 | 99,141 | 106,047 |
| fair_open | `push` | the run | 8 | 0 | 56,459 | 87,872 | 130,157 |
| fair_open | `push_tax_share` | the run | 10 | 0 | 27,857 | 41,778 | 87,712 |
| fair_open | `set_quote_manager` | simulation | 0 | 0 | 13,974 | 13,974 | 13,974 |
| fair_open | `set_quote_settings` | simulation | 0 | 0 | 14,013 | 14,013 | 14,013 |
| fair_open | `settle` | the run | 9 | 0 | 54,128 | 58,764 | 61,764 |
| fair_open | `update_program_config` | simulation | 0 | 0 | 12,018 | 12,018 | 12,018 |
| fair_open | `withdraw` | the run | 2 | 0 | 30,073 | 35,276 | 35,276 |
| fair_open | `withdraw_failed` | the run | 11 | 0 | 29,461 | 29,461 | 34,656 |

## Opens and Turbo

Every Fair Open the deployed keeper opened during the run, from what it recorded in the devnet database.
A rung signed at the open waits on the creator's click, so only a signed ladder's open is held to 2 s.

| Launch | Ladder | Uploaded before the open | Served after the upload | Before the rung | Landed after its time | Every seat delivered after the open |
| - | - | -: | -: | - | -: | -: |
| `egRD8pkKDv8TbcQb5T8MQ2o3MtKL2ESFMXkgWXf3uCK` | signed | 12.97 s | 0.39 s | yes | 1.00 s | 11.56 s |
| `5sJicrMBbTmVErpRiPTpkHSJ1mevpDqEgUgaBpivNSK1` | at_open | 13.70 s | 0.37 s | yes | 3.00 s | 12.32 s |
| `83jbuKuguAKNqoqNdpeFQfN3CpsBwcsA86xmGGizbz8L` | signed | 13.44 s | 0.42 s | yes | 1.00 s | 11.83 s |

## Spec 16's unproven points

Each point spec 16 lists as unproven and proved by section 11's tests, and where this run leaves it:
- **The Jupiter Lock CPI**: proven; `fair-open-open`'s Creator lock made the escrow by CPI with the right cliff, end and recipient and nobody able to cancel it, as since #49.
- **The `fee_claimer` PDA's claims by CPI**: proven; `claim_window_fees`, `claim_fees`, `claim_unlisted_window_fees`, `claim_fair_open_window_fees`, `claim_surplus` and `claim_lp_fees` all landed in the run.
- **The Fair Open program's deposits, admissions, withdrawals, failure path, open, settle, pushes, claims and a partial fill**: proven, every one in the run; the creation transaction measured 1,093 bytes, as in #46.
- **Wallets signing a 64-rung ladder in one prompt**: proven for the wallet standard as Heat's launch flow asks it (the test wallet signed 65 transactions in one request on the deployed site), with the fallback working; still unproven in Phantom, Solflare and Backpack themselves, which wait for the owner on #62.
- **A sniper's separate transaction landing in the creation slot**: proven; the sniper simulation's bot landed 17 of 30 copies in an Instant launch's creation slot and 10 of 30 in a Fair Open's, every one paying 99.000%, and `fair-open-open`'s sniper 1 of 20.
- **Turbo serving an upload within 10 s**: proven; 0.37 to 0.42 s after the upload for every keeper-opened Fair Open of the run, each before its rung, as 0.26 to 0.54 s in #50 and in the runs before this one.
- **How precisely a Workflow wakes**: proven to stay in the Workflow; every open with a signed ladder landed 1 s after its time by the chain's clock (0 s in the runs before), under the 2 s past which it would move to a Durable Object alarm, and the window claims 0 to 1 s after their minute.
- **Codama's output for Meteora's IDLs**: settled in #39; the generated clients read Meteora's accounts in `configs` and drove every Meteora call in the run.
- **The curve and fee-scheduler integers accepted by DBC**: settled in #40; `configs` read both configs back field by field, and the graduated pools' fee schedule read back as configured and stepped as configured.
- **Neon's free plan**: settled in #102; the devnet database runs on the owner's Mac, and the run read and wrote it throughout.
- **The LaserStream Container source**: still unproven, untestable until the paid Helius plan is bought (spec 10.5); the run's indexer used the WebSocket source, which every UI spec's pages and the bundler simulation's Bundle Radar read from.

## Devnet SOL

The run of 2026-11-15 took 3.63 SOL from Heat's bank (18.596 to 14.964) and 0.102 from the keeper key (3.002 to 2.900), and the bundler's rerun 0.062 more from the bank: about 3.8 SOL, against spec 11.4's estimate of about 60 for the whole proof, which counted three 8.5 SOL graduations and about 15 SOL for simulation wallets, most of which a run lends and sweeps back.
Most of it is the 8.5 SOL Graduation (1.885 SOL, the fifth of the target the graduated pool keeps forever, and fees) and the full Fair Open (1.117 SOL, its pools' rent and the pot's 1.25% each way); every other stage spends hundredths, since its wallets are swept back.
At its peak the run lends about 10 SOL at once (the 8.5 SOL Graduation's buyer), so the bank needs about 11 before it starts, and the keeper key at least 0.5: the run checks both before each stage.
The keeper key pays the deployed keeper's migrations (about 0.025 SOL each) as well as the launch key's fees, so a run drains it by about 0.1; an earlier run of the day left it at 0.0017 SOL and a later stage failed for rent, which is why the run now checks it.

## Found and fixed while running it

- **Test coin pictures labelled "looks like" an earlier test coin** ([#107](https://github.com/imDev2023/top-pad/issues/107)): the old recipe reached SSCD 0.60 against the devnet protected set in 19 of 30 draws, which stopped every UI spec that launches from the site.
  `tests/ui/src/picture.ts` now draws dense multi-scale clutter as WebP, measured with the vision service by `pnpm --filter @top-pad/tests-ui picture-check`: over 300 draws the nearest real coin's picture sits at SSCD 0.351, the nearest earlier test picture at 0.520, and no two of 44,850 pairs reach the 0.60 label.
- **The 8.5 SOL Graduation raced the deployed keeper**: `GRADUATION=real` sent the migration itself while the deployed Graduation Workflow migrates any Heat coin whose curve completes; it now waits for the keeper's migration, surplus split and burn and checks each from the chain.
- **The public devnet endpoint's 429s**: a burst of parallel reads in `fair-open-open` was refused through the shared client's 8 retries; it now waits about 3 minutes, jittered, and the acceptance run takes that file's three launches one at a time.
- **The bundle missing the creation slot**: in five tries of five the launch service's creation landed as the 1.6 s spray ended, its slot's copies ordered before it; the spray now covers 2.8 s.
