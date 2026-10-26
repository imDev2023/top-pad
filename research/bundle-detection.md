# Detecting bundlers and multi-wallet buyers, and gating Fair Open on it

Research for ticket #5 on the Top-pad wayfinder map, captured 2026-10-26.
It covers detection methods and their known accuracy, cost, latency and evasions, the data sources that fit, the proof-of-personhood and reputation options on Solana, and how a check's result can feed an Alpha Vault Merkle allowlist with per-wallet caps.
Every factual line cites a source from the list at the end; on-chain figures were read by me from mainnet on 2026-10-26 and say how.
Anything I could not confirm from a primary source is marked **unverified**.

## Answer

### The reframing that drives everything

- In a Fair Open, outsiders cannot buy before activation: only the Alpha Vault can buy during the pool's pre-activation window ([KB 6.1][kb]).
- So the pump.fun attack Bitquery measured, the creator's wallets packed into the launch's Jito bundle in block 0 ([Bitquery][bq]), has no block 0 to land in.
- It turns into a Sybil attack on the vault: one person registers many wallets to collect many per-wallet caps.
- A per-wallet cap is only a per-person cap if wallets map to people, and an extra wallet in a permissionless vault costs about 0.0018 SOL of refundable escrow rent ([IDL][av-idl], computed below).
- The gate therefore has two jobs before deposits open: collapse one person's wallets into one allocation, and find registrants linked to the creator.
- Detection at and after activation (same slot, same Jito bundle) stays useful, but as Bundle Radar labelling and Creator record evidence, not as the gate.
- The gate binds only where Meteora's programs enforce it, through the Alpha Vault's on-chain allowlist and per-escrow caps ([Meteora][av-access]); once the pool activates, aggregators such as Jupiter and Titan reach it directly (as ticket #8's research notes), so a server-side check cannot block a buy after that.

### Recommended detection approach

1. **Personhood first, on-chain clustering second.**
   No on-chain linkage method is reliable alone: each has a cheap, known evasion (table in Evidence 4), and only a personhood check raises the cost of an extra wallet from rent to the price of an extra identity.
2. **Pre-registration pipeline, run after registration closes and before the Merkle root is published:**
   - Collapse pass-through wallets: a wallet with one inbound and one outbound transfer that forwards almost everything within seconds is a hop, not an owner; walk up through hops to the first wallet with real history.
     In the worked example below, each of the six wallets in one documented bundle (the dev's included) was funded through exactly three such hops, and a one-hop "who funded this wallet" check linked none of them.
   - Build the first-funding and sweep graph over the collapsed wallets, with exchanges, bridges and programs removed using an identity database, the method the Arbitrum Foundation published for its airdrop ([Arbitrum][arb]) and that the Helius identity and funded-by endpoints support ([Helius Wallet API][helius-wallet]).
   - Bucket exchange withdrawals by exchange and narrow time window, the idea behind Bubblemaps' Time Nodes ([Bubblemaps][bm-time]), because exchange funding is exactly the gap Bitquery says its own funding test misses ([Bitquery][bq]).
   - Score co-activity: wallets touched by the same script move in the same minute and with identical lamport amounts; three of the example bundle wallets swept exactly 0.005058779 SOL on the same morning.
   - Check every registrant against the creator's wallet and the creator's earlier launches; the example's dev wallet was four hops from a wallet that had created another pump.fun coin three minutes earlier.
   - Treat a first funding from a privacy pool as a flag that requires personhood, not as proof; Helius tags a "Privacy" program category ([Helius Wallet API][helius-wallet]).
3. **Deposit-window monitoring for labels only:** escrow `payer`, fee payer, same slot and Jito bundle membership of deposits ([IDL][av-idl], [Jito][jito-docs]).
   These cannot remove a wallet that is already in a published root (see gate below), so they feed the Fairness card.
4. **Post-activation Bundle Radar:** Bitquery's three tests adapted to the activation slot (inside the launch transaction, fee paid by a linked wallet, the four positions after it), confirmed with Jito's public bundle record, plus tracking tokens passed out of claimant wallets ([Bitquery][bq], [Jito bundle API][jito-api-tx]).
5. **Measure it.**
   Nobody publishes accuracy for Solana linkage heuristics except Bitquery's positional test; build a labelled set from pump.fun launches where Jito's record proves bundle membership, and tune hop depth, time windows and thresholds against it (question 3 below).

### Personhood and reputation options, ranked by strength against one person with many wallets

| Rank | Option | Strength against many wallets | User friction | Cost to Top-pad | Privacy | Solana status today |
| - | - | - | - | - | - | - |
| 1 | World ID Proof of Human (Orb) | Strongest: one credential per human, 3-year validity ([World][world-poh]) | High: an Orb visit, once | Not stated in World's docs (**unverified**) | Good: per-action nullifier, no PII to us ([World verify][world-verify]) | Not verifiable on Solana on-chain; World's docs list Ethereum, Optimism, Base, Polygon and World Chain only ([World contracts][world-contracts]); verify off-chain at registration |
| 2 | Government-ID KYC with liveness (Sumsub, Blockpass, Solid, Streamflow) | Strong: one document and face per person (dedupe behaviour per provider **unverified**) | High: document plus selfie | Sumsub Basic $1.35 per verification, $149 monthly minimum ([Sumsub][sumsub]) | Poor: the provider holds PII; issuers publish SAS attestations that tie a wallet to "KYC passed" in public | Live on SAS but tiny: Sumsub IDV 13, Streamflow KYC 36, blockpass-kyc 14, Solid KYC 5 attestations (on-chain census) |
| 3 | Civic Uniqueness Pass | Strong-ish: video-selfie face map compared with other users, one wallet per person, VPN blocked, 90-day expiry (Civic's page now returns 404; seen only in a search summary, **unverified**) | Medium-high | Not found (**unverified**) | Medium: Civic holds encrypted face maps (**unverified**) | 2,910 Uniqueness pass accounts ever on Civic's Gateway program (on-chain census); 61 Civic attestations on SAS |
| 4 | World ID Proof of Presence (selfie) | Medium: World says it "does not provide a strict one-person-one-account guarantee" ([World][world-pop]) | Low-medium | **Unverified** | Good | Same as rank 1 |
| 5 | Wallet-history scores (Trusta, Nomis on SAS; Human Passport Models) | Weak to medium: defeated by aged, used wallets like the ones in the example | None | Free reads of public attestations; Human Passport pricing **unverified** | Good | Trusta has 11,475 SAS attestations, 81% of all; methods unpublished (**unverified**); Human Passport Models are EVM-only ([Human Passport][hp-models]) |
| 6 | X account link (age, followers) | Weak: accounts can be farmed or bought (**unverified**) | Low | $0.010 per user read ([X pricing][x-pricing]) | Medium: links a public handle to the wallet | Works anywhere via OAuth |
| 7 | Telegram login | Weak: one account per phone number, and numbers are cheap (**unverified**) | Low | No fee in Telegram's docs ([Telegram][tg-login]) | Medium | Works anywhere |
| 8 | CAPTCHA pass | None against a human with many wallets | Low | **Unverified** | Good | 135,277 Civic CAPTCHA pass accounts (on-chain census) |

- The only published accuracy for a wallet-history model is Human Passport's EVM aggregate model: at its recommended 50+ threshold, 96% of verified humans qualify and 3% of verified Sybils get through ([Human Passport][hp-models]).
- Recommendation: tiered caps rather than one bar.
  Ranks 1 to 3 earn the full per-human cap; ranks 4 to 6 earn a small cap; nothing earns no Fair Open slot (the public buys after activation).
  The exact tiers and caps are a product decision (question 1).

### How a result gates the Alpha Vault allowlist

The facts that constrain the design (Evidence 8):

- A Merkle leaf is a wallet plus its `max_cap`, stored in the escrow at creation and enforced on every deposit ([Meteora][av-access]).
- A wallet needs a valid proof to create its escrow, and escrows can only be created between `depositing_point` and `last_join_point` ([Meteora][av-instr]).
- Root configs are versioned, and the program has no instruction to close one ([IDL 0.4.1][av-idl]), so a wallet in any published root can always get in.

The flow:

1. **Register** (a window before `depositing_point`; length is a product decision): the wallet signs a message, completes a personhood tier, optionally links X.
2. **Close registration and run the pipeline** in Evidence 4 and 6; output clusters of wallets that belong to one person, and clusters linked to the creator.
3. **Assign one leaf per person:** one wallet per personhood nullifier or per cluster, with `max_cap` set by the tier; creator-linked clusters get no leaf (or count against the Creator lock).
4. **Publish once:** build `BalanceTree([{account, maxCap}])`, call `createMerkleRootConfig(root, version 0)` and `createMerkleProofMetadata(proof_url)`, and serve proofs at `{proof_url}/{vault}/{owner}` ([SDK][av-tree], [KB dev 03][kb-dev]); Meteora ships a Cloudflare KV proof server for this ([Meteora repo][av-kv]).
5. **Disclose** the counts on the Fairness card before deposits open: registrants, people admitted, wallets merged, wallets excluded as creator-linked.
6. **Deposit window:** Pro Rata mode, so oversubscription is refunded and each escrow's `max_cap` binds ([KB 6.3][kb]); monitor deposits for labels.
7. **Vesting:** set `start_vesting_point` and `end_vesting_point` so a Sybil allocation that slipped through cannot dump at once ([KB 6.2, 6.7][kb]).

- Never publish a root that contains unvetted wallets: it cannot be withdrawn.
- Adding late registrants with a second root version during the deposit window is allowed by the docs' wording ("publish multiple root versions ... when needed", [Meteora][av-access]) but untested: Meteora's SDK test creates its root before deposits open ([SDK test][av-test]), and the program is closed source ([KB 6.1][kb]); **unverified**.
- The authority-managed mode avoids the root entirely (the vault authority signs each escrow with a `max_cap`), at the price of a server-held signing key and per-escrow rent, and Meteora calls it less scalable for large lists ([Meteora][av-access]).

### What could not be verified

- How pump.fun computes its Bundler and Sniper tags: none of the 26 page titles under `pump.fun/docs` is about them, and its terminal page does not mention them ([pump.fun docs][pumpdocs]).
- How Trench and GMGN compute bundle percentages: no primary documentation found.
- Accuracy of any vendor's bundler tag (Mobula, Webacy, Solana Tracker, Bubblemaps, RugCheck): none publish one.
- Civic Pass's current product terms and price: its docs pages now return 404.
- World ID's developer pricing, and the status of the 2024 Wormhole bridge of World ID to Solana ([Wormhole][wormhole-world]).
- Rate limits of Jito's public explorer API, and whether Alpha Vault accepts a new root version after `depositing_point`.

## Evidence

### 1. What Fair Open changes about the attack

- Alpha Vault buys during the pool's pre-activation window; the pool stores the vault as its pre-activation buyer, and fills are cranked between `pre_activation_start_point` and `last_buying_point` ([KB 6.1, 6.5][kb]).
- Fills call the pool swap with `minimum_amount_out = 0` ([KB 6.5][kb]).
- Each escrow is a PDA of vault and owner, one per wallet per vault ([Meteora][av-access]).
- In a permissionless Pro Rata vault the individual cap is `u64::MAX`, so there is no per-wallet limit at all; per-wallet caps apply in permissionless FCFS and in permissioned vaults ([KB 6.3][kb]).
- Permissionless vaults may charge an escrow fee of at most 0.01 SOL; permissioned vaults must charge none ([Meteora][av-access]).
- The Escrow account is 136 bytes (128 data plus an 8-byte discriminator), so rent exemption is 1,837,440 lamports, about 0.0018 SOL, computed from the IDL's `Escrow` type with Solana's standard rent formula ([IDL][av-idl]); `close_escrow` pays it to a `rent_receiver` ([Meteora][av-instr]).
- So without personhood, a bundler's marginal cost per extra allocation is about 0.0018 SOL of refundable rent plus fees, and up to 0.01 SOL more in a permissionless vault.

### 2. Bitquery's 8.2M-launch study: method and accuracy

Source: [Bitquery, "Pump.fun devs' bundles made $579M+, snipers just $31.5M"][bq], figures verified by Bitquery on 2026-10-10.

- Scope: 8,212,568 pump.fun launches from 30 October 2025 to 7 October 2026, out of 9.1 million whose first trade was on pump.fun.
- Data: Bitquery's records of Solana DEX trades, plus Solana transfers for the funding test; also sold as files on the Bitquery Data Store.
- A coin counts as new when pump.fun was its first venue and its first purchase was at a fresh curve's opening price; the dev is the wallet that paid for that first purchase, and block 0 is the block it landed in.
- Where creation records existed (November 2025 to early July 2026), the first purchaser was the creator 98% of the time.
- Trades read: the launch day and the next two days.
- Excluded: in-transaction buy-and-sell pairs (volume bots), pump.fun's Mayhem agent, 13 days with 5% or more of blocks missing, 7 to 26 May 2026, and launches after 15:45 UTC on 7 October.
- **Dev-wallet tests**, any one of which marks a block-0 buyer as the dev's own:
  1. it bought inside the dev's launch transaction;
  2. the dev paid its transaction fee;
  3. its purchase was one of the four transactions straight after the launch, because a Jito bundle holds at most five.
- **Validation of test 3:** of 325 random early purchases checked against the public Jito record, 185 of the 186 in positions 1 to 4 sat in the launch's own bundle, and none of the 139 further down did.
- Test 3 also held on a day when most launches did not use Jito: on 15 April, 14% of buyers in the four positions had a SOL link to the dev in the prior day, against 12% on 15 June when most did.
- **Funding test, dropped:** SOL passing between buyer and dev in the day before, or both funded by the same small wallet, would have added only 0.4% to bundled launches in the first three months.
- **Sniper rule:** any other early buyer that bought in the first three blocks of launches by at least 10 different devs; 25,882 such wallets to the end of June.
- **Results:** someone other than the dev bought in block 0 of 38% of coins; the dev's wallets were in block 0 of 21%, snipers of 28%, both of 12%; bundles took a median 10% of supply; devs and bundles made at least $579M after fees against $31.5M for snipers (launches to end of June); the dev's first sale came within a minute on 65%.
- Wallets that paid for the first purchase of 100 or more coins account for 49% of launches; the busiest did 103,639.
- **Evasions Bitquery names:** dev wallets that buy later or in another block are counted as snipers or unlinked; a launch service sending bundles for customers looks identical; a dev who funds bundle wallets from an exchange is missed by the SOL-link test; a sniper using a fresh wallet per coin is counted as unlinked.
- **A new pattern from July 2026:** single purchases of 1,000 SOL or more in the trading pool within about a second of launch, with the tokens passed to other wallets that sold them; on sample days those fed wallets took out 35% to 83% as much SOL as the bundles made, so Bitquery's totals are a floor.

### 3. Worked example: tracing Bitquery's 15 June bundle

Bitquery's evidence table names one bundle: coin `7oE8o8...axpump`, dev `3KMsBz...gmj7dE`, four bundled wallets and a fifth pool buyer ([Bitquery][bq]).
I read the chain on 2026-10-26 with the Helius MCP's oldest-first history and Jito's public API.

- Jito's explorer API returned bundle `e9306214...010c9e` for the launch transaction: slot 426,647,767, block index 873, five transactions in Bitquery's order, tipper `Hz8VCw...oWrj8D` (the fifth wallet), 110,000 lamports tip ([Jito tx lookup][jito-api-tx], [Jito bundle record][jito-api-bundle]).
- Helius's `funded-by` endpoint returned 403 (restricted on the current plan) on the owner's key, and its docs say Free-plan keys get 403 ([Helius funded-by][helius-fundedby]), so I read each wallet's first inbound SOL transfer from its oldest transactions instead.

| Wallet | First funded (UTC) | Amount received | One-hop funder | Pass-through wallets between root and target | Root that sent a round amount |
| - | - | - | - | - | - |
| Dev `3KMsBz` | 2026-06-13 12:08:04 | 3.259984947 SOL | `2CaKcD` | 3 single-use hops, 1 s apart | `7BTEAs` sent 3.26 SOL |
| Bundle 1 `9sGVxN` | 2026-04-16 13:49:05 | 5.73997448 SOL | `BKJiJd` | 3 single-use hops | `GoJq1i` sent 5.74 SOL |
| Bundle 2 `D1Xtme` | 2026-04-16 13:59:55 | 4.909984488 SOL | `5a7QEi` | 3 single-use hops | `5fyCnz` sent 4.91 SOL |
| Bundle 3 `DueXop` | 2026-04-24 01:43:40 | 1.999984488 SOL | `4Dk7xo` | 3 single-use hops | `J73hkj` sent 2 SOL |
| Bundle 4 `HVyrZc` | 2026-04-24 01:38:42 | 2.019984488 SOL | `5gW8cU` | 3 single-use hops | `J73hkj` sent 2.02 SOL |
| Pool buyer `Hz8VCw` | 2026-04-20 08:50:02 | 5.469984488 SOL | `GooVZG` | 3 single-use hops | `CL6FSa` sent 5.47 SOL |

What the trace shows:

- A one-hop funding check (what `funded-by` returns) gives six different, unlabelled funders and links nothing, consistent with Bitquery's 0.4% figure.
- Every intermediate wallet starts with one transfer in and one transfer out, one to four seconds apart; the six I read further had no other successful transactions.
- Each chain loses only 0.000015 to 0.000026 SOL on the way, the size of network fees, so the bundle wallet receives a near-round amount.
- Collapsing those hops links bundle wallets 3 and 4 to one private root, `J73hkj...`, which sent them 2 and 2.02 SOL five minutes apart; that root was itself funded with 4.009984488 SOL, the same fee residue.
- The bundle wallets were funded seven to eight weeks before the launch, so a "fresh wallet" rule would pass them; bundle 2 made a PumpSwap trade eleven seconds after it was funded in April.
- The dev wallet was created two days before launch, and its root `7BTEAs...` created a pump.fun coin at 12:05:12 on 13 June and traded it, three minutes before funding the new dev wallet: a creator-record link visible only after collapsing hops.
- Co-activity links bundle wallets 1, 3 and 4 directly: each made a transaction at 03:52 to 03:54 UTC on 24 June (wallets 1 and 4 in the same second), and each sent exactly 0.005058779 SOL to a different address between 10:46 and 11:51 UTC on 6 July.
- RugCheck's report for the coin shows `graphInsidersDetected: 0` and empty insider networks, with the pool holding 99.3% and 118 holders: a holder-snapshot tool sees nothing once a bundle has sold out ([RugCheck report][rugcheck-report]).

One example is an illustration, not a measurement; question 3 asks for the measurement.

### 4. Detection methods: accuracy, cost, latency and evasion

| Method | Where it applies at Top-pad | Known accuracy | Cost and latency | Evasions that defeat it |
| - | - | - | - | - |
| Inside the creator's launch transaction | Activation slot only | Definitional ([Bitquery][bq]) | One `getBlock` per slot | Fair Open removes it pre-activation; buy in a later slot |
| Shared fee payer | Escrow creation, deposits, activation buys | Part of Bitquery's dev test, no separate figure ([Bitquery][bq]) | Free from the transaction itself | Each wallet pays its own fee; Alpha Vault's escrow `payer` can differ from `owner` ([IDL][av-idl]) |
| Same Jito bundle as the launch, or positions 1 to 4 after it | Activation slot, deposits | 185 of 186 in positions 1 to 4 were in the launch bundle; 0 of 139 further down ([Bitquery][bq]) | One HTTP call per transaction to Jito's explorer API, no key ([Jito tx lookup][jito-api-tx]); limits **unverified** | Separate slot; non-Jito landing paths, which most 15 April launches used ([Bitquery][bq]); a bundle holds at most 5 transactions ([Jito][jito-docs]) |
| One-hop funder (first inbound SOL) | Pre-registration | Adds 0.4% to bundled launches ([Bitquery][bq]) | Helius `funded-by`, 100 credits per wallet, paid plans only ([Helius][helius-fundedby]); Birdeye `/wallet/v2/funded-by`, Lite API tier or higher ([Birdeye][birdeye-fundedby]); Jupiter's undocumented holders endpoint, free, current holders only ([Jupiter datapi][jup-holders]) | Hop chains (Evidence 3); exchange withdrawals |
| Hop-collapsed funding and sweep graph | Pre-registration | None published; Arbitrum published the method, not a rate ([Arbitrum][arb]) | About one oldest-first history call per hop: `getTransactionsForAddress` at 10 credits per 100 transactions, Developer plan and up ([Helius billing][helius-billing]); seconds per wallet | Exchange withdrawals, privacy pools, wallets bought with history |
| Exchange time-window clustering | Pre-registration | None published | Needs exchange labels: Helius identity, 32,500+ tagged accounts ([Helius Wallet API][helius-wallet]) | Withdrawals spread across days, exchanges or accounts; false positives from ordinary users in busy windows (**unverified** rate) |
| Amount and timing fingerprints (co-activity) | Pre-registration, post-open | None published | Same data as the funding graph | Randomised amounts and delays |
| Wallet age and history | Pre-registration | Human Passport EVM model at 50+: 96% of humans pass, 3% of Sybils ([Human Passport][hp-models]); nothing comparable for Solana | Free from history | Pre-aged and used wallets (Evidence 3); bought wallets (**unverified** market) |
| Token transfer-out after claim | Post-open | None published | Webhooks at 1 credit per event ([Helius billing][helius-billing]) | Selling through many hops; Bitquery's July pattern ([Bitquery][bq]) |

On mixers:

- Privacy Cash pools SOL and SPL tokens as commitments in an on-chain Merkle tree and lets a holder withdraw to a different address with a zero-knowledge proof, breaking the deposit-to-withdrawal link ([Privacy Cash docs][privacycash-docs], generated from [its repo][privacycash]).
- Umbra opened a privacy wallet on Solana in March 2026, per The Block (secondary, not checked against Umbra's own docs).
- A withdrawal from such a pool is itself visible as the first funding, which is why the pipeline flags it and asks for personhood rather than treating it as proof.

### 5. Existing public tools and how they work

- **pump.fun:** shows creator, sniper, bundler and top-10 percentages on each coin and tags wallets Bundler or Sniper ([digest][digest]); no docs page covers how ([pump.fun docs][pumpdocs]); method **unverified**.
- **Mobula:** a sniper is a buyer within 0 to 3 blocks, tagged when it matches several of block proximity, position, fresh wallet, funded just before launch and priority fees or MEV bundles; a bundler cluster is 3 or more wallets sharing a transaction, a common funder, the same block, similar amounts or later consolidation ([Mobula][mobula]).
- **Webacy:** flags `bundled_token` (high) and `has_been_sniped` (medium); calls more than 20% bundler holdings high risk, more than 50% bought in block 0 critical, and fewer than 10 unique block-0 wallets suspicious; Solana coverage is tokens launched in the last 12 months ([Webacy][webacy]).
- **Solana Tracker:** first-buyer and bundler endpoints, with the caveat that labels "do not establish a trader's intent" ([Solana Tracker][soltracker]).
- **Bubblemaps:** links top holders through transfers of indexed tokens; Magic Nodes add non-holder intermediaries that connect holders, such as a shared gas funder or a shared deposit address ([Bubblemaps][bm-magic]); Time Nodes split an exchange into time windows and link wallets that used it in the same window, with a BULLISH example of more than 150 wallets funded from Binance in tight windows that bought within 30 minutes of launch ([Bubblemaps][bm-time]).
  Exchanges, DEXs, contracts and addresses with more than 200k transfers are hidden and ignored in clustering, and links between two high-volume "supernodes" are dropped ([Bubblemaps map][bm-map]).
- **RugCheck:** a public API with `insiders/graph` and `insiders/networks` endpoints per mint ([RugCheck API][rugcheck-api]); on the 15 June coin both returned empty arrays (Evidence 3).
- **Trench and GMGN:** no primary documentation of their bundle checks found; **unverified**.
- What all of them share: they run on a token's buyers and holders after launch, so they suit Bundle Radar, not a pre-registration gate; Bubblemaps' subgraph endpoint is the exception, since it takes any list of up to 1,000 addresses ([Bubblemaps subgraph][bm-subgraph]).

### 6. Data sources and what they cost

| Source | What it gives the gate | Price and limits | Latency |
| - | - | - | - |
| Helius RPC and Wallet API | Oldest-first history with full transactions (`getTransactionsForAddress`, up to 1,000 per call, `sortOrder: asc`) ([Helius][helius-gtfa]); first funder; identity labels incl. exchanges and a Privacy category, batch of 100 ([Helius Wallet API][helius-wallet]) | Free $0 (1M credits), Developer $49 (10M), Business $499 (100M), Professional $999 (200M); Wallet API 100 credits per request; `getTransactionsForAddress` 10 credits per 100 transactions; standard RPC 1 credit; Developer RPC 50 req/s ([Helius billing][helius-billing]) | Request-response |
| Helius webhooks | Push on escrow creation, deposit, claim and transfer events | 1 credit per event; 50 webhooks of 100k addresses on paid plans ([Helius billing][helius-billing]) | **Unverified** |
| Helius LaserStream (Yellowstone-compatible gRPC) | Live slot, block and transaction stream for the activation slot and Bundle Radar; 48-hour replay | Mainnet needs Business or Professional ([LaserStream][helius-laser]); 2 credits per 0.1 MB ([Helius billing][helius-billing]) | Processed-commitment stream |
| Our own indexer | Same as above without vendor limits | Agave RPC node: 16 cores, 512 GB RAM for all account indexes, separate NVMe disks ([Anza][anza-req]); Yellowstone gRPC plugin is AGPL-3.0 ([Yellowstone][yellowstone]); hosting price **unverified** | Lowest |
| Bitquery | DEX trades and transfers, the study's own data; MCP; Data Store files for backtests | Personal $29, Pro $69, Scale $199 a month billed annually; real-time window only (30 days of trades, 8 hours to 4 days on-chain); archive sold per chain, Solana in its own packs ([Bitquery pricing][bq-price]) | Real-time streams |
| Jito explorer API | Bundle membership, slot, tipper and order for any landed transaction | No key; undocumented, observed working ([Jito tx lookup][jito-api-tx]) | Seconds after landing (**unverified**) |
| Bubblemaps Data API | Clusters for a token's top holders; transfers among any address list | Map 25 credits, subgraph 10 plus 1 per address; credits come with a Pro subscription whose price is not in the docs ([Bubblemaps][bm-auth]) | Cached hits in milliseconds, most within 15 s, outliers up to a minute ([Bubblemaps map][bm-map]) |
| Jupiter datapi (undocumented) | `/v1/holders/{mint}`: each current holder's `fundingAddress`, `fundingAmount`, `fundingTx`, `fundingSlot` and tags ([holders][jup-holders]); `/v1/txs/{mint}`: trades newest first with an `isMev` flag and a `next` cursor ([txs][jup-txs]) | No key; both answered on 2026-10-26; limits and the meaning of `isMev` **unverified** | Request-response |
| Birdeye | `GET /wallet/v2/funded-by`: earliest SOL funders and the funding transaction, parsing `transfer`, `createAccount`, `createAccountWithSeed` and other patterns ([Birdeye][birdeye-fundedby]) | Lite API tier or higher; price **unverified** (no key here) | Request-response |

- My estimate for the pre-registration pipeline on Helius: about five history calls per registrant (10 credits each) plus shared batch-identity lookups, roughly 60 credits per registrant, so 10,000 registrants use about 600k of the Developer plan's 10M monthly credits.
- Bitquery's real-time window cannot see the example's April funding for a June launch without the archive pack, so it fits backtesting and research better than the live gate.
- All the one-hop funding endpoints (Helius, Birdeye, Jupiter) return the same thing the worked example shows is easy to defeat; they are inputs to the hop-collapsing trace, not a check on their own.
- On devnet, the funding graph for the prototype has to come from Helius or our own indexer: LaserStream devnet is on every Helius plan ([LaserStream][helius-laser]), and ticket #8 reports that Meteora has no devnet data index (not checked here).

### 7. Proof of personhood and reputation on Solana

#### Solana Attestation Service (SAS)

- An issuer registers a Credential with authorised signers, publishes Schemas under it, and signers write Attestation accounts bound to a nonce and an optional expiry; closing an attestation revokes it ([SAS repo][sas-repo]).
- Program ID `22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG`; a tokenised schema mints a soulbound Token-2022 token per attestation, but holding the token proves nothing on its own: a verifier must fetch the Attestation account and check its credential, schema and expiry ([SAS repo][sas-repo]).
- Credential names are self-declared, so a verifier must pin credential addresses: mainnet has two credentials named `civic`, one with 61 attestations and one with none (census below).

Census, read on 2026-10-26 with `getProgramAccounts` filtered on the account discriminator and the credential field at byte 33, layouts per the SAS source ([SAS repo][sas-repo]):

| Issuer credential (self-declared name) | Address | Attestations | Schemas |
| - | - | - | - |
| `trustalabs_credential` | `3ZVqEC...doyGQW` | 11,475 | proof of humanity (v1, v2, Lite), media score |
| `alien_session` | `EpnHCR...Ap5C` | 1,837 | `session_address` only |
| `MAIKERS-ID` | `rfdkP1...wavA` | 143 | agentic identity with socials |
| `civic` | `Fz2oPU...7sP` | 61 | Uniqueness, Liveness, CAPTCHA, ID Verification, Test Pass |
| `Nomis Score Attestation` | `4VeLT9...qFxJ` | 60 | `score` |
| `Streamflow KYC` (two credentials) | `8xY78X...16yK`, `CYQRkn...FZnyG` | 23 and 13 | holder profile |
| `uzproof` | `2chgBf...UQyyF` | 29 | proof of use with `genuineScore` |
| `blockpass-kyc` | `7FWd5c...Xxwqz` | 14 | KYC approval |
| `Sumsub IDV` | `EfCP1P...dXSG1` | 13 | identity verification level |
| Solid (`Solid Credential` x3, `Solid`) | four credentials | 5 KYC, 1 shop | SolidKYC with hashed or zk fields |
| All 95 credentials | | 14,129 | |

- So SAS is real infrastructure with almost no KYC or uniqueness volume yet: outside Trusta's on-chain scores, no personhood issuer has more than 61 attestations.

#### Civic Pass

- Civic's SAS schema names are the first 32 characters of its Gateway network keys, and their descriptions label them: Uniqueness `uniqobk8...whQiv`, Liveness `vaa1QRNE...DSwM`, CAPTCHA `ignREus...ZV6` (census above).
- Gateway token accounts on `gatem74V238djXdzWnJf94Wo1DcnuGkfijbf3AuBhfs` hold the network at byte 35 ([Civic gateway client][civic-gw]); a `getProgramAccounts` tally of all 174,806 accounts of the 109-byte token size on 2026-10-26 found 135,277 CAPTCHA, 13,309 Test Pass, 2,910 Uniqueness, 1,681 Liveness.
- These counts include expired passes whose accounts still exist; the active share is **unverified**.
- How Uniqueness works (video-selfie face map compared with existing users, one wallet per person, VPN blocked, 90-day refresh, private networks via a Custom Pass) comes from a search-engine summary of Civic's Pass docs, which now return 404 ([Civic, archived URL][civic-docs]); **unverified**.

#### World ID

- Proof of Human: Orb iris capture, "each human can only have one PoH credential", 3-year validity ([World][world-poh]).
- Proof of Presence: phone selfie, 90-day validity, "does not provide a strict one-person-one-account guarantee" ([World][world-pop]).
- On-chain verification: the World ID 3.0 docs list Ethereum, Optimism, Base, Polygon and World Chain, and only Orb credentials verify on-chain ([World contracts][world-contracts]).
- Backend verification takes an action, a nullifier and a signal hash ([World verify][world-verify]); to enforce one account per person, World's session docs say to use one enrollment action for all users and keep the nullifier ([World session proofs][world-session]).
- For Top-pad that means verifying at registration on our server, binding the nullifier to one Solana wallet with the signal, and never needing Solana on-chain support.
- Wormhole announced a World ID state bridge to Solana in September 2024 ([Wormhole][wormhole-world]); World's current docs do not list Solana, so its status is **unverified**.

#### Human Passport (formerly Gitcoin Passport)

- Stamps add up to a Unique Humanity Score where 20 or more indicates a likely human ([Human Passport support][hp-support]).
- Products include a free Passport Embed widget, Human ID zero-knowledge verifications and a Models API scoring on-chain behaviour ([Human Passport][hp-llms]).
- The Models API covers Ethereum, Arbitrum, Base, Optimism, Polygon and zkSync; no Solana model ([Human Passport][hp-models]); a Solana user would have to link an EVM wallet.

#### Social links

- X: user reads cost $0.010 each under pay-per-use pricing ([X pricing][x-pricing]); account age and follower count arrive in the same user object (field detail **unverified**).
- Telegram: the Login Widget returns id, names, username, photo, auth date and a hash that the server checks with an HMAC keyed by the bot token ([Telegram][tg-login]).
- uselaunch.fun already enforces one coin per X account for creators ([digest][digest]).

### 8. Alpha Vault mechanics that constrain the gate

- Access is controlled at escrow creation; a user must have an escrow before depositing ([Meteora][av-access]).
- Merkle mode: the vault authority or a program admin creates a versioned `MerkleRootConfig`; the leaf is owner plus `max_cap`; the escrow stores `max_cap`; caps are enforced on deposit ([Meteora][av-access]).
- Leaf hash in the SDK: `sha256(0x00 || sha256(owner || max_cap as little-endian u64))` ([SDK BalanceTree][av-tree]).
- `create_permissioned_escrow` takes `max_cap` and `proof` and has a `payer` account separate from `owner` ([IDL][av-idl]).
- The IDL (v0.4.1) has `create_merkle_root_config` and `create_merkle_proof_metadata`, a close instruction for proof metadata, and none for root configs ([IDL][av-idl]).
- Escrow creation and deposits need the current point between `depositing_point` and `last_join_point` ([Meteora][av-instr]).
- `MerkleProofMetadata` stores a `proof_url`; the SDK fetches `{proof_url}/{vault}/{owner}` and falls back to Meteora's own proof API ([KB dev 03][kb-dev]).
- Authority mode: the vault authority signs each escrow and passes a positive `max_cap`; Meteora calls it simple for small lists and less scalable for large public allowlists ([Meteora][av-access]).
- Meteora's SDK test for a Merkle Pro Rata vault builds the tree and root while the vault is `PREPARING`, before `DEPOSITING` ([SDK test][av-test]).
- The Alpha Vault program itself is not open source ([KB 6.1][kb]).

## Sharp questions for the map

1. Which personhood tiers does a Fair Open accept, what `max_cap` does each tier get, and does any no-personhood tier exist?
2. On devnet, can a second `MerkleRootConfig` version be created after `depositing_point`, and is an escrow's `max_cap` fixed once created?
3. Build a labelled set from pump.fun launches, using Jito bundle membership with the creation transaction as ground truth, and measure precision and recall of the pre-registration linkage pipeline (hop collapse, exchange windows, co-activity).
4. Should the pre-activation buyer be Alpha Vault, or a small program of ours that could merge clusters, revoke a slot or enforce per-person caps on-chain?
5. What appeal path does a wrongly merged or excluded registrant get before the root is published?
6. Should the Creator record carry a stable per-human identifier (one World ID action for all of Top-pad) so a banned bundler cannot return with a new wallet?

## Sources

[kb]: https://github.com/imDev2023/jupiter-meteora-resources/blob/main/meteora/01-products-and-protocol.md "Jupiter + Meteora knowledge base, meteora/01-products-and-protocol.md section 6 (Alpha Vault)"
[kb-dev]: https://github.com/imDev2023/jupiter-meteora-resources/blob/main/meteora/03-dev-dbc-vaults-launch.md "Jupiter + Meteora knowledge base, meteora/03-dev-dbc-vaults-launch.md (Alpha Vault developer reference)"
[digest]: https://github.com/imDev2023/top-pad/blob/research/reference-launchpads/research/reference-launchpads.md "Top-pad reference launchpads digest"
[bq]: https://bitquery.io/investigations/pump-fun-snipers-bundles
[bq-price]: https://bitquery.io/pricing
[jito-docs]: https://docs.jito.wtf/lowlatencytxnsend/
[jito-api-tx]: https://bundles.jito.wtf/api/v1/bundles/transaction/4efCSXYbAZ9iWrKKfJcEvqzxdhpgAYjbW8VDi6wnmSSjvVGzLKA9uYLxJW7vot77F2p5NJN41qqSMzqwQou8FfMA
[jito-api-bundle]: https://bundles.jito.wtf/api/v1/bundles/bundle/e930621492939d37765e0ad6342cac931c779d7dd7d3942e3c3589d2bd010c9e
[helius-wallet]: https://www.helius.dev/docs/api-reference/wallet-api
[helius-fundedby]: https://www.helius.dev/docs/wallet-api/funded-by
[helius-billing]: https://www.helius.dev/docs/billing
[helius-laser]: https://www.helius.dev/docs/laserstream
[helius-gtfa]: https://www.helius.dev/docs/rpc/gettransactionsforaddress
[yellowstone]: https://github.com/rpcpool/yellowstone-grpc
[anza-req]: https://docs.anza.xyz/operations/requirements
[bm-map]: https://docs.bubblemaps.io/data/api/tokens/map
[bm-subgraph]: https://docs.bubblemaps.io/data/api/relationships/subgraph
[bm-auth]: https://docs.bubblemaps.io/data/api/authentication
[bm-magic]: https://wiki.bubblemaps.io/bubblemaps-v2/magic-nodes
[bm-time]: https://wiki.bubblemaps.io/bubblemaps-v2/time-nodes
[rugcheck-api]: https://api.rugcheck.xyz/swagger/doc.json
[rugcheck-report]: https://api.rugcheck.xyz/v1/tokens/7oE8o8kS6iyn5GyGhaBoi2HNz9M9m6n7VEdUWaxpump/report
[mobula]: https://docs.mobula.io/almanac/detecting-snipers-bundlers
[webacy]: https://docs.webacy.com/glossary/snipers-bundlers
[soltracker]: https://docs.solanatracker.io/guides/sniper-detection
[pumpdocs]: https://pump.fun/docs
[arb]: https://github.com/ArbitrumFoundation/sybil-detection
[sas-repo]: https://github.com/solana-foundation/solana-attestation-service
[civic-gw]: https://github.com/identity-com/on-chain-identity-gateway/blob/develop/solana/gateway-ts/src/lib/util.ts
[civic-docs]: https://docs.civic.com/pass/introduction/overview-of-civic-pass
[world-poh]: https://docs.world.org/world-id/credentials/1
[world-pop]: https://docs.world.org/world-id/credentials/11
[world-contracts]: https://docs.world.org/world-id/reference/contracts
[world-verify]: https://docs.world.org/api-reference/developer-portal/verify
[world-session]: https://docs.world.org/world-id/idkit/session-proofs
[wormhole-world]: https://wormhole.com/blog/expanding-worldcoins-world-id-to-solana-with-wormhole
[hp-models]: https://docs.passport.human.tech/building-with-passport/models/available-models
[hp-llms]: https://passport.human.tech/llms.txt
[hp-support]: https://support.passport.human.tech/llms.txt
[x-pricing]: https://docs.x.com/x-api/getting-started/pricing
[tg-login]: https://core.telegram.org/widgets/login-legacy
[sumsub]: https://sumsub.com/pricing/
[privacycash]: https://github.com/Privacy-Cash/privacy-cash
[privacycash-docs]: https://mintlify.wiki/Privacy-Cash/privacy-cash/concepts/how-it-works
[av-access]: https://docs.meteora.ag/helper-products/alpha-vault/whitelist-and-access
[av-instr]: https://docs.meteora.ag/developer-guides/alpha-vault/program/instructions
[av-idl]: https://github.com/MeteoraAg/alpha-vault-sdk/blob/main/idls/alpha_vault.json
[av-tree]: https://github.com/MeteoraAg/alpha-vault-sdk/blob/main/ts-client/src/alpha-vault/merkle_tree/balance-tree.ts
[av-test]: https://github.com/MeteoraAg/alpha-vault-sdk/blob/main/ts-client/src/test/dlmm_merkle_prorata_slot.test.ts
[av-kv]: https://github.com/MeteoraAg/cloudflare-kv-merkle-proof
[jup-holders]: https://datapi.jup.ag/v1/holders/7oE8o8kS6iyn5GyGhaBoi2HNz9M9m6n7VEdUWaxpump
[jup-txs]: https://datapi.jup.ag/v1/txs/7oE8o8kS6iyn5GyGhaBoi2HNz9M9m6n7VEdUWaxpump
[birdeye-fundedby]: https://data.birdeye.so/docs/changelog/20260821-release-wallet-funded-by-api

Readable list of the same sources:

- Bitquery study and pricing: https://bitquery.io/investigations/pump-fun-snipers-bundles, https://bitquery.io/pricing
- Jito docs and public bundle API: https://docs.jito.wtf/lowlatencytxnsend/, https://bundles.jito.wtf/api/v1/bundles/transaction/{signature}, https://bundles.jito.wtf/api/v1/bundles/bundle/{bundle_id}
- Helius: https://www.helius.dev/docs/api-reference/wallet-api, https://www.helius.dev/docs/wallet-api/funded-by, https://www.helius.dev/docs/billing, https://www.helius.dev/docs/laserstream, https://www.helius.dev/docs/rpc/gettransactionsforaddress
- Own indexer: https://github.com/rpcpool/yellowstone-grpc, https://docs.anza.xyz/operations/requirements
- Bubblemaps: https://docs.bubblemaps.io/data/api/tokens/map, https://docs.bubblemaps.io/data/api/relationships/subgraph, https://docs.bubblemaps.io/data/api/authentication, https://wiki.bubblemaps.io/bubblemaps-v2/magic-nodes, https://wiki.bubblemaps.io/bubblemaps-v2/time-nodes
- RugCheck: https://api.rugcheck.xyz/swagger/doc.json
- Jupiter datapi (undocumented): https://datapi.jup.ag/v1/holders/{mint}, https://datapi.jup.ag/v1/txs/{mint}
- Birdeye: https://data.birdeye.so/docs/changelog/20260821-release-wallet-funded-by-api, https://data.birdeye.so/docs/data-api/wallet-networth-pnl/get-wallet-v2-funded-by
- Vendor tag methods: https://docs.mobula.io/almanac/detecting-snipers-bundlers, https://docs.webacy.com/glossary/snipers-bundlers, https://docs.solanatracker.io/guides/sniper-detection, https://pump.fun/docs
- Sybil method: https://github.com/ArbitrumFoundation/sybil-detection
- SAS: https://github.com/solana-foundation/solana-attestation-service, https://solana.com/docs/tools/attestations
- Civic: https://github.com/identity-com/on-chain-identity-gateway, https://docs.civic.com/pass/introduction/overview-of-civic-pass (404 on 2026-10-26)
- World ID: https://docs.world.org/world-id/credentials/1, https://docs.world.org/world-id/credentials/11, https://docs.world.org/world-id/reference/contracts, https://docs.world.org/api-reference/developer-portal/verify, https://docs.world.org/world-id/idkit/session-proofs, https://wormhole.com/blog/expanding-worldcoins-world-id-to-solana-with-wormhole
- Human Passport: https://docs.passport.human.tech/building-with-passport/models/available-models, https://passport.human.tech/llms.txt, https://support.passport.human.tech/llms.txt
- Social and KYC: https://docs.x.com/x-api/getting-started/pricing, https://core.telegram.org/widgets/login-legacy, https://sumsub.com/pricing/
- Privacy pools: https://github.com/Privacy-Cash/privacy-cash, https://mintlify.wiki/Privacy-Cash/privacy-cash/concepts/how-it-works
- Alpha Vault: https://docs.meteora.ag/helper-products/alpha-vault/whitelist-and-access, https://docs.meteora.ag/developer-guides/alpha-vault/program/instructions, https://github.com/MeteoraAg/alpha-vault-sdk, https://github.com/MeteoraAg/cloudflare-kv-merkle-proof
- Owner's knowledge base (canonical, read locally): `/Volumes/Farhan/Work Folder/Dev/AI/Research-Projects/jupiter-meteora/meteora/01-products-and-protocol.md` section 6 and `meteora/03-dev-dbc-vaults-launch.md`
- On-chain reads (2026-10-26): Solana mainnet `getProgramAccounts` on the SAS program and Civic's Gateway program via https://api.mainnet-beta.solana.com, and wallet histories via the Helius MCP.
