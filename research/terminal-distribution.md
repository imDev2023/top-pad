# How Top-pad's fairness data can reach the trading terminals

Research for ticket [#20](https://github.com/imDev2023/top-pad/issues/20) on the Top-pad wayfinder map, captured 2026-10-26.
It follows [research/launchpad-psychology.md](https://github.com/imDev2023/top-pad/blob/research/launchpad-psychology/research/launchpad-psychology.md), which found that traders check bundles, snipers, dev holdings and a dev's past coins inside terminals, so the Fairness card, Creator record and Bundle Radar matter only if they are visible there.
Terms follow [GLOSSARY.md](https://github.com/imDev2023/top-pad/blob/main/GLOSSARY.md).
**Unverified** marks a claim that no primary source confirmed, usually because the app is behind a login or a bot wall.
Revenue figures are DefiLlama's 30-day `dailyRevenue` totals, pulled 2026-10-26 from `https://api.llama.fi/overview/fees?dataType=dailyRevenue`.

## Answer

- No terminal or screener accepts a third party's per-coin fairness numbers: each one computes dev, sniper, insider and bundler figures from the chain with its own definitions, and none documents a way to submit them.
- What a launchpad can get is recognition: its name, icon and filter inside the terminal, and on Jupiter that recognition is what switches on the launchpad-only views (the Sniper, Insider and Bundler filters and Dev Migrations exist "for launchpad tokens only").
- Recognition is keyed to an on-chain signature, the program plus, on DBC, the partner config: Jupiter's Tokens API names Bags, Jupiter Studio, Ember and DubDub coins by their DBC config and puts unlisted DBC configs in a generic `met-dbc` bucket.
- Only one route is documented and works out of the box: a DBC launchpad listed on Jupiter's Launchpad Screener and AlphaScan through the Meteora team; GMGN, Axiom, Photon, pump.fun's Terminal and DexScreener add launchpads one at a time, by partner request (unverified for most), after they have volume.
- So Top-pad's fairness has to be legible in what terminals already measure: the creator's own wallet must sign the launch (when a launchpad deploys for creators, Jupiter shows the launchpad as the dev, for Bags with 192,597 mints), the creator lock must read as locked supply, and Fair Open buyers must not be counted as insiders.
- The one channel fully under our control is a Fairness card image on every coin's link card and share button, which travels to X, Telegram and Discord without anyone's permission.
- Cheap upstream feeds come next: a Jupiter custom token tag (a public CSV of mints), Codex indexing (Codex says it supplies token data to fomo, Axiom, Phantom and pump.fun), and Solscan labels.
- Blinks are a weak channel now that Phantom has discontinued them, and Solana attestations (SAS) are live but no terminal is known to read them.

### Terminals and screeners

| Surface | 30-day revenue | Launchpad- and token-level data it shows today | Can a third party feed it, and how | Effort |
| - | - | - | - | - |
| Jupiter Spot and AlphaScan (jup.ag, formerly Pro) | $2.0M (Jupiter Aggregator; Spot not split out) | Launchpad name and icon linking to the launchpad; dev holding %, Dev Migrations, snipers %, insiders %, bundlers %, pro traders %, top 10 %; mint and freeze authority; Verified badge; Organic Score; linked X account with a handle-reuse warning; Sniper, Insider and Bundler filters for launchpad tokens only | Launchpad listing: DBC launchpads through the Meteora team, other technology case by case through support.jup.ag; a custom tag from a public CSV of mints, arranged on Discord; VRFD Express verification at 1,000 JUP (about $279) per coin, by API, with an OrgId linked by DMing @jup_vrfd | Low on DBC; Medium otherwise; tag Low; verification per coin |
| GMGN | $12.5M | Launchpad platform tag (27 Solana platform names, among them bags, believe, jup_studio, moonshot_app and a generic `meteora_virtual_curve`, plus four pool types); dev holding and hold or sold status; the creator's launch count and best token; rat-trader and bundler volume share; sniper count; suspected-insider hold rate; rug ratio; whether the dev paid DexScreener; socials | No documented submission route; GMGN adds launchpads itself and announces them; contact is X or Telegram; its OpenAPI is read-only | Medium (route unverified) |
| Axiom | $14.6M | Pulse columns with dev holding %, snipers %, insiders %, bundle %, pro traders, top 10 %; "Dynamic BC Day 1 Support" since May 2025; per-launchpad labels unverified (app is walled) | Only documented channel is a Discord ticket; Codex says it supplies Axiom's pair and token metadata | Medium (unverified) |
| fomo | $15.1M | A launchpad icon that opens the launchpad's page (October 2026); token-tax warnings on launchpad tokens; description, website and X on public price pages; dev and sniper data unverified (app) | No documented route; Codex says it powers fomo's token discovery and charting, so Codex indexing is the likely way in (unverified) | Low through Codex (unverified) |
| Photon | $0.34M | Memescope filters per launchpad, added one by one (Wen.dev in November 2025, Meteora DBC in September 2026); launchpad-specific indicators (StonkFun's flywheel and rewards); dev holding, snipers, insider %, bot holders, dev migrations, dev funding | Adds launchpads one at a time by announcement; the request route is not documented (unverified) | Medium |
| BullX | $683 | Dev holding, top 10, insider holding and bot holders in Pump Vision (2024 posts) | Last feature post February 2025; bans third-party extensions | Skip |
| Terminal by pump.fun (formerly Padre) | $2.49M | Trenches with per-launchpad filters and colour coding (pump.fun, Meteora, Believe, Boop, LaunchLab, LetsBonk, later Sugar and Token Mill); everything else is behind a sign-in | Adds launchpads one at a time by announcement; contact @TradingTerminal (unverified); owned by pump.fun, a direct competitor | Medium to High |
| DexScreener | n/a | "via Bags" launchpad attribution with launchpad pages (pumpfun, meteoradbc, bags, heaven, printr, moonit and others); an Audit section; socials from token lists or Enhanced Token Info; boosts and community takeovers | Launchpad attribution appears to come through its DEX listing request on Discord (criteria: liquidity, volume, open-source audited contracts, community; that launchpads use it is unverified); Enhanced Token Info from $299 per coin, including locked-supply wallets; the API is read-only | Medium for listing; per coin for info |
| Birdeye | n/a | Meme lists by protocol only (`meteora_dynamic_bonding_curve`, with `platform_id` the program address); holder tags bundler, sniper, insider, dev, smart trader; token security | No launchpad route; a token data update costs $200 per coin and is reviewed in 3 to 5 business days | Skip at platform level |
| Solscan | n/a | Launchpad labels on the token authority ("Bags: Token Authority") and a launchpad tag (#Bags); a reputation level (default Unclassified hides logos); socials | Token update form per coin; program instruction parsing after publishing the IDL and messaging Solscan; project labels (route unverified) | Low |
| Phantom token page | $5.41M | Verified or Unverified next to Security; spam filtering with third-party providers; launchpad, dev and sniper fields unverified | No form: Phantom says verification follows its data providers and points creators to Jupiter or CoinGecko; Codex says it supplies Phantom's token data | Indirect only |

### Off-site channels

| Channel | Who it reaches today | How | Effort |
| - | - | - | - |
| Fairness card image (link card and share image) | Everyone who sees a coin link or a shared card on X, Telegram or Discord | `twitter:card` `summary_large_image` and `og:image` on each coin page, a 2:1 image between 300x157 and 4096x4096 pixels under 5 MB, rendered per coin; plus a share button that attaches the same image | Low, and fully ours |
| Jupiter custom token tag | Jupiter's UI and every app reading the Tokens API | Host a public CSV of mint addresses, choose a short tag name and polling interval, contact Jupiter on Discord | Low |
| Codex indexing (upstream data vendor) | fomo, Axiom, Phantom, pump.fun and defined.fi, by Codex's own account | Email hello@codex.io or message @CodexData for the indexing form | Low |
| Solana Actions and Blinks | Few: Phantom discontinued Blinks; on X they unfurl only in a wallet extension that still supports them and only once registered | Register with Dialect by email | Low effort, low reach |
| On-chain attestations (Solana Attestation Service) | No terminal or screener known to read them | A Top-pad credential, a Fairness schema and one attestation per coin, on program `22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG` | Low to Medium, reach none today |
| RugCheck verification | Users of RugCheck and the bots that query it (which ones is unverified) | RugCheck's API has an eligibility check, a verification transaction and a submit step per coin, tied to a `.token` domain | Low per coin |

### Recommended order of integrations

1. Before any request: make the launch carry one Top-pad signature and the creator's own identity on chain (this belongs in the launch mechanism decision, [#10](https://github.com/imDev2023/top-pad/issues/10), and the Creator record, [#21](https://github.com/imDev2023/top-pad/issues/21)).
   - One Top-pad-owned config or authority that every coin shares (a DBC partner config with partner metadata, or on DLMM or DAMM v2 a Top-pad address as pool creator or metadata update authority), so terminals can map coins to Top-pad.
   - The creator's wallet signs the token creation, so terminals show the creator, not Top-pad, as the dev.
   - Socials in the metadata JSON, which terminals display, and a `createdOn` field naming Top-pad (whether any terminal reads it is unverified, and since it is self-declared it labels but proves nothing).
2. Ship the Fairness card image on every coin page and share button, with every number recomputable from the chain; it needs no partner.
3. Jupiter: request the launchpad listing (through the Meteora team if the launch runs on DBC, through support.jup.ag otherwise), then a custom tag such as `top-pad-fair` for coins that passed Fair Open and hold a creator lock; keep VRFD Express for coins that run, since it costs about $279 each.
4. Codex: request indexing, which reaches fomo, Axiom, Phantom and pump.fun by Codex's account, for one email.
5. Solscan: ask for labels on Top-pad's program, config and lock escrows, and publish the program IDL so Fair Open deposits and claims read as named instructions.
6. Once Top-pad has volume: partner requests to Axiom, GMGN, Photon and DexScreener for a launchpad label and filter, starting with Photon, the only one shown to add a launchpad's own indicator (StonkFun's flywheel), and asking each for a "Fair Open" or "Creator locked" mark.
7. Last, and only if cheap: a public read API of Fairness card data and SAS attestations, for agents and future readers.
8. Skip for now: BullX (dormant), Blinks (Phantom dropped them), per-coin Birdeye updates, and pump.fun's Terminal (owned by the incumbent; try only after the others).

## What terminals already compute

Every major terminal already shows the numbers Bundle Radar would publish, under its own definitions, so Top-pad's numbers will sit next to theirs rather than replace them.

- Jupiter defines snipers as wallets that bought "within the first three blocks after launch", insiders as wallets that bought "within the first block after launch, or received the token from another insider" with the status propagating through transfers, and bundlers as wallets in "a coordinated cluster of transactions in a single block, all trading the same token" ([Jupiter token page docs](https://docs.jup.ag/user-docs/trade/spot/token-page)).
- Jupiter's token page shows the deployer as "DA (Developer Address)", "the wallet address that deployed the token contract", plus Dev Holding %, Dev Migrations with the developer's bonded, created and top-token record, Snipers Holding % and Insiders Holding % (same source).
- Jupiter's Sniper, Insider and Bundler filters on the Transactions and Holders tabs, and Dev Migrations, are available "for launchpad tokens only" (same source), so a coin Jupiter does not recognise as a launchpad coin loses these views.
- GMGN's token data has `dev.creator_address`, `dev.creator_token_status` (hold or sell), `dev.creator_open_count` (tokens this creator launched before), `dev.ath_token_info`, `stat.top_bundler_trader_percentage`, `stat.top_rat_trader_percentage`, `wallet_tags_stat.sniper_wallets` and `bundler_wallets`, and flags for whether the dev paid DexScreener for an ad, a boost or a social update ([gmgn-cli 1.6.9 token skill](https://cdn.jsdelivr.net/npm/gmgn-cli@1.6.9/skills/gmgn-token/SKILL.md)).
- GMGN's own icon legend marks Sniper ("buys in earlier blocks after pool created"), Bundled Tx Wallet, Suspected Insider ("same creation time, funding source and transfer time"), DEV team ("Creator and bundled buyers") and "DEV holds 10%" ([GMGN featured icon definitions](https://docs.gmgn.ai/index/featured-icon-definition)).
- Axiom's Pulse filters are Dev Holding %, Snipers %, Insiders %, Bundle %, Top 10 Holders % and Pro Traders ([Axiom Pulse docs](https://docs.axiom.trade/axiom/finding-tokens/pulse)).
- Photon added an Insider % and bot-holder filter, a filter for "successful migrations by dev" and a Dev token tab on all token pages in December 2024 ([Photon on X](https://x.com/tradewithPhoton/status/1869443145030947036)), and dev funding sources on Memescope in November 2025 ([Photon on X](https://x.com/tradewithPhoton/status/1987900861415412214)).
- The data vendors behind terminals sell the same: Birdeye's holder profile breaks holders down "by tag such as bundler, sniper, insider, dev, and smart trader" ([Birdeye Data docs](https://data.birdeye.so/docs/data-api/holder/get-token-v1-holder-profile)), Codex's `tokenWalletStats` "returns the sniper, bundler and insider wallets that still hold a token" ([Codex docs index](https://docs.codex.io/llms.txt)), and Mobula labels wallets as sniper, insider, bundler and more ([Mobula docs index](https://docs.mobula.io/llms.txt)).
- Jupiter's public Tokens API does not carry sniper, insider or bundler shares: across 247 distinct tokens pulled on 2026-10-26 its `audit` object held only `devMints`, `devMigrations`, `topHoldersPercentage`, `devBalancePercentage` and the mint and freeze authority flags (live pull of `/tokens/v2/toptraded/24h`, `/toptrending/1h`, `/toporganicscore/1h` and `/recent`).

What this means for the design:
- Bundle Radar's value inside terminals is not a second set of percentages; it is a launch whose percentages already look clean because Fair Open and the creator lock made them clean.
- Our definitions will differ from each terminal's, so the Fairness card should state its definitions and link to the chain data, or a trader will see two different "insider %" numbers and trust neither.

## How a terminal knows which launchpad a coin came from

- Jupiter's Tokens API returns `launchpad` and `partnerConfig` for each token; in the 2026-10-26 pull, listed DBC launchpads came back under their own names with their DBC config as `partnerConfig` (`bags.fun` with `7ZupKrQ...`, `jup-studio` with `2k6Q4Dj...`, `ember` with `B76NiZr...`, `dubdub` with `GybkUNY...`), while other DBC configs came back as `met-dbc` (live pull, as above).
- StonkFun coins came back as `stonkfun` under at least two partner configs, and pump.fun coins as `pump.fun` with no config (same pull).
- GMGN filters by a fixed list of platform names that includes individual DBC launchpads (`bags`, `believe`, `jup_studio`, `moonshot_app`, `boop`, `bankr`) next to a generic `meteora_virtual_curve` and plain pool types such as `pool_meteora` ([gmgn-cli 1.6.9 market skill](https://cdn.jsdelivr.net/npm/gmgn-cli@1.6.9/skills/gmgn-market/SKILL.md)).
- DexScreener showed the Bags coin BAGSPAY as "Meteora - DYN2 via Bags", with Bags linking to `dexscreener.com/solana/bags` ([pair page](https://dexscreener.com/solana/dxsbgayrefnfxgu9tec17n4usq5jjy4zf9djt7rblrgf)), and its Solana page lists named pages for pumpfun, meteoradbc, bags, heaven, printr, moonit, zora, rise and metadao next to the DEXes ([DexScreener Solana](https://dexscreener.com/solana)).
- DexScreener's public API carries no launchpad field: the same pairs return only `dexId` (`meteora`, `pumpfun`, `raydium`) and `labels` such as `DYN2` or `CPMM` ([DexScreener API reference](https://docs.dexscreener.com/api/reference), live pull of `/tokens/v1/solana/...`).
- Solscan shows BAGSPAY's authority and creator as "Bags: Token Authority" (`BAGSB9Tp...`), its first mint by "Meteora DBC: Pool Authority", and tags it `#Bags`, `#Meteora.ag` and `#Memecoin` ([Solscan token page](https://solscan.io/token/H8WTvo3ZXSYHJAcYqzCforbG8coR1FDAX2kHFfqHBAGS)).
- Birdeye's meme list identifies the source only at the protocol level (`pump_dot_fun`, `moonshot`, `raydium_launchlab`, `meteora_dynamic_bonding_curve` and others) with `platform_id` the program address, so DBC launchpads are not told apart ([Birdeye meme list docs](https://data.birdeye.so/docs/data-api/meme/get-defi-v3-token-meme-list)).
- Codex names launchpads on two axes, a launchpad name (what users see, including thin wrappers) and a protocol, and its Solana names include `MeteoraDBC` and, separately, `Meteora Alpha Vault`, besides individual DBC launchpads such as BAGS, Believe, Jupiter Studio and StonkFun ([Codex supported launchpads](https://docs.codex.io/launchpads)).
- Off-chain metadata often carries a `createdOn` field: two pump.fun coins said `pump.fun` and `https://pump.fun`, and a coin from the OTC wrapper said `otc` (Helius DAS `getAsset` and the metadata JSON, pulled 2026-10-26); whether terminals read it is unverified, and anyone can write it.

What this means for the design:
- On DBC, Top-pad gets a natural signature (its partner config) and Jupiter's only documented out-of-the-box listing path ([Jupiter Launchpad Screener docs](https://docs.jup.ag/user-docs/trade/spot/launchpad-screener-and-runners)).
- On DLMM or DAMM v2, a launch looks like any new Meteora pool (GMGN's `pool_meteora`) unless the terminal is asked to map a Top-pad address, though Codex already recognises Alpha Vault launches as their own launchpad name; this weighs on the launch mechanism decision in [#10](https://github.com/imDev2023/top-pad/issues/10).
- DBC lets the partner hold the metadata update authority (`TokenAuthorityOption` value 2, `PartnerUpdateAuthority`), which is likely how Bags' authority appears on every Bags coin (owner's knowledge base, `meteora/03-dev-dbc-vaults-launch.md`; that Bags uses this option is unverified).

## Findings per surface

### Jupiter: Spot, AlphaScan, the Launchpad Screener, VRFD and tags

- AlphaScan shows each new coin's launchpad ("e.g. pump, StonkFun, Purps, Perpspad, OTC"), its linked X account with a warning when the account has used more than one handle, Dev Holding %, Snipers Holding %, Insiders Holding % and Pro Traders %, and filters for Bundlers Holding %, Dev Migrations and Organic Score ([AlphaScan docs](https://docs.jup.ag/user-docs/trade/spot/alphascan)).
- AlphaScan's launchpad filter lists launchpads "ranked by current activity", with Jupiter Studio pinned at the top (same source).
- A listed launchpad gets "Routing through Jupiter and access via 100+ partners", "Real-time indexing with individual token pages" and "AlphaScan support and a dedicated screener page, with the launchpad's logo, token links, and bonding-curve view where applicable" ([Jupiter Launchpad Screener docs](https://docs.jup.ag/user-docs/trade/spot/launchpad-screener-and-runners)).
- The listing route: "If your launchpad is built on Meteora DBC, request listing through the Meteora team, which coordinates DBC launchpad listings with Jupiter. If your launchpad runs on its own technology, contact the Jupiter team at support.jup.ag; these requests are evaluated case by case" (same source).
- Jupiter's support centre is stricter: "Custom launchpads on other technologies are not currently supported" (support.jup.ag, as captured in the owner's knowledge base, `raw/external/support.jup.ag.md`); the docs page is newer and names non-DBC additions (StonkFun, Purps, Perpspad, OTC), so the docs wording is taken as current.
- Jupiter's token page shows a launchpad or issuer icon that opens the coin on its launchpad site ([Jupiter token page docs](https://docs.jup.ag/user-docs/trade/spot/token-page)).
- Custom tags: "Host a public CSV endpoint with mint addresses (one per row)", "Provide a preferred tag name (short, mobile-friendly)", "Set a polling interval", and "Reach out via Discord to begin ingestion"; tags "appear in the Jupiter UI and are available via the GET /tag endpoint" ([Jupiter Tokens API docs](https://developers.jup.ag/docs/tokens)).
- Partners use this route: of the 247 distinct tokens pulled on 2026-10-26, tags named after other platforms included `moonshot-verified` (53 tokens), `backpack` (23), `xstocks` (15), `birdeye-trending` (11), `prestocks` (2) and `tessera` (1) (live pull, as above).
- The Tokens API's data is used, by Jupiter's account, by Phantom, Solflare and most Solana apps (owner's knowledge base, `jupiter/02-developer-platform-and-apis.md` section 3.1); whether a given app shows custom tags is unverified.
- VRFD verification gives the green Verified badge that Jupiter Wallet, Jupiter Mobile, Spot and partners such as Phantom show; standard review is free with no timeline, Express costs 1,000 JUP per submission with a first review within 24 to 48 hours (knowledge base, `jupiter/01-products-user-docs.md` section 14.4).
- Express verification has an API "for launchpads, agents and projects", and "known projects/launchpads" are told to DM `@jup_vrfd` on X to link their Developer Platform OrgId to submissions (knowledge base, `jupiter/02-developer-platform-and-apis.md` section 3.6).
- 1,000 JUP was about $279 on 2026-10-26 (Jupiter Price API v3, JUP at $0.279).
- Verification criteria weigh social support on a dedicated project X account most, then market cap, Organic Score, holder distribution, ticker uniqueness and liquidity (knowledge base, section 14.4), so most memecoins will not qualify in their first hours.

### GMGN

- 30-day revenue $12.5M (DefiLlama).
- Its Trenches feed filters new coins by launchpad, dev holdings, KOL entry and rat-trader ratio ([gmgn-cli README](https://cdn.jsdelivr.net/npm/gmgn-cli@1.6.9/Readme.md)).
- Its token data carries `launchpad`, `launchpad_status`, `launchpad_progress` and `launchpad_platform`, plus `link.verify_status`, a "social verification status" ([gmgn-cli 1.6.9 token skill](https://cdn.jsdelivr.net/npm/gmgn-cli@1.6.9/skills/gmgn-token/SKILL.md)).
- It has a `fee_distribution` object only for `pump` and `bankr` coins, so launchpad-specific economics are shown for launchpads GMGN chose to integrate (same source).
- GMGN announces launchpad support itself, for example "ETH Trenches now support Trench, Clanker, Klik, Livo, Stroid, Printr launchpads" in May 2026 ([GMGN on X](https://x.com/gmgnai/status/2053462889835704521)).
- Its docs list only X, a Telegram group and bots as contacts ([GMGN contact page](https://docs.gmgn.ai/index/contact-us)), and its Q&A says data access goes to partners who bring trading volume or users ([GMGN Q&A](https://docs.gmgn.ai/index/q-a)).
- No documented way exists for a launchpad to be added or to submit per-coin data; the route is a partner request through X or Telegram (unverified).

### Axiom

- 30-day revenue $14.6M (DefiLlama).
- Pulse lists new pairs, coins near the end of their curve, and migrated coins, with the filters listed above ([Axiom Pulse docs](https://docs.axiom.trade/axiom/finding-tokens/pulse)); the page still speaks of migration to Raydium, so it is out of date.
- Axiom announced "Boop, Bonk, LaunchLabs, Dynamic BC Day 1 Support" in May 2025 ([Axiom on X](https://x.com/AxiomExchange/status/1919421841447247906)).
- Codex lists Axiom as a customer for "Pair and token metadata, plus liquidity checks" ([codex.io](https://www.codex.io)).
- The only contact Axiom documents is a ticket in its Discord ([Axiom support](https://docs.axiom.trade/support)).
- Whether Axiom labels individual DBC launchpads, and how one gets added, is unverified: the app is behind a login and a Cloudflare wall.

### fomo

- 30-day revenue $15.1M as "fomo Wallet" (DefiLlama), the largest of the terminals.
- Its October 16, 2026 release notes say "Click a token's launchpad icon to open its launchpad page" and "Launchpad tokens now display token-tax warnings" ([fomo release notes](https://fomo.family/release-notes)).
- Its public price pages show a description, website and X link, for example the HOOKED page ([fomo](https://fomo.family/prices/hooked)); dev, sniper and bundler fields inside the app are unverified.
- Codex lists fomo for "Token discovery and charting for DeFi's top social-trading platform" ([codex.io](https://www.codex.io)), so Codex's launchpad names are the likely source of fomo's launchpad icons (unverified).

### Photon

- 30-day revenue $0.34M (DefiLlama).
- "Stonk, Pump and Meteora DBC assets are all now supported on Photon", with "Flywheel & Rewards indicators for Stonk tokens on Memescope & Token pages" and a one-click StonkFun filter (September 2026, [Photon on X](https://x.com/tradewithPhoton/status/2099246067909079253)).
- "Support for Wen . dev Launchpad now added as new filter on Memescope" (November 2025, [Photon on X](https://x.com/tradewithPhoton/status/1987900861415412214)).
- Photon shows the links in a coin's own metadata by default, with an option to replace them with DexScreener links ([Photon on X](https://x.com/tradewithPhoton/status/2075267270667022378)).
- StonkFun's indicators are the only case found of a terminal displaying a launchpad's own feature, which makes Photon the best first ask for a "Fair Open" or "Creator locked" mark; how StonkFun arranged it is unverified.

### BullX

- 30-day revenue $683 (DefiLlama).
- Its last feature announcement found is from February 2025 ([BullX on X](https://x.com/bullx_io/status/1887258112702451807)), and it bans third-party browser extensions on its site ([BullX on X](https://x.com/bullx_io/status/1888690125628219422)).
- Not worth an integration.

### Terminal by pump.fun (formerly Padre)

- DefiLlama lists "Terminal" at `terminal.pump.fun` as "Pump.fun's advanced memecoin trading terminal", "previously known as Padre", with $2.49M of 30-day revenue ([DefiLlama](https://api.llama.fi/summary/fees/terminal)).
- It markets "All Launchpads. One Terminal" with pump.fun, Meteora, Believe, Boop, LaunchLab and LetsBonk in its Trenches ([Terminal on X](https://x.com/TradingTerminal/status/1924474429355995393)), launchpad colour coding ([Terminal on X](https://x.com/TradingTerminal/status/1943286886715269618)), and new launchpads one at a time, such as Sugar and Token Mill ([Terminal on X](https://x.com/TradingTerminal/status/1958929799683948913), [Terminal on X](https://x.com/TradingTerminal/status/1958559656441262357)).
- Everything past the landing page needs a sign-in (firecrawl capture of `terminal.pump.fun`, 2026-10-26).
- Because pump.fun owns it, it is the least likely to promote a rival's fairness claims; this is a judgement, not a finding.

### DexScreener

- Every token with a pool and one trade is listed automatically, and token info comes from external lists such as CoinGecko's or from Enhanced Token Info ([DexScreener token listing docs](https://docs.dexscreener.com/token-listing)).
- Enhanced Token Info is sold "from $499.00 $299.00" per coin, usually processed in minutes and at most in 12 hours, and lets a project "Set wallets holding locked supply" so market cap is right ([DexScreener marketplace](https://marketplace.dexscreener.com/product/token-info)); the locked-supply setting is a direct way to show the creator lock, but each creator would pay for it.
- DEX listing requests go through its Discord, and it weighs "a significant amount of liquidity and daily volume", "open-sourced and audited smart contracts" and "an active community and user base" ([DexScreener DEX listing docs](https://docs.dexscreener.com/dex-listing)); that launchpad pages such as `/solana/bags` come through this route is unverified.
- Pair pages show an Audit section ("No issues", with "Warning! Audits may not be 100% accurate!") and a claim link for a community takeover profile ([pair page](https://dexscreener.com/solana/dxsbgayrefnfxgu9tec17n4usq5jjy4zf9djt7rblrgf)).
- Its API is read-only (token profiles, community takeovers, ads, boosts, orders, pairs) ([DexScreener API reference](https://docs.dexscreener.com/api/reference)).
- GMGN reads whether a dev paid DexScreener (`dev.dexscr_ad`, `dev.dexscr_update_link`, `dev.dexscr_boost_fee`), so DexScreener spending is itself a signal traders see elsewhere ([gmgn-cli 1.6.9 token skill](https://cdn.jsdelivr.net/npm/gmgn-cli@1.6.9/skills/gmgn-token/SKILL.md)).

### Birdeye

- Birdeye indexes "Meteora Dynamic Bonding Curve", "Meteora Virtual Curve", "Meteora DLMM", "Meteora DAMM V2" and "Raydium LaunchLab" as sources ([Birdeye DEX coverage](https://data.birdeye.so/docs/resources/data-coverage/dex-coverage)), and tells launchpads apart only by program ([Birdeye meme list docs](https://data.birdeye.so/docs/data-api/meme/get-defi-v3-token-meme-list)).
- A token data update (name, description, logo, socials, holder information) and a banner are "ordinarily priced at $200 per token update", waived for April 2026 only, and reviewed in 3 to 5 business days ([Birdeye blog](https://birdeye.so/blog/detail/be-seen-for-free-birdeyes-4-year-anniversary-gift-to-solana-builders)).
- Jupiter carries a `birdeye-trending` tag, so Birdeye's trending list already reaches Jupiter's data (live pull, as above).

### Solscan

- Token updates go "ONLY through our official form", with request types Reputation Update, Social Links and Logo Update, Community Takeover and Token Migration, and most tokens start "Unclassified", which hides the logo ([Solscan update token details](https://docs.solscan.io/integration/update-token-details), [form](https://solscan.io/token-update)).
- Anchor programs get their instructions parsed and labelled after publishing the IDL on chain and sending the program IDs to Solscan's admins on X, Telegram or Discord ([Solscan parse instruction](https://docs.solscan.io/integration/parse-instruction)).
- Solscan ranks a project name second after domain names when labelling an address ([Solscan labeling](https://docs.solscan.io/transaction-details/labeling)), and it labels Bags' token authority and tags Bags coins `#Bags` ([Solscan token page](https://solscan.io/token/H8WTvo3ZXSYHJAcYqzCforbG8coR1FDAX2kHFfqHBAGS)); how a launchpad gets such a tag is unverified.
- Explorer labels matter for Fair Open: a trader who checks a deposit or claim on Solscan should see "Top-pad: Fair Open deposit", not an unknown program.

### Phantom

- 30-day revenue $5.41M as "Phantom Wallet" (DefiLlama).
- A verified token shows a purple checkmark, or Verified next to Security in the About section; Phantom says "we do not have an email address or form to assist with token verification" and points to CoinGecko and Jupiter, while "being listed on either does not guarantee verification in Phantom" ([Phantom help](https://help.phantom.com/articles/38425812822419)).
- Spam filtering uses "multiple internal systems and third-party security providers" and does not publish its criteria ([Phantom help](https://help.phantom.com/articles/why-is-my-token-hidden-or-flagged-as-spam-51665009279251)).
- Codex lists Phantom for "Token data for one of the most-used wallets in crypto" ([codex.io](https://www.codex.io)).
- Whether Phantom's token page shows a launchpad, dev, sniper or bundler field is unverified.
- Phantom reaches traders only indirectly, through Jupiter verification, CoinGecko and its data providers.

### Data vendors upstream of the terminals

- Codex adds "new launchpads every week": "Email hello@codex.io or message @CodexData on Telegram and we'll send you the indexing form", after which a launchpad appears in its `launchpadName` filters, its launchpad event streams and, "where the lock can be proven on chain", in `liquidityLocksV2` ([Codex supported launchpads](https://docs.codex.io/launchpads)).
- Codex names Coinbase, fomo, Uniswap, Phantom, Axiom, pump.fun, Rainbow, MoonPay and others as customers, each with the data it supplies ([codex.io](https://www.codex.io)).
- Mobula offers a Codex-compatible launchpad stream and its own "Pulse" feed and documents how to build "an Axiom-style Pulse feature" ([Mobula docs index](https://docs.mobula.io/llms.txt)); it documents no way to add a launchpad.
- RugCheck's API has `POST /v1/tokens/verify/eligible`, `/v1/tokens/verify/transaction` and `/v1/tokens/verify`, where a verification carries a description, links and a `*.token` domain, and its verified list records whether a token is also Jupiter-verified ([RugCheck API spec](https://api.rugcheck.xyz/swagger/doc.json)).

## Off-site channels in detail

### An image for X posts

- X's large-image card supports "an aspect ratio of 2:1 with minimum dimensions of 300x157 or maximum of 4096x4096 pixels", and "Images must be less than 5MB in size" ([X developer docs, 2023 archive](https://web.archive.org/web/2023/https://developer.twitter.com/en/docs/twitter-for-websites/cards/overview/summary-card-with-large-image)); the live page now redirects to the X developer portal home.
- The trench culture already shares images: "PnL screenshots are the best form of marketing" (pump.fun's co-founder, cited in the psychology research), and Axiom ships custom P&L cards ([Axiom on X](https://x.com/AxiomExchange/status/1919421841447247906)).
- The Fairness card image should therefore carry the verdict and the key numbers in the picture itself (creator buy and lock, Fair Open price and depositors, Bundle Radar result), the coin's address, and a link to recompute each number.
- It needs no partner and reaches anyone a coin link is posted to, which makes it the first thing to ship.

### Solana Actions and Blinks

- Phantom's developer docs say "Phantom has discontinued support for Blinks. Blink buttons no longer trigger transactions in Phantom, and there are no plans to resume support" ([Phantom docs](https://docs.phantom.com/developer-powertools/solana-actions-and-blinks)).
- Blinks on X unfurl only through a Chrome extension that embeds Dialect's Twitter observer ([Dialect Chrome extension docs](https://docs.dialect.to/blinks/blinks-client/integrate/chrome)), and "only Actions that have been registered in the Dialect registry will unfurl in the Twitter feed", with registration by email and a manual review ([Dialect blink registry](https://docs.dialect.to/blinks/blinks-provider/blink-registry)).
- Which wallets still unfurl Blinks on X is unverified; with Phantom gone the reach is small, so a "Deposit in Fair Open" Blink is a later nice-to-have.

### On-chain attestations

- The Solana Attestation Service has been live on mainnet since May 2025, lets "trusted issuers" attach signed claims to a wallet, and names "Sybil Resistance: Prove human uniqueness for airdrops, governance, or fair launches" as a use case ([Solana Foundation](https://solana.com/news/solana-attestation-service)).
- An issuer registers a credential with authorised signers and publishes schemas under it, on program `22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG` ([SAS repository](https://github.com/solana-foundation/solana-attestation-service), [Solana docs](https://solana.com/docs/tools/attestations)).
- No terminal, screener or wallet in this survey documents reading SAS attestations, so a Fairness attestation would reach no trader today.
- SAS could later carry the Fair Open depositor check (a sybil-resistance credential) rather than the Fairness card itself.

### Jupiter token tags

- See the Jupiter section: a public CSV of mints, a short tag name, a polling interval and a Discord request.
- The tag should mean something checkable, for example "Fair Open, creator lock active", and be removed when it stops being true, because a tag that marks every Top-pad coin says nothing a launchpad label does not already say.

## Risks the design must handle

- **The deployer becomes the dev.** Jupiter's DA is "the wallet address that deployed the token contract" ([Jupiter token page docs](https://docs.jup.ag/user-docs/trade/spot/token-page)), and in the 2026-10-26 pull the Bags coin BAGSPAY's `dev` was Bags' own authority `BAGSB9Tp...` with 192,597 `devMints` and 2,125 `devMigrations`, an OTC-wrapper pump.fun coin's dev had 176,566 mints, and four StonkFun coins had `5CEbue...` as dev with 8,483 mints (live pull, as above), a wallet the owner's Stoker research identifies as StonkFun's platform fee wallet (`stonk-fun-solana/research/README.md`, as cited in the psychology research).
  If Top-pad's server or program creates the coins, every terminal will show Top-pad as the dev with thousands of launches, and the Creator record will be invisible exactly where traders look.
- **Fair Open buyers may be flagged as insiders (unverified).** Alpha Vault buys from the pool before activation and depositors then claim from it (owner's knowledge base, `meteora/01-products-and-protocol.md` section 6), while Jupiter counts first-block buyers and anyone who "received the token from another insider" as insiders; a fair, vault-based open could therefore read as a high-insider coin.
  This needs a check on a real Alpha Vault launch before Fair Open is committed.
- **Locked creator supply may read as a whale or as zero dev holding (unverified).** A lock escrow is neither the dev wallet nor a burn; how each terminal treats it is unknown, while DexScreener lets a paid profile mark locked-supply wallets.
- **Two sets of numbers.** Top-pad's "insider %" will not match Jupiter's or GMGN's, so the Fairness card must publish its definitions.

## Open questions and unverified points

- How Axiom, GMGN, Photon and Terminal decide to add a launchpad, and whether any accepts a launchpad-supplied indicator beyond StonkFun's case on Photon.
- Whether fomo's launchpad icons come from Codex.
- Whether DexScreener's launchpad pages are granted through its DEX listing process.
- Whether Phantom's token page shows a launchpad or dev field.
- Whether any terminal reads metadata `createdOn`.
- Which wallets still unfurl Blinks on X.
- How terminals classify Alpha Vault claimers and lock escrows.

## Sources

- Jupiter user docs: https://docs.jup.ag/user-docs/trade/spot/launchpad-screener-and-runners, https://docs.jup.ag/user-docs/trade/spot/alphascan, https://docs.jup.ag/user-docs/trade/spot/token-page (fetched as Markdown 2026-10-26).
- Jupiter developer docs: https://developers.jup.ag/docs/tokens.
- Jupiter Tokens API v2 live pulls (`/toptraded/24h`, `/toptrending/1h`, `/toporganicscore/1h`, `/recent`) and Price API v3, 2026-10-26.
- The owner's Jupiter + Meteora knowledge base: `jupiter/01-products-user-docs.md` (sections 2.10, 2.11, 14.4), `jupiter/02-developer-platform-and-apis.md` (sections 3.1 to 3.6), `ecosystem-and-apps.md` (sections 1.3, 4.8), `meteora/03-dev-dbc-vaults-launch.md`, `raw/external/support.jup.ag.md`.
- GMGN: https://cdn.jsdelivr.net/npm/gmgn-cli@1.6.9/Readme.md, the `gmgn-market` and `gmgn-token` skills in the same package, https://docs.gmgn.ai/index/featured-icon-definition, https://docs.gmgn.ai/index/contact-us, https://docs.gmgn.ai/index/q-a.
- Axiom: https://docs.axiom.trade/axiom/finding-tokens/pulse, https://docs.axiom.trade/support.
- fomo: https://fomo.family/release-notes, https://fomo.family/prices/hooked.
- DexScreener: https://docs.dexscreener.com/token-listing, https://docs.dexscreener.com/dex-listing, https://docs.dexscreener.com/api/reference, https://marketplace.dexscreener.com/product/token-info, pair and Solana pages captured 2026-10-26.
- Birdeye: https://data.birdeye.so/docs/data-api/meme/get-defi-v3-token-meme-list, https://data.birdeye.so/docs/data-api/holder/get-token-v1-holder-profile, https://data.birdeye.so/docs/resources/data-coverage/dex-coverage, https://birdeye.so/blog/detail/be-seen-for-free-birdeyes-4-year-anniversary-gift-to-solana-builders.
- Solscan: https://docs.solscan.io/integration/update-token-details, https://docs.solscan.io/integration/parse-instruction, https://docs.solscan.io/transaction-details/labeling, token page captured 2026-10-26.
- Phantom: https://help.phantom.com/articles/38425812822419, https://help.phantom.com/articles/why-is-my-token-hidden-or-flagged-as-spam-51665009279251, https://docs.phantom.com/developer-powertools/solana-actions-and-blinks.
- Codex: https://docs.codex.io/launchpads, https://docs.codex.io/llms.txt, https://www.codex.io.
- Mobula: https://docs.mobula.io/llms.txt.
- RugCheck: https://api.rugcheck.xyz/swagger/doc.json.
- Dialect: https://docs.dialect.to/blinks/blinks-provider/blink-registry, https://docs.dialect.to/blinks/blinks-client/integrate/chrome.
- Solana Attestation Service: https://solana.com/news/solana-attestation-service, https://github.com/solana-foundation/solana-attestation-service, https://solana.com/docs/tools/attestations.
- X cards: https://web.archive.org/web/2023/https://developer.twitter.com/en/docs/twitter-for-websites/cards/overview/summary-card-with-large-image.
- DefiLlama: https://api.llama.fi/overview/fees?dataType=dailyRevenue and https://api.llama.fi/summary/fees/terminal, pulled 2026-10-26.
- Helius DAS `getAsset` and the linked metadata JSON for sample pump.fun, Bags, Jupiter Studio and StonkFun coins, 2026-10-26.
- Posts on X by the terminals themselves, found with twitterapi.io search and linked inline.
