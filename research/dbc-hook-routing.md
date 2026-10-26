# Do Jupiter and the other routers trade DBC transfer-hook pools?

Research for ticket #22 of the Top-pad wayfinder map, captured 2026-10-26.
It asks whether the aggregators, trading terminals and wallets that memecoin traders use can quote, route, show and move a token whose Meteora Dynamic Bonding Curve (DBC) pool is a transfer-hook pool, how much volume a hook launch would lose, and what changes at graduation, when DBC revokes the hook.
Every claim is tied to a source in the list at the end.
Router behaviour comes from live, read-only quotes taken on 2026-10-26 between 16:30 and 17:30 UTC, from swap transactions sampled on mainnet, and from the routers' deployed program binaries; docs are used for what they promise, not as proof of behaviour.
No transaction was signed or sent.
Anything not checked against a primary source is marked **unverified**.

## Answer

### Who routes or supports DBC transfer-hook pools

"Before graduation" means a live `TransferHookPool` whose base mint still runs its hook; "after graduation" means the same token once DBC has revoked the hook and the token trades on DAMM v2.
Swap shares come from 3,102 swaps on 115 live hook pools (the 120 hook pools with the most trading fees, last 40 transactions each, 2026-06-04 to 2026-10-26) and a baseline of 2,411 swaps on 48 standard DBC pools (2026-10-16 to 2026-10-26) ([E4](#e4-who-routes-hook-pools-on-chain), [E5](#e5-baseline-who-routes-standard-dbc-pools)).

| Router, terminal or wallet | Before graduation: routes or supports hook pools? | Evidence | After graduation |
| --- | --- | --- | --- |
| Jupiter Metis router (`/swap/v2/build`, legacy `/swap/v1/quote`, program `JUP6...`) | **No** | `/build` "No routes found" and `/swap/v1/quote` `TOKEN_NOT_TRADABLE` for 6 of 6 live hook mints, buy and sell, while non-hook DBC curves route; 0 of 3,102 hook swaps called by `JUP6`, against 16.5% of standard DBC swaps ([E2](#e2-live-quotes), [E4](#e4-who-routes-hook-pools-on-chain), [E5](#e5-baseline-who-routes-standard-dbc-pools)) | **Yes**: `/build` and Metis-only `/order` route the DAMM v2 pools of 4 of 4 graduated hook mints; `JUP6` called 48% of 316 swaps on five graduated hook mints' pools ([E7](#e7-after-graduation)) |
| Jupiter Meta-Aggregator (`/swap/v2/order`, behind jup.ag and Ultra integrations) | **Partly**: through its DFlow and OKX routers only, never Metis or JupiterZ | 6 of 6 live hook mints quoted both ways with `router: dflow` (and `okx` when isolated), about 0.1% below DFlow's own quote; 16 of 60 sampled OKX-routed hook swaps carry the marker account Jupiter puts in its `/order` transactions; an integration that sets `payer` is Metis-only and so, by inference, gets no route ([E2](#e2-live-quotes), [E6](#e6-how-much-jupiter-flow-re-routes)) | **Yes** (Metis wins the quotes) |
| Jupiter Trigger V2 (limit orders, DCA) | **No**, unless Jupiter whitelists the mint (docs; **unverified** live, it needs a signed login) | Docs: "Tokens with transfer-fee or transfer-hook extensions are rejected at deposit unless whitelisted" ([KB-jup-trigger]) | **Unverified**: the graduated mint still carries an empty TransferHook extension |
| DFlow | **Yes** | Own API quoted 5 of 6 live hook mints both ways via "Dynamic Bonding Curve" (no route for one partner's pool); DFlow's program called 21% of hook swaps (25% of SOL volume); its binary contains the `swap2_with_transfer_hook` discriminator ([E2](#e2-live-quotes), [E3](#e3-router-binaries), [E4](#e4-who-routes-hook-pools-on-chain)) | **Yes** |
| OKX DEX | **Yes** (OKX's own API **unverified**: it needs OKX credentials; tested through Jupiter's OKX router) | 6 of 6 live hook mints quoted both ways through Jupiter's OKX leg; OKX's router `proVF4p...` called 39% of hook swaps (34% of SOL volume), many through OKX's business API with integrator commission; binary contains the discriminator ([E2](#e2-live-quotes), [E3](#e3-router-binaries), [E4](#e4-who-routes-hook-pools-on-chain)) | **Yes** |
| Titan | **No** | Portal quotes `NoRoutesFound` for 6 of 6 live hook mints while it routes non-hook DBC curves via "Meteora DBC"; 0 of 3,102 hook swaps; the Portal key exposes only the Titan and Titan-DART providers ([E2](#e2-live-quotes), [E4](#e4-who-routes-hook-pools-on-chain)) | **Partly**: quoted one graduated mint through Manifest and DLMM pools, found no route for three whose only pool is DAMM v2, and called 0 of 316 post-graduation swaps; it also failed a non-hook Token-2022 DAMM v2 control, so the cause is **unverified** ([E7](#e7-after-graduation)) |
| Axiom | **Yes** | Axiom fee wallets credited in 747 of 3,102 hook swaps (24%, 27% of SOL volume), 746 of them through Axiom's router `FLASHX8...`, whose binary contains the discriminator ([E3](#e3-router-binaries), [E4](#e4-who-routes-hook-pools-on-chain)) | **Yes** (Axiom's router called 19% of post-graduation swaps) |
| GMGN | **Yes** | GMGN fee wallets credited in 205 hook swaps (7%), 196 as direct DBC calls and 9 through GMGN's router `GMGNreQc...`, whose binary contains the discriminator; GMGN's route API answered Cloudflare 403, so no live quote ([E2](#e2-live-quotes), [E4](#e4-who-routes-hook-pools-on-chain)) | **Yes** (on-chain only) |
| Photon | **Yes**, thinly | Photon's fee wallet credited in 9 hook swaps (direct DBC calls); Photon's program `BSfD6SHZ...` contains the discriminator ([E3](#e3-router-binaries), [E4](#e4-who-routes-hook-pools-on-chain)) | **Unverified** (none in the small post-graduation sample) |
| BullX | **Unverified** | No BullX fee wallet in 3,102 hook swaps or 2,411 standard DBC swaps; no public quote API ([E4](#e4-who-routes-hook-pools-on-chain), [E5](#e5-baseline-who-routes-standard-dbc-pools)) | **Unverified** |
| Padre, Trojan, Maestro, Bloom | **Yes** | Their fee wallets credited in 44, 19, 14 and 11 hook swaps; Padre's `terminal-proxy`, Maestro's `maestro-router` and Bloom's router called them ([E4](#e4-who-routes-hook-pools-on-chain)) | **Yes** for Padre and Maestro (1 and 2 post-graduation swaps); others **unverified** |
| Phantom | **Partly verified** | Phantom's docs list Transfer Hooks among the Token-2022 extensions it supports; 28 hook swaps carrying the Lighthouse assertions Phantom adds to transactions it submits all landed; no Phantom-marked wallet-to-wallet transfer of a live hook token was found ([E8](#e8-wallets)) | **Yes** by inference: the hook no longer runs, so a send is an ordinary Token-2022 transfer; 23 plain transfers of a graduated hook mint succeeded, wallet not identified ([E8](#e8-wallets)) |
| Solflare | **Unverified** | No first-party statement on transfer hooks found ([E8](#e8-wallets)) | **Unverified** |
| Backpack | **Unverified** | No first-party statement on transfer hooks found ([E8](#e8-wallets)) | **Unverified** |

- Discovery is not the problem: Jupiter's Tokens API indexes hook mints, labels the largest hook launchpad's tokens `hooked`, and reports their liquidity and 24-hour volume ([E2](#e2-live-quotes)).
- Whether a router can trade a given hook pool also depends on the hook: DFlow's own API found no route for a pool of the busiest hook program by pool count (`AvVQRmi5...`), while Jupiter's DFlow and OKX legs did; the cause is **unverified** ([E2](#e2-live-quotes)).

### What changes after graduation

- All 519 graduated hook mints on mainnet still carry the Token-2022 TransferHook extension, but with its program id and authority set to zero, matching Meteora's description that DBC revokes both before migration ([E1](#e1-the-hook-pool-census), [D-hook]).
- Meteora's docs say the migrated DAMM v2 pool "receives a Token 2022 mint without an active transfer hook", so transfers no longer need hook accounts ([D-hook], [D-t22]).
- Jupiter Metis then routes the token normally: it quoted the DAMM v2 pool of 4 of 4 graduated hook mints, and `JUP6` was the caller in 48% of sampled post-graduation swaps ([E7](#e7-after-graduation)).
- One graduated hook mint did $1.5M of 24-hour volume with a Jupiter organic score of 69, so the hook history does not stop a token from trading normally later ([E7](#e7-after-graduation)).
- Legacy `/swap/v1/quote` still answered `TOKEN_NOT_TRADABLE` for 1 of 4 graduated hook mints, and Titan still found no DAMM v2 route; both are **unverified** as to cause ([E7](#e7-after-graduation)).

### How much volume a hook launch would lose

- The channels that cannot reach a live hook pool are Jupiter's Metis router and Titan.
- On standard DBC curves they carried 17.2% of swaps and 11.8% of SOL volume (Metis 16.5% and 11.7%, Titan 0.7% and 0.1%) in the 48-pool baseline; per pool the median was 5.2% of volume, the middle half 0% to 10.8%, and the maximum 87.9% ([E5](#e5-baseline-who-routes-standard-dbc-pools)).
- In a 3-minute snapshot of all DBC swaps, dominated by a few hot launches traded mostly through direct calls, the same two channels carried 1.7% of swaps and 1.3% of SOL volume ([E5](#e5-baseline-who-routes-standard-dbc-pools)).
- Not all of that flow is lost: Jupiter's `/order` re-routes through DFlow and OKX, and at least 20% of the `JUP6` swaps on standard curves carried Jupiter's `/order` marker, while the rest come from `/build`, legacy Metis and third-party integrations that find no route ([E6](#e6-how-much-jupiter-flow-re-routes)).
- Estimate: before graduation a hook launch would lose roughly 1% to 10% of the SOL volume its curve would otherwise see: about 1% in the all-DBC snapshot, about 4% for the median baseline pool (80% of its 5.2%), about 9% on the pooled baseline (80% of Metis's 11.7% plus Titan's 0.1%), and at most about 12% if none of the Jupiter flow re-routes (inference from [E5](#e5-baseline-who-routes-standard-dbc-pools) and [E6](#e6-how-much-jupiter-flow-re-routes)).
- In swap count the loss is larger, up to 17%, because Metis carries many small trades.
- The live hook pools show the substitution: no Jupiter or Titan at all, but OKX, DFlow and Axiom together carry 85% of swaps, against 33% on standard curves ([E4](#e4-who-routes-hook-pools-on-chain)).
- After graduation nothing is lost: the hook is gone and Jupiter routes the token ([E7](#e7-after-graduation)).
- The estimate assumes traders who reach a curve through Metis do not switch to another path, which overstates the loss; it ignores any effect of hook rules that reject some routed trades by design, which can make the loss far larger (**unverified** for any specific hook).

### What this means for a Top-pad hook

- A Top-pad hook has to accept transfers made inside a DBC swap that a router called by CPI, because OKX, DFlow and Axiom call DBC from their own programs; a rule that insists DBC be the top-level instruction, or that reads the instructions sysvar for a top-level DBC call, would reject most routed buys (inference from [E4](#e4-who-routes-hook-pools-on-chain) and [Th-iface]).
- Keep the hook's extra-account list resolvable by the standard resolver, and test the hook against DFlow and OKX quotes before launch, since one router already failed on one hook design ([E2](#e2-live-quotes), [Sol-hook]).
- Top-pad's own trades are unaffected: ticket #8 chose server-built direct swaps on our pools, and Meteora's SDK builds `swap2_with_transfer_hook` with the hook accounts resolved ([D-sdkhook]).
- For routing beyond our pools, ticket #8 picked Jupiter Swap v2: its `/build` path (Metis only) gets no route for our own hook tokens before graduation, while `/order` still routes them through DFlow and OKX (from [E2](#e2-live-quotes)).
- Limit orders and DCA on Jupiter would not be available for our tokens before graduation unless Jupiter whitelists them ([KB-jup-trigger]).

## Evidence

### E1. The hook pool census

- A full `getProgramAccounts` scan of DBC for the `TransferHookPool` discriminator returned 7,273 pools on 2026-10-26: 6,753 still on the curve, 519 migrated and 1 complete but not yet migrated ([OC-census]).
- Their configs name 302 distinct hook programs and 714 distinct fee claimers; 6,360 pools are quoted in SOL and 663 in USDC ([OC-census]).
- Every base mint is owned by Token-2022, and every live mint's TransferHook extension points at its config's hook program ([OC-census]).
- All 519 migrated mints keep the TransferHook extension with program id and authority equal to the zero key ([OC-census]).
- The largest single hook program by pool count, `AvVQRmi5LwnTN64pkHbUEeAwwMgR2ms3FcL8VbfZV7FH`, serves 2,293 live pools of one fee claimer ([OC-census]).
- The fee claimer `2oXT6oMgNPfToahWG48QTBPWS9UJ8a7TSSeEoeoSLMGt` owns 1,242 hook pools on 34 hook programs, 14 of them graduated; Jupiter's Tokens API labels its tokens' launchpad `hooked` ([OC-census], [J-tokens]).
- That matches third-party descriptions of Hooked, a transfer-hook launchpad on Meteora offering about 23 rules on about 20 hook programs, some of which restrict trading to Hooked's own route (secondary source, [Bitrue-hooked]).
- Of the 120 live hook pools with the most trading fees, 56 traded in the last 7 days and 33 in the last 24 hours; 45 of the 56 belong to the `hooked` fee claimer ([OC-hook-sample]).
- DBC has supported transfer-hook pools since program 0.2.0, scheduled for mainnet on 2026-06-03 (the earliest hook swap sampled here is from 2026-06-04), and its release notes told swap routers to use `swap2_with_transfer_hook` with `TransferHookAccountsInfo` remaining-account metadata ([D-changelog]).
- The standard `swap` and `swap2` instructions reject transfer-hook pools ([D-changelog], [D-hook]).

### E2. Live quotes

Method: each live hook mint was quoted as a 0.1 SOL buy and a 1,000-token sell; nothing was signed or sent ([Q-scripts]).
Live hook mints: `DioisRY2M15WKza2te7pCvEAe7B1EVp4N1ZrM6tn52Sp`, `8V2jTnUbfTDkzznAD2BwhCRR1jJrin3Exj5zPoU2AmJA`, `3ykvcjrzbb5nyJRnzHVEA12sQsZfnTijwxUusN4f8R3R`, `Dvx47FCHEa77thmxtgzfyx35vq3cPvy2D7mZfpCzVwUP`, `61BkPLSPrgzYdJL1n2eVfauWRy92qd3bE7yjUBzc4fiD` (all `hooked`) and `HNLK1BEynxb7aPvprXfXBsm8u72CUGYthGRCrWxCXwjV` (hook `AvVQRmi5...`).
Controls: four non-hook DBC curves, `pNdxE8BeBd4sp4hzUsFo9R74vSGs3PRWjfnkzSobumb` (Token-2022, 54.5% of the way to graduation), `EQpMmLRVf8gSTbufcWXjencbRdWzxVjE4MeBmFsxtddj` (Token-2022, nearly empty), `6pHWYSpADXREYUSimmd85dhq15cVbzJw4ZL1waKBEMZs` and `FXva4kHcbHkLLa8yeHJRvFNksizQGLn2JT6y3iK66JiG` (SPL, the second nearly empty); sells on the two nearly empty curves failed on every router.

| Endpoint | Live hook mints (6) | Non-hook DBC curves (4) |
| --- | --- | --- |
| Jupiter `/swap/v2/order`, all routers | 6 of 6 both ways, `router: dflow` | 4 of 4 buys, routed by Metis or DFlow |
| Jupiter `/order`, Metis only | 0 of 6, "Failed to get quotes" | sometimes "Failed to get quotes", sometimes routed via "Dynamic Bonding Curve" |
| Jupiter `/order`, DFlow only | 6 of 6 both ways | 4 of 4 buys |
| Jupiter `/order`, OKX only | 6 of 6 both ways | 4 of 4 buys |
| Jupiter `/swap/v2/build` (Metis), also with `dexes=Dynamic Bonding Curve` | 0 of 6, "No routes found" | 4 of 4 routed with the DBC-only filter on at least one side |
| Jupiter legacy `/swap/v1/quote` | 0 of 6, `TOKEN_NOT_TRADABLE` | routed or "No routes found", never `TOKEN_NOT_TRADABLE` |
| Titan Portal `/api/v1/quote/swap` | 0 of 6, `NoRoutesFound` from Titan and Titan-DART | 4 of 4 buys via "Meteora DBC" |
| DFlow dev API `/quote` and `/order` | 5 of 6 both ways via "Dynamic Bonding Curve"; "Route not found" for the `AvVQRmi5...` pool | 4 of 4 buys |
| GMGN `get_swap_route` | Cloudflare 403 for every request | Cloudflare 403 |

- Jupiter's docs define `TOKEN_NOT_TRADABLE` as "The specified token mint is not available for trading" ([J-errors]).
- The two biggest live hook mints had about $20,000 of liquidity and $58,000 to $87,000 of 24-hour volume in the Tokens API, so thin liquidity does not explain the refusal ([J-tokens]).
- Jupiter's routing labels map the DBC program to "Dynamic Bonding Curve" ([J-labels]), and its listing rules name the Meteora Dynamic Bonding Curve among the DEXes eligible for instant routing ([KB-jup-listing]).
- Jupiter's DFlow and OKX legs returned the same amount, about 0.1% below DFlow's own quote; an `/order` transaction Jupiter built for a hook buy through OKX carried `feeBps: 10`, consistent with Jupiter's platform fee on `/order` ([Q-order-tx], [KB-jup-order]).
- Jupiter's docs say `/build` is Metis only and that `/order` makes Metis, JupiterZ, DFlow and OKX compete, and that setting `payer` on `/order` restricts routing to Metis ([KB-jup-order]).
- Titan's venue list includes "Meteora DBC" and its providers list returned only Titan and Titan-DART for this Portal key ([T-venues], [T-providers]); Titan also aggregates Metis and OKX quotes as providers, which this key did not return ([KB-titan]).
- DFlow's venue list includes "Dynamic Bonding Curve" ([DF-venues]).
- GMGN's public route endpoint is behind Cloudflare bot protection for scripted requests, so GMGN is judged on chain only.

### E3. Router binaries

- Anchor derives an instruction's 8-byte discriminator from its name only; `swap2_with_transfer_hook` hashes to `b75d992818e6c297`, and only DBC defines an instruction of that name in public code ([GH-search]).
- A program that builds that call itself must hold those 8 bytes, either as data or as the two 4-byte halves of an sBPF `lddw` immediate, so each router's deployed binary was searched for both forms ([BIN]).

| Program | Owner (source of the label) | `swap2_with_transfer_hook` bytes in binary |
| --- | --- | --- |
| `proVF4pMXVaYqmy4NjniPh4pqKNfMmsihgd4wdkCX3u` | OKX DEX router (binary paths `programs/dex-solana-v3/src/adapters/meteora_dbc.rs`, `okx_*` strings) | yes, as data |
| `DF1ow4tspfHX9JwWJsAb9epbkA8hmpSEAtxXy1V27QBH` | DFlow (paths `programs/swap-orchestrator/src/cpi/meteora_dbc.rs`, `dflow_score.rs`) | yes, as `lddw` |
| `FLASHX8DrLbgeR8FcfNV1F5krxYcYMUdBkrP1EPBtxB9` | Axiom's router ([DL-axiom]) | yes, as `lddw` |
| `GMGNreQcJFufBiCTLDBgKhYEfEe9B454UjpDr5CaSLA1` | GMGN (path `programs/gmgn-solana-dex-swap`) | yes, as `lddw` |
| `BSfD6SHZigAfDWSjzD5Q41jw8LmKwtmjskPH9XW1mrRW` | Photon (account name `photon_fee_recipient`) | yes, as `lddw` |
| `JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4` | Jupiter Aggregator v6 ([KB-03]) | no, in neither form; `swap` and `swap2` present 28 and 4 times as `lddw` |
| `T1TANpTeScyeqVzzgNViGDNrkQ6qHz9KrSBS4aNXvGT` | Titan Exchange Router ([T-docs]) | no; `swap` and `swap2` present as `lddw` |
| `b1oomGGqPKGD6errbyfbVMBuzSC8WtAAYo8MwNafWW1` | Bloom's router (path `swap-router/src/v2/dexes/meteora_dbc.rs`, Bloom fee wallet in its swaps) | no, yet it made 11 hook swaps on chain |

- The Bloom case shows a missing discriminator is not proof of no support, since a router can take the instruction data from its client; the binaries count as supporting evidence only, and the "No" for Jupiter and Titan rests on the quotes and the on-chain sample.

### E4. Who routes hook pools on chain

Method: for each of the 120 live hook pools with the most trading fees, the last 40 transactions were fetched (version 0 and version 1 alike) and every DBC `swap2_with_transfer_hook` was attributed to the program that called it by CPI, or "direct" when it was a top-level instruction; terminals were identified by fee wallets whose SOL balance rose in the transaction ([OC-hook-sample], [DL-axiom], [DL-gmgn], [DL-photon], [DL-bullx], [DL-trojan], [SB-bots]).
Result: 3,102 hook swaps on 115 pools, 1,480 SOL of quote volume on SOL-quoted pools, 2026-06-04 to 2026-10-26 (2,971 of them in the last 30 days).

| Caller of the DBC swap | Swaps | Share | SOL volume share |
| --- | --- | --- | --- |
| OKX router | 1,210 | 39.0% | 34.1% |
| Axiom router | 750 | 24.2% | 26.9% |
| DFlow | 664 | 21.4% | 25.0% |
| Direct top-level DBC call | 297 | 9.6% | 11.7% |
| Padre `terminal-proxy` (`term9YPb...`, `stagusfU...`) | 44 | 1.4% | 0.9% |
| Maestro, Bloom and GMGN routers | 34 | 1.1% | 1.1% |
| Other programs (one sends dust swaps on 4 pools, one is a front-running bot) | 103 | 3.3% | 0.3% |
| Jupiter `JUP6` | 0 | 0% | 0% |
| Titan | 0 | 0% | 0% |

| Terminal (fee wallet credited) | Hook swaps | Share |
| --- | --- | --- |
| Axiom | 747 | 24.1% |
| GMGN | 205 | 6.6% |
| Padre | 44 | 1.4% |
| Trojan | 19 | 0.6% |
| Maestro | 14 | 0.5% |
| Bloom | 11 | 0.4% |
| Photon | 9 | 0.3% |
| BullX | 0 | 0% |

- Every busy hook program had routed flow: on the three busiest `hooked` hook programs OKX, DFlow and Axiom carried 1,077 of 1,119 swaps (96%) ([OC-hook-sample]).
- The OKX-routed hook swaps examined in detail are OKX `SwapTob` instructions paying 0.1% to 0.2% commission to different integrator fee accounts, some routing the hook token through SOL to USDC in one transaction ([OC-okx-tx]).
- Example transactions, all successful: OKX `42goYm481gyGDipjhvjwkTAmURLoawpFUPtPifujbjHbsvybuNLn5wgUnZFCQqHzAU77ZxjucQbp171yRW2XJRKp`, DFlow `2MkmZ94CfNZy7YgQFshSG3KWcAEdoMQ5QNwomMmi9VikPVq3vVViQQopLWTKRB281Kh8QN3fNns13iuU8rJxrb4a`, Axiom `2CybKHLCNyEducTzkTzugRLhht2BSQZiRssBadcxVDGuYRJd85evoZzNLopx259JFmADRsiMYseBmjtuZURJXbtu`, GMGN (direct call with GMGN fee) `2rgxC87SKo5mwfBjKcJYprTLHwwdCNfvNDR57Xba9in6ZqrowRj9gMtbiSryihaP4TjUdw8u2rGAFkzBvQEUTruy`, GMGN router `3Axct8ggoE25q9TxvWNPsJEqEnxVgggP2rJAwg7qCrRvpm9YBrWbNDy3rwkFNmXqVq7gnaZfjBhDJ9RLn4Q1j5Kw`, Padre `4Za1ivXtyhTYvcivGx1kKxtEyhAzEJmGjEzF6k3mgi4njrYBsaGqqKgKgY7mjKTQvJSyxwmUbq7ZTkvvAcCkbG93`, Photon `28gqP6aVM17wXiDYCP6zw4NzVMmU62zpUJHJQbUtsgaGVaAf1qBKgTmuwPFoMY7ZizwQLcwoMcikCdVzgiFpjrEt`, Maestro `3MrTZq4Tes9Sw53PpQEJ6kgPwtvmBy92p13CTKKmztk2Zo2mTXSkHTW8aprZY7RCBPy9H6XZYMjv7idH4YAdVTuM`, Trojan `4AfFsqdDzD9fL1fQox9QtLXqK5Qdqhr69uttkVQYvrc2HN8U7B3EgkpsEExetia6cWeWR2q3QsuRzm5v48Uakc1w` ([OC-hook-sample]).
- Axiom sends some of its swaps as version 1 transactions (for example `2CybKHLC...` above), which an RPC call that asks for at most version 0 does not return; a first pass of this sample made that mistake and missed most Axiom swaps, so earlier samples that read only version 0 undercount Axiom ([OC-hook-sample]).
- The earlier sample on ticket #4 (218 transactions on 16 hook pools, no Jupiter) is consistent with this larger one ([Prior-4]).

### E5. Baseline: who routes standard DBC pools

Method: the same attribution on the last 100 transactions of each of the 48 standard DBC pools that traded in a 7-minute window of the DBC program on 2026-10-26, giving 2,411 swaps and 803 SOL of volume from 2026-10-16 to 2026-10-26 ([OC-std-sample]).

| Caller of the DBC swap | Swaps | Share | SOL volume share |
| --- | --- | --- | --- |
| Direct top-level DBC call | 1,076 | 44.6% | 37.1% |
| Axiom router | 499 | 20.7% | 32.8% |
| Jupiter `JUP6` | 399 | 16.5% | 11.7% |
| DFlow | 219 | 9.1% | 10.5% |
| OKX router | 78 | 3.2% | 0.7% |
| GMGN router | 34 | 1.4% | 0.5% |
| Padre `terminal-proxy` | 21 | 0.9% | 2.8% |
| Titan | 17 | 0.7% | 0.1% |
| Others | 68 | 2.8% | 3.9% |

- Per pool, among the 27 pools with at least 10 SOL-quoted swaps, the share of volume through Jupiter and Titan had a median of 5.2%, a lower quartile of 0%, an upper quartile of 10.8% and a maximum of 87.9%; 8 pools had none ([OC-std-sample]).
- Fee wallets credited: Axiom 21.2% of swaps, GMGN 7.1%, Padre 0.9%, Maestro 0.7%, Trojan 0.6%, Photon 0.3%, Bloom 0.2%, BonkBot 0.2%, BullX 0 ([OC-std-sample]).
- Snapshot of all DBC traffic: the 1,576 most recent successful DBC program transactions (2026-10-26 17:28 to 17:31 UTC) held 1,507 standard swaps on 31 pools, 93.4% direct calls, 2.1% Axiom, 1.8% DFlow, 1.7% Jupiter, 0.5% OKX and 0% Titan, with 1.3% of their 219 SOL of volume through Jupiter ([OC-firehose]).
- In the same snapshot 34 swaps (2.2% of DBC swaps) were on 3 hook pools, 28 of them GMGN direct calls, 3 Axiom and 3 DFlow ([OC-firehose]).
- 7 of the 11 busiest standard pools in the window had graduated when checked about 20 minutes later, 6 of them on a 10 to 11 SOL threshold, so the baseline is weighted towards launch-day trading ([OC-std-sample]).

### E6. How much Jupiter flow re-routes

- A transaction Jupiter's `/order` built for a hook buy (never signed) contains the read-only account `jitodontfront1111111111111111JustUseJupiter`, which serves as a marker of Jupiter-built transactions ([Q-order-tx]).
- In 60 recent swaps per channel: 16 of 60 OKX-routed hook swaps and 1 of 60 DFlow-routed hook swaps carried the marker; on standard pools 12 of 60 `JUP6` swaps, 16 of 60 DFlow swaps and 1 of 62 OKX swaps carried it ([OC-jupmark]).
- So at least a fifth of Jupiter's flow on standard curves is `/order` traffic that Jupiter would send through DFlow or OKX for a hook pool, and jup.ag users do reach hook pools that way; the rest of the `JUP6` flow comes from Metis-only integrations (**unverified** split, because the marker may not appear in every Jupiter-built transaction, which would make the re-routed share larger).

### E7. After graduation

- Quotes on four graduated hook mints (`tybY2LFHH91VdoPJJkkFAsYaD7wnQQAm3BYg1x3mint`, `ADvfRzYxQgybAd7z7pkAvL5jeSgqF2pbk5RRAR2zDMJR`, `7Y5NTri15BeTkUGk3B7RhanDWhRBjHU4xjTccdepaAB`, `GrddBpVpdkk9js1Bqcp5GfNMtQiaWvZbf1JZphXEPPko`): Jupiter `/order` chose Metis for all four, Metis-only `/order` and `/build` routed their DAMM v2 pools, DFlow routed all four, OKX quoted all four buys, legacy `/swap/v1/quote` answered `TOKEN_NOT_TRADABLE` for `GrddBpVp...` only, and Titan quoted only `tybY2...` through Manifest and DLMM ([Q-hook]).
- Titan also gave no route for the sell side of a graduated non-hook Token-2022 control trading on DAMM v2 (`F7RkMQQAfen2QwHShyYahKpbVez1H211nE4t4kmLZum7`), and rejected a `dexes` filter on this tier with `NoValidDexes`, so Titan's DAMM v2 gap is not shown to come from the empty hook extension ([Q-ctrl]).
- On chain, the last 100 transactions of the DAMM v2 pools of five graduated hook mints held 316 DAMM v2 swaps from 2026-10-18 to 2026-10-26 (312 on those pools, 4 on pools routed through in the same transactions): Jupiter `JUP6` 48.4%, Axiom 19.3%, direct 12.3%, DFlow 8.5%, OKX 6.6%, Titan 0 ([OC-grad-sample]).
- Jupiter's Tokens API lists a `graduatedPool` for all 519 graduated hook mints; together they did $1.7M of 24-hour volume, $1.5M of it on `tybY2...`, whose organic score was 68.9 ([J-tokens-grad]).

### E8. Wallets

- Phantom's developer docs list Transfer Hooks among the Token-2022 extensions Phantom supports, describing the extension but not how Phantom resolves hook accounts or handles failed hooks ([PH-t22]).
- Phantom's docs say a transaction submitted through Phantom "may be augmented with Lighthouse assertion instructions" ([PH-lighthouse]); the Lighthouse program `L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95` identifies itself in its security.txt ([BIN]).
- 28 hook swaps in the sample carried Lighthouse assertions and all succeeded, 26 of them direct DBC calls of the kind a launchpad web app builds, for example `4cTJx1zw5LruUY2ahHm295mYPKpWAkb9Ej6jUhZyhyacDNEBbLYKLwVZVWJBeZf8JGesWFtJK3SRSRrFGTsLtyR`, so Phantom signs and lands transactions that move hook tokens (inference that these were Phantom-submitted, from [PH-lighthouse] and [OC-hook-sample]).
- Plain wallet-to-wallet transfers of live hook tokens are rare: in the last 100 transactions of each of 10 live hook mints on 7 hook programs there was 1, which succeeded with the hook program running (`R8kj3oxJcmbFEF9XAXMK8a9ZhS9C5qnZKZWt6SXtz6fCZegDNZdu9FR6pVu83SwaavidsiEH9TE9b3mNo5iJa3t`) and carried no wallet marker ([OC-mint-tx]).
- The graduated mint `tybY2...` had 23 plain transfers in its last 100 transactions, all successful and none invoking a hook ([OC-mint-tx]).
- Solana's integration guide says every transfer of a hook mint needs the hook's extra accounts, a client that does not resolve them "can't send the token at all", and clients should simulate first because a hook can reject a transfer for its own reasons ([Sol-hook]).
- No first-party Solflare or Backpack statement on transfer hooks was found; whether they display and send live hook tokens is **unverified**, and a hook whose rules block plain transfers, which some Hooked rules do, would make any wallet's send fail by design ([Bitrue-hooked]).

### E9. Gaps and limits

- OKX's own DEX API, GMGN's route API and BullX were not quoted; OKX was tested through Jupiter's OKX router, GMGN on chain only, and BullX not at all.
- Titan was quoted on its Portal tier, which exposes only the Titan and Titan-DART providers; a higher tier that adds Titan's Metis and OKX providers would likely route hook pools through OKX (**unverified**).
- The volume estimate rests on 48 standard pools over 10 days, weighted towards hot launches, and on a Jupiter marker that may not tag every Jupiter-built transaction.
- Terminal attribution by fee wallet misses terminals whose fee wallets are not in DefiLlama's or Dune's lists, and counts a transaction for a terminal whenever any listed wallet's balance rose.
- Wallet display was not tested in a wallet app, because this research used no browser and signed nothing.

## Sources

Live APIs, read-only, 2026-10-26 between 16:30 and 17:20 UTC:

- [Q-hook]: Jupiter `https://api.jup.ag/swap/v2/order`, `/swap/v2/build` and `/swap/v1/quote`; Titan `https://portal.api.titan.exchange/api/v1/quote/swap`; DFlow `https://dev-quote-api.dflow.net/quote` and `/order`; GMGN `https://gmgn.ai/defi/router/v1/sol/tx/get_swap_route`; for the six live and four graduated hook mints in E2 and E7.
- [Q-ctrl]: the same endpoints for the control mints in E2 and E7.
- [Q-order-tx]: Jupiter `/swap/v2/order` with a funded taker and only the OKX or DFlow router allowed, transaction decoded locally and not signed.
- [J-tokens], [J-tokens-grad]: Jupiter Tokens API v2 `https://api.jup.ag/tokens/v2/search` for the hook mints, the controls and all 519 graduated hook mints.
- [J-labels]: `https://api.jup.ag/swap/v2/program-id-to-label`.
- [T-venues], [T-providers]: `https://portal.api.titan.exchange/api/v1/venues` and `/api/v1/providers`.
- [DF-venues]: `https://dev-quote-api.dflow.net/venues`.
- [Q-scripts]: the probe scripts live outside the repo in the session scratchpad (`hr_quotes.py`, `hr_txsample.py`, `hr_bincheck.py` and others), with every quote and sample saved as JSON.

On-chain reads, Helius and Alchemy mainnet RPC, 2026-10-26, read-only (`getProgramAccounts`, `getMultipleAccounts`, `getAccountInfo`, `getSignaturesForAddress`, `getTransaction` with `maxSupportedTransactionVersion: 1`):

- [OC-census]: every `TransferHookPool` account (discriminator `eddbb8172abda923`), its config and its base mint's TransferHook extension.
- [OC-hook-sample]: last 40 transactions of the 120 live hook pools with the most trading fees.
- [OC-std-sample]: last 100 transactions of 48 standard DBC pools.
- [OC-firehose]: the most recent successful transactions of the DBC program itself.
- [OC-grad-sample]: last 100 transactions of the DAMM v2 pools of five graduated hook mints.
- [OC-mint-tx]: last 100 transactions of 10 live hook mints and 1 graduated one.
- [OC-jupmark]: 60 recent swaps per channel from the hook and standard samples, checked for Jupiter's marker account.
- [OC-okx-tx]: `3aA2ksyWDMZGxsaeYGU14jQJFZ9o7aVpBq8oRND3Yg1mmqbiLAC7PDHPRj5VHVHokLKYxFCp8Jos34b6R55ehvC9` and `5wEPi4K39LBudAhcHuUiskC6RSTRoEPYTd7aTheZGDBMrbuhpKsgFb1M7D3yWNo4vAhAUhbeCLVkxPWruh7yLeMD` (logs `Instruction: SwapTob`, `commission_rate`).
- [BIN]: the deployed program data of each router in E3, searched for the three DBC swap discriminators, the DBC program id, embedded security.txt and source paths.

Docs, fetched 2026-10-26:

- [D-hook]: https://docs.meteora.ag/core-products/dbc/transfer-hook-pools
- [D-t22]: https://docs.meteora.ag/core-products/dbc/token-2022-support
- [D-sdkhook]: https://docs.meteora.ag/developer-guides/dbc/typescript-sdk/transfer-hooks
- [D-changelog]: https://docs.meteora.ag/developer-guides/dbc/changelog (releases 0.2.0 and 0.2.2, "Swap Routers" rows)
- [J-errors]: https://developers.jup.ag/docs/swap/v1/common-errors (Routing Errors table)
- [T-docs]: Titan developer docs, Swap V3 page ("Titan Exchange Router (`T1TANpTeScyeqVzzgNViGDNrkQ6qHz9KrSBS4aNXvGT`)"), mirrored in the owner's knowledge base at `raw/titan-docs/llms-full.txt`
- [PH-t22]: https://docs.phantom.com/developer-powertools/solana-token-extensions-token22
- [PH-lighthouse]: https://docs.phantom.com/developer-powertools/lighthouse
- [Sol-hook]: https://solana.com/docs/tokens/extensions/transfer-hook-integration
- [Th-iface]: https://github.com/solana-program/transfer-hook/blob/main/interface/src/instruction.rs

Owner's knowledge base (`/Volumes/Farhan/Work Folder/Dev/AI/Research-Projects/jupiter-meteora`, read-only):

- [KB-jup-order]: `jupiter/02-developer-platform-and-apis.md`, sections 2.1, 2.2, 2.4 (routing impact matrix) and 2.6.
- [KB-jup-listing]: `jupiter/02-developer-platform-and-apis.md`, section 2.12.
- [KB-jup-trigger]: `jupiter/02-developer-platform-and-apis.md`, Trigger V2 deposit table and the Recurring V1 versus DCA table (Token-2022 row).
- [KB-titan]: `titan-exchange.md`, sections 0, 4 and 11.
- [KB-03]: `meteora/03-dev-dbc-vaults-launch.md`, program table and "Transfer-hook pools".

Labels for terminals and routers:

- [DL-axiom]: https://github.com/DefiLlama/dimension-adapters/blob/master/fees/axiom.ts (`routerProgram: 'FLASHX8DrLbgeR8FcfNV1F5krxYcYMUdBkrP1EPBtxB9'`, fee wallets) and `dexs/axiom.ts`.
- [DL-gmgn]: https://github.com/DefiLlama/dimension-adapters/blob/master/dexs/gmgnai.ts (`SOLANA_FEE_WALLETS`).
- [DL-photon]: https://github.com/DefiLlama/dimension-adapters/blob/master/dexs/photon.ts (`PHOTON_FEE_WALLET`).
- [DL-bullx]: https://github.com/DefiLlama/dimension-adapters/blob/master/dexs/bullx.ts (fee wallets).
- [DL-trojan]: https://github.com/DefiLlama/dimension-adapters/blob/master/dexs/trojan/index.ts (fee wallets).
- [SB-bots]: Dune spellbook, `dbt_subprojects/solana/models/_sector/dex/bot_trades/solana/platforms/` (Padre, Bloom, BonkBot, Maestro, Nova and Banana Gun fee receivers), https://github.com/duneanalytics/spellbook
- [GH-search]: GitHub code search for `swap2_with_transfer_hook`, 2026-10-26 (only MeteoraAg/dynamic-bonding-curve defines it; other hits are parsers and SDKs of DBC).

Other:

- [Prior-4]: `research/dbc-instant-launch.md` on branch `research/dbc-instant-launch` of this repo, section E6.
- [Bitrue-hooked]: https://www.bitrue.com/blog/what-is-hooked-crypto (secondary source on Hooked's rules; Hooked's own docs were not found).
