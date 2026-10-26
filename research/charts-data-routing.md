# Charts, market data and swap routing for the trading screens

Research for ticket #8 on the Top-pad wayfinder map, captured 2026-10-26.
Sources are primary: TradingView's own docs and licence pages, the providers' API docs, the libraries' source, the owner's Jupiter + Meteora knowledge base (KB), and read-only live calls made on 2026-10-26 (no transactions were sent).
Anything that could not be confirmed is marked **unverified**.

## Answer

### The recommended combination

| Layer | Devnet prototype | Mainnet |
| --- | --- | --- |
| Chart | TradingView Lightweight Charts v5 | Lightweight Charts v5 at launch; apply for Advanced Charts once a company runs the public site, and swap it in behind the same candle API |
| Candles, trades, graduation bar, P&L | Our own indexer built from Meteora pool events | The same indexer (it is the only source that covers our curve from its first trade at 1-second resolution) |
| Holders | Our own indexer, cross-checked against the mint's token accounts read over RPC | The same, plus Jupiter Tokens API v2 for holder count, audit, organic score and verification |
| Ingestion | Standard devnet RPC `logsSubscribe`, Helius `rawDevnet` webhooks, or LaserStream devnet (offered on every Helius plan) | Helius webhooks on the $49 Developer plan's credits at first; LaserStream gRPC (Business, $499/month) when volume needs it |
| Routing on our own pools | Server-built direct swaps on DBC, DAMM v2 and DLMM with the platform's referral account | The same |
| Routing beyond our pools | None needed; neither Jupiter nor Titan runs on devnet | Jupiter Swap v2: `/build` with `platformFeeBps` when the swap is composed with our own instructions, `/order` + `/execute` with a referral fee for plain any-token swaps; Titan only as a later second quote |
| TradingView widgets | Not for coin charts | At most a SOL/USD ticker or the underlying stock of a stock-priced coin |

### Why

- **Lightweight Charts is the only TradingView chart library a devnet prototype may use.**
  It is Apache 2.0 open source and needs only the NOTICE text plus a link to tradingview.com, which its `attributionLogo` option satisfies.
  Advanced Charts is free only for companies running a public, non-paywalled site; TradingView says it does not license it "for personal use, hobbies, studies, or testing", which is what a devnet prototype is.
  Advanced Charts also may not sit in a public repository, and the Top-pad repo is public.
- **Advanced Charts stays reachable.**
  Its Datafeed API is six methods (`onReady`, `searchSymbols`, `resolveSymbol`, `getBars`, `subscribeBars`, `unsubscribeBars`) over our own data, so a candle API shaped like TradingView's UDF "response-as-a-table" feeds both libraries and makes the later switch a front-end change.
  What it adds is 100+ built-in indicators and 110+ drawing tools; Lightweight Charts has no built-in indicators and only example plugins for drawings (trend line, rectangle, vertical line).
- **The widgets cannot chart our coins at all.**
  TradingView's own FAQ says widgets show only TradingView's data and cannot be fed your own.
  TradingView carries Meteora DLMM and DAMM v1 pools, but not DBC or DAMM v2, which are exactly the two programs a Meteora launch trades on (curve, then graduated pool), and it never carries devnet.
  None of 12 high-volume DLMM pools aged 0.2 hours to 31 days could be found in TradingView's symbol search, while a long-listed SOL-USDC pool could.
- **Only our own indexer works on devnet, and it is also the best mainnet source.**
  No third party indexes devnet: Meteora's "dev" data API hosts serve mainnet pools and return 404 for live devnet pools; Jupiter, Birdeye and Codex are mainnet only.
  On mainnet, Meteora's data API gives 5-minute candles at best and its DBC API has no prices, and Jupiter's 1-second candle feed (`datapi.jup.ag`) is undocumented, outside the documented developer platform, with no SLA.
  Our own indexer decodes DBC `EvtSwap2`, DAMM v2 `EvtSwap2` and DLMM `Swap2Evt` from the first slot, which also gives the graduation bar (`quote_reserve_amount / migration_threshold`) and the raw data Bundle Radar and the Fairness card need.
  The owner's Stoker project already runs this pattern (Helius webhooks into Postgres, `date_bin` candles, Lightweight Charts 5.2.1).
- **Trades on our own pools should not go through an aggregator.**
  A server-built direct swap works on devnet, pays no aggregator fee, can carry our own program's instructions, and earns the platform 20% of Meteora's protocol fee by passing our referral token account.
- **Jupiter, not Titan, for everything beyond our pools.**
  Jupiter's Metis lists new Meteora DBC, DAMM v2 and DLMM markets instantly by token age, and live quotes routed tokens minutes old through both the curve and a just-graduated DAMM v2 pool.
  `/build` charges no Jupiter swap fee and pays our `platformFeeBps` into a token account we control, with no Jupiter share documented; `/order` adds RFQ and other routers but Jupiter keeps 20% of a 50 to 255 bps referral fee.
  Titan needs us to land every transaction, our Portal key exposes only Titan's own two providers, its integrator-fee terms are undocumented, and in a live test it found no route for a freshly graduated DAMM v2 pool that Jupiter routed.

### What pump.fun and StonkFun do

- pump.fun serves TradingView Advanced Charts from `/tradingview/charting_library/` on its own domain, and the only data hosts in its coin page are its own (`frontend-api-v3.pump.fun`, `swap-api.pump.fun`); it is a company with a public site, which is the case the Advanced Charts licence is written for.
- StonkFun draws with Lightweight Charts (`createChart`, `CandlestickSeries`, `attributionLogo: true`) and fetches candles straight from the browser at `https://datapi.jup.ag/v2/charts/{mint}` in 1m to 1D intervals; its pages load the Jupiter Plugin swap widget.
- Meteora's own `fun-launch` scaffold does the same as StonkFun with Advanced Charts: the `charting_library` types plus `datapi.jup.ag` and `wss://trench-stream.jup.ag/ws` (KB).
- Top-pad should copy pump.fun's ownership of the data, not StonkFun's dependence on an undocumented Jupiter feed that cannot work on devnet.

## Evidence

### 1. Charts

#### 1.1 Lightweight Charts

- Repository `tradingview/lightweight-charts`, licence Apache-2.0, latest release v5.2.1 on 2026-08-12, 17,687 stars, last push 2026-10-23 (GitHub API, 2026-10-26).
- The README requires "the 'attribution notice' from the NOTICE file and a link to https://www.tradingview.com/" on a page users can see, and says the `attributionLogo` chart option "will satisfy the link requirement" (https://github.com/tradingview/lightweight-charts#license).
- The NOTICE file is two lines: the product name "TradingView Lightweight Charts" and a 2025 copyright line for TradingView, Inc. with the link https://www.tradingview.com/.
- TradingView's product page calls it "35 KB" and "Apache 2.0 licensed" (https://www.tradingview.com/lightweight-charts/); the Advanced Charts product-comparison page says 45 KB (https://www.tradingview.com/charting-library-docs/latest/product-comparison.md).
- Data is pushed to the chart by the app, not requested by the library, and "Lightweight Charts does not contain any built-in indicators" (same product-comparison page).
- The repo ships indicator examples (moving average, momentum, percent change, weighted close, correlation and others under `indicator-examples/src/indicators`) and plugin examples including `trend-line`, `rectangle-drawing-tool`, `vertical-line`, `user-price-lines`, `user-price-alerts` and `volume-profile` (`plugin-examples/src/plugins`).
- v5 added multiple panes (`addPane`, per-pane series, stretch factors in 5.0.8), data conflation for large datasets (5.1.0) and series hit testing (5.2.0) (https://tradingview.github.io/lightweight-charts/docs/release-notes).
- `@tradingview/lwc-toolkit` 1.0.0 is a plugin-authoring helper package, not a drawing-tools kit (its README in `packages/lwc-toolkit`).
- The library takes any bar spacing the app supplies, so 1-second candles are a data question, not a chart question (inference from the push model above).

#### 1.2 Advanced Charts

- Licence conditions: "Advanced Charts is available for free provided that the TradingView attribution remains visible and the implementation environment is public (not for private use or behind a paywall)" (https://www.tradingview.com/charting-library-docs/latest/introduction.md).
- Who may apply: "we don't provide the Advanced Charts and the Trading Platform libraries for personal use, hobbies, studies, or testing. These licenses are only available to companies for use in public web projects and/or applications" (FAQ on https://www.tradingview.com/free-charting-libraries/).
- The same comparison lists Advanced Charts as proprietary, 670 KB, "Free with TradingView logo"; only Trading Platform (paid, for brokers) has "Ability to disable branding".
- How to get it: submit the access request form on https://www.tradingview.com/advanced-charts/, then accept a GitHub invitation to the private `tradingview/charting_library` repository (https://www.tradingview.com/charting-library-docs/latest/quick-start.md).
- "The library is not redistributable. It is prohibited to use any part of the library in public repositories" (same quick-start page), so Top-pad's public repo could not hold it; a private package or a CI fetch would be needed (inference).
- Whether a launchpad qualifies: the licence text excludes no industry, and pump.fun ships it (section 1.4), so a launchpad run by a company with a public site appears to qualify; TradingView's decision on a specific application is **unverified**.
- Integration effort: the datafeed is a JavaScript object implementing the required methods `onReady`, `searchSymbols`, `resolveSymbol`, `getBars`, `subscribeBars` and `unsubscribeBars`, with callbacks invoked asynchronously and bar times in milliseconds (https://www.tradingview.com/charting-library-docs/latest/connecting_data/datafeed-api/required-methods.md, .../datafeed-api.md).
- The bundled UDF adapter speaks HTTP to a backend you write and "does not support real-time data streaming out of the box" (https://www.tradingview.com/charting-library-docs/latest/connecting_data.md).
- Second-based bars need `has_seconds: true` on the symbol, and `seconds_multipliers` lets the library build 5-second bars from 1-second data (`LibrarySymbolInfo` in https://www.tradingview.com/charting-library-docs/charting-library-context.txt).
- Codex's chart recipe returns bars in the same "response-as-a-table" shape "adapted from the TradingView documentation" (https://docs.codex.io/recipes/charts.md), which is the shape to copy for our own candle API.
- Features: 14+ chart types, 100+ indicators, 110+ drawing tools, custom indicators in JavaScript, symbol comparison, second resolutions (introduction page); the comparison page says "80+ smart drawing tools", which disagrees with the docs' 110+.
- Not supported in the library: Pine Script, alerts, strategy tester, bar replay and TradingView's own data (https://www.tradingview.com/charting-library-docs/latest/resources/Frequently-Asked-Questions.md).
- TradingView collects no user data through the self-hosted library and it sets no cookies (same FAQ).

#### 1.3 TradingView widgets (the brief's links)

- "Can I display my own data in the widgets? No. Widgets can only display data provided by TradingView, and we don't have an API for feeding your own data into them. If you need to display your own data, use one of our charting libraries instead" (https://www.tradingview.com/widget-docs/faq/data/).
- "Note that you cannot connect your data to the widgets" (https://www.tradingview.com/charting-library-docs/latest/product-comparison.md).
- The widgets' crypto coverage names "Meteora DYN (Solana), Meteora DLMM (Solana), Orca (Solana) ... Raydium (Solana), Raydium CLMM (Solana), Raydium CPMM (Solana)" and no DBC, DAMM v2 or pump venue (https://www.tradingview.com/widget-docs/markets/worldwide/).
- Live check: the three "Meteora DYN" pools sampled from TradingView are owned by `Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB`, the DAMM v1 program, so TradingView's Meteora coverage is DLMM and DAMM v1 only.
- Live check of TradingView's symbol search (`symbol-search.tradingview.com/symbol_search/v3`, an undocumented endpoint): exchange codes `METEORADLMM`, `METEORADYN`, `RAYDIUM`, `RAYDIUMCPMM`, `RAYDIUMCLMM` and `ORCA` exist; `METEORADBC`, `METEORADAMMV2`, `PUMPSWAP`, `PUMPFUN` and `LAUNCHLAB` return nothing.
- Live check: searching by pool address found the long-listed SOL-USDC DLMM pool `5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6`, but none of five DLMM pools 0.2 to 3.7 hours old with $28k to $480k of 24h volume, and none of seven aged 0.6, 0.95, 1.9, 4, 6.3, 14.9 and 30.7 days with over $100k of 24h volume.
- Conclusion: a brand-new Top-pad coin is invisible to the widgets on devnet always, on its DBC curve always, after graduation into DAMM v2 always, and on a DLMM pool for at least a month unless TradingView curates it; the listing criteria are undocumented (**unverified**).
- Widgets let a click open your own chart page through the "full-size chart URL" setting, and changing or removing the attribution needs TradingView's contact form (https://www.tradingview.com/widget-docs/faq/general/).
- A legitimate use: a ticker of SOL/USD or of the stock behind a stock-priced coin, both of which TradingView lists (inference).

#### 1.4 What the reference sites do

- pump.fun: a scrape of `https://pump.fun/coin/pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn` (plain `curl` gets a 403, so it went through Firecrawl) loads CSS and JS bundles from `tradingview/charting_library/bundles/` and a `tradingview/chart-custom.css`, and the only data hosts in the page are pump.fun's own (`frontend-api-v3`, `swap-api`, `swap`, `profile-api`, `livestream-api` under `pump.fun`).
  Which endpoint serves its candles was not identified (**unverified**).
- StonkFun: the token page `https://www.stonkfun.xyz/token/6GmAFSYs4gk3FDao5FzzySQpPZaWsa4rUJHacpMpUNgx` loads a bundle that calls `createChart(..., { layout: { attributionLogo: true } })` with a `CandlestickSeries` and fetches `https://datapi.jup.ag/v2/charts/${mint}?interval=...&candles=...&type=...&to=...`, throwing "Jupiter chart feed answered ..." on failure; its interval buttons are `1_MINUTE` to `1_DAY`; the home page loads `https://plugin.jup.ag/plugin-v1.js`.
- Meteora `fun-launch` scaffold: TradingView `charting_library` (type file only), data from `https://datapi.jup.ag` (`/v2/charts/{id}`, `/v1/holders/{id}`, `/v1/txs/{id}`) and live updates from `wss://trench-stream.jup.ag/ws` (KB `meteora/03-dev-dbc-vaults-launch.md`, "Fun Launch scaffold"; `tooling-and-live-checks.md`, "Embedding charts").
- Stoker (owner's LaunchLab launchpad): `apps/web/package.json` depends on `lightweight-charts ^5.2.1`; `apps/api/src/routes/trades.ts` builds candles with Postgres `date_bin` over its indexed `trades` table (1m to 1d, at most 500 candles); `apps/api/src/indexer.ts` and `helius.ts` feed that table from Helius webhooks.

### 2. Market data: candles, trades and holders

#### 2.1 The pool events our indexer decodes

All three programs have the same IDs on devnet and mainnet: DBC `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN`, DAMM v2 `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG`, DLMM `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo` (KB `meteora/03-dev-dbc-vaults-launch.md`, "Program ID cheat sheet"; `meteora/02-dev-dlmm-damm.md`, section 0).

| Program | Discovery | Trades and candles | Lifecycle |
| --- | --- | --- | --- |
| DBC | `EvtInitializePool`, `EvtInitializePoolWithTransferHook` | `EvtSwap2` (`trade_direction`, `swap_result` with `included_fee_input_amount`, `output_amount`, `next_sqrt_price`, `trading_fee`, `protocol_fee`, `referral_fee`, plus `quote_reserve_amount`, `migration_threshold`, `current_timestamp`); `EvtSwap2WithTransferHook` | `EvtCurveComplete` |
| DAMM v2 | `EvtInitializePool` | `EvtSwap2` (`trade_direction`, `swap_result` with `output_amount`, `next_sqrt_price`, fee split, plus `reserve_a_amount`, `reserve_b_amount`, timestamp) | `EvtLiquidityChange`, `EvtLockPosition`, `EvtPermanentLockPosition` |
| DLMM | `LbPairCreate` | `Swap2Evt` (preferred over `Swap`: start and end bin, `amount_in`, `amount_out`, fee fields) | `AddLiquidity`, `RemoveLiquidity` |

- Sources: KB `meteora/03-dev-dbc-vaults-launch.md` (DBC "Events" and "Indexing rules"), `meteora/02-dev-dlmm-damm.md` sections 1.10 and 2.12.
- DBC's graduation progress is `EvtSwap2.quote_reserve_amount / EvtSwap2.migration_threshold`, reconciled with `VirtualPool.quote_reserve`; the KB says never to reconstruct DBC price from token transfer logs.
- DLMM's program source is closed, so its events are decoded from the IDL in `MeteoraAg/dlmm-sdk` (KB section 1.1).
- DBC and DAMM v2 emit events through Anchor event CPI (`__event_authority`), except `EvtClaimProtocolFee2`, which is an `emit!` log (KB).
- Live check: recent devnet transactions of all three programs are `Swap2` instructions on devnet pools (DLMM pool `C3nQXmssWrnSnz8G8dsMDfAMmEAE5EgabCTA6eXxZSFp`, DAMM v2 pool `7bAsAfgcMjMPWGoBC6AEHtpW57JnVETWUHvk5iJtSLLV`, DBC pool `6chSuPpNuf21us7qRhH8LydP72NYgLmJBoxFK3wgaVye`), so the same decoder runs on both clusters.
- Holders: the indexer can keep balances from each transaction's pre and post token balances, and check them against the mint's token accounts read with standard RPC `getProgramAccounts` (inference); Helius DAS `getTokenAccounts` by mint is another source, and whether it serves devnet is **unverified**.

#### 2.2 Getting the events in, on devnet and mainnet

- Helius webhooks work on devnet: "If you create it through the Webhook API, set the 'webhookType' parameter to 'rawDevnet', 'enhancedDevnet' or 'discordDevnet'" (https://www.helius.dev/docs/faqs/webhooks.md).
- Webhook events cost 1 credit each and editing a webhook costs 100 credits; "Raw Transaction Webhooks offer lower latency since they do not involve parsing event types" (https://www.helius.dev/docs/webhooks.md).
- LaserStream gRPC: "LaserStream Devnet is available on all plans. LaserStream Mainnet access requires a Business or Professional plan" (https://www.helius.dev/docs/laserstream.md).
- LaserStream WebSocket has a devnet endpoint `wss://devnet.helius-rpc.com`, is "up to 200 ms faster than standard Agave RPC-based WebSockets" (Helius's claim), is metered at 2 credits per 0.1 MB, and its `transactionSubscribe` extension needs a paid plan, while `logsSubscribe` and `programSubscribe` work on all plans (https://www.helius.dev/docs/laserstream/websocket.md).
- Helius plans: Free $0 with 1M credits and 10 RPC req/s; Developer $49 with 10M; Business $499 with 100M; Professional $999 with 200M (https://www.helius.dev/docs/billing/plans.md).
- The public devnet RPC answered `getSignaturesForAddress` and `getTransaction` for all three programs without a key (live check), so a prototype can index with no provider at all.
- Latency for our own pipeline is set by the ingestion path and is not measured here (**unverified**); a websocket or gRPC stream at `processed` commitment is the low-latency option, webhooks the simplest.

#### 2.3 Meteora's data APIs

- Documented hosts: DLMM `https://dlmm.datapi.meteora.ag` (30 req/s) and DAMM v2 `https://damm-v2.datapi.meteora.ag` (10 req/s), with `/pools/{address}/ohlcv` and `/volume/history` (KB `meteora/02-dev-dlmm-damm.md` sections 1.12 and 2.14).
- Live check: the OHLCV `timeframe` accepts only `5m`, `30m`, `1h`, `2h`, `4h`, `12h`, `24h`; `timeframe=1m` returns 400 "unknown variant `1m`" (DAMM v2 host), and the DLMM OpenAPI lists the same set.
- Live check: the KB's "dev / devnet" hosts `https://dlmm.dev.metdev.io` and `https://damm-v2-api.dev.metdev.io` are not devnet indexes.
  Their `/pools` list starts with the mainnet SOL-USDC pool `5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6` (a plain system account on devnet), and both return 404 for the live devnet pools `C3nQXmssWrnSnz8G8dsMDfAMmEAE5EgabCTA6eXxZSFp`, `7ntovNjcy8FoECGBZPqzp3wjf8jRN6S3Wz6bwmywKY8a` (DLMM), `7bAsAfgcMjMPWGoBC6AEHtpW57JnVETWUHvk5iJtSLLV` and `74Q1g4nNU1M7ZSEG1KEaWNvGVUTELFFLVfYjJ8dxKWpr` (DAMM v2), as do the production hosts.
- Live check: an undocumented DBC data API exists at `https://dbc.datapi.meteora.ag` (OpenAPI "DBC API" 0.1.0 at `/api-docs/openapi.json`) with only `/pools` and `/pools/{address}`, 1,824,606 pools, fields `address`, `token_x`, `token_y`, vaults, `created_at`, `creator`, `pool_config_address`, and no price, volume or OHLCV.
  Sorted by `pool_created_at:desc`, its newest pool was 288 seconds old, so new pools appear within minutes; the devnet DBC pool above was 404.
- The live OpenAPI specs list more paths than the KB: DLMM adds `/stats/daily/protocol_fees`, `/stats/daily/trading_fees` and `/stats/daily/volume`; DAMM v2 adds `/pools/{address}/locked_positions`, `/wallets/{wallet}/open_positions`, `/wallets/{wallet}/closed_positions` and `/wallets/{wallet}/total`.
- Verdict: useful on mainnet for discovery and for long-range history of graduated pools, not for a launch-day chart (5-minute floor, nothing for the curve, nothing on devnet).

#### 2.4 Jupiter

- Jupiter's developer platform is documented as mainnet only (KB `jupiter/02-developer-platform-and-apis.md` section 1.1 and 16.2), and the live docs index https://developers.jup.ag/docs/llms.txt mentions no devnet.
- Tokens API v2 (documented): `MintInformation` carries `holderCount`, `launchpad`, `graduatedPool`, `graduatedAt`, `firstPool`, `audit` (`topHoldersPercentage`, `devBalancePercentage`, `devMints`, `isSus`), `organicScore`, `isVerified` and `stats5m` to `stats24h`; search costs 10 credits (KB section 3).
- Live check: `GET https://api.jup.ag/tokens/v2/search` (keyless) returned the DBC coin `EEwbGkjhJEQZiEUqbJBGbxKrdduWtZC3M2vdQgokB456`, created 2026-10-26T15:38:13Z, minutes later with `launchpad: "met-dbc"`, 190 holders and its graduated pool.
- Price API v3 has no history and omits untraded tokens (KB section 4.3).
- `datapi.jup.ag` is "not part of the documented developer platform (`api.jup.ag`), so it has no documented SLA, rate limit or versioning" (KB `tooling-and-live-checks.md`).
- Live check (keyless): `/v2/charts/{mint}?interval=1_SECOND|15_SECOND|1_MINUTE&to=...&candles=5&type=price` all returned 200 with `{candles: [{time, open, high, low, close, volume}]}`; `/v1/holders/{mint}` returned holders with `addressInfo.fundingAddress`, `fundingAmount`, `fundingTx` and `fundingBlockTime`; `/v1/txs/{mint}` returned trades with `type`, `traderAddress`, `isMev`, `poolId` and `timestamp`.
- Jupiter's SDK and API licence forbids "combining API content with scraped data" and requires "Powered by Jupiter" (KB section 13.4); whether `datapi.jup.ag` falls under that licence is **unverified**.

#### 2.5 Birdeye

- Plans: Standard free (30,000 compute units, 1 rps), Lite $39, Starter $99, Premium $199 ("Most APIs + Websockets", 500 websocket connections), Business $499 (https://data.birdeye.so/docs/guides/payment/pricing.md).
- Supported networks list Solana and other mainnets; no devnet is listed (https://data.birdeye.so/docs/resources/data-coverage/supported-networks.md).
- OHLCV V3 "Added 1s, 15s, and 30s intervals and no candle padding" (https://data.birdeye.so/docs/llms.txt).
- DEX coverage lists Meteora, Meteora DLMM, Meteora DAMM V2, Meteora Virtual Curve and Meteora Dynamic Bonding Curve (https://data.birdeye.so/docs/resources/data-coverage/dex-coverage.md).
- Holder endpoints (`/defi/v3/token/holder`, `/holder/v1/distribution`) are on every plan and `/wallet/v2/funded-by` from Lite up, all Solana only; websockets (`SUBSCRIBE_PRICE`, `SUBSCRIBE_TXS` and others) start at "Starter Plus" or Premium (https://data.birdeye.so/docs/guides/data-accessibility-by-packages.md).
- Indexing delay for a new DBC coin was not measured (no key; **unverified**).

#### 2.6 Codex

- GraphQL at `https://graph.codex.io/graphql`; Solana network id `1399811149`; the only testnets listed are Base Sepolia, Ethereum Sepolia and MegaETH Testnet (https://docs.codex.io/networks.md, https://docs.codex.io/networks/solana.md).
- Meteora DBC is a supported launchpad (`launchpadName: "MeteoraDBC"`) with creation, completion and migration tracking; launchpad event streams are "extremely high-frequency" and sold as a flat-rate add-on (https://docs.codex.io/launchpads/meteora.md).
- `getBars` and `onBarsUpdated` / `onTokenBarsUpdated` feed charts; `processed` commitment is available on Solana, fastest through the edge node `wss://fra.edge.codex.io/graphql` (https://docs.codex.io/recipes/charts.md, https://docs.codex.io/concepts/edge-nodes.md).
- Sub-minute resolutions `1S`, `5S`, `15S`, `30S` are kept for about 24 hours; "a new 1m or 5m bar can take several seconds to appear after its first trade" (https://docs.codex.io/api-reference/queries/getbars.md).
- Plans: Almost free $0 (10,000 compute units, 5 rps, $1 signup fee); Growth from $360/month for 3M compute units at 300 rps; WebSockets require Growth or Enterprise (https://www.codex.io/pricing, https://docs.codex.io/concepts/rate-limits.md).
- Token balances update "about 1.8s on average" after finalization (https://docs.codex.io/extra/faq.md).

#### 2.7 Mobula

- Plans: Free (10,000 credits, 1 rps), Start-up $50, Growth $400 with WSS feeds, Enterprise from $750; OHLCV history costs 5 credits; websockets cost 1 credit per minute open plus usage (https://docs.mobula.io/pricing.md).
- Its docs index offers token and market OHLCV, holder positions and a "Pulse" launchpad stream (https://docs.mobula.io/llms.txt); no Solana devnet was found there, and the chain list API needs a key (**unverified**).

#### 2.8 Side by side

| Source | Devnet | Finest candle | Real time | Covers a DBC curve from its first trade | Entry cost |
| --- | --- | --- | --- | --- | --- |
| Our indexer | Yes | Any (1s or ticks) | Yes, ours | Yes | Helius Free or the public devnet RPC; Developer $49 on mainnet |
| Meteora data APIs | No | 5m | Polling | No (DBC API has no prices) | Free, 10 to 30 rps |
| Jupiter Tokens v2 | No | None (stats windows) | Polling | Yes, minutes after launch | Free tier 1 rps |
| `datapi.jup.ag` | No | 1s | `trench-stream` websocket | Yes | Undocumented, no SLA |
| Birdeye | No | 1s | Websockets from Premium | Yes (lists DBC) | $199/month for websockets |
| Codex | No | 1S (kept about 24h) | Subscriptions from Growth | Yes (MeteoraDBC) | $360/month for websockets |
| Mobula | Not found | **unverified** | WSS from Growth | **unverified** | $400/month for WSS |

### 3. Routing

#### 3.1 Our own pools: direct swaps

- DBC `swap2` takes an optional `referralTokenAccount`; `PROTOCOL_FEE_PERCENT` (20%) of the trading fee goes to Meteora and `HOST_FEE_PERCENT` (20%) of that protocol fee goes to the referral account when one is passed (KB `meteora/03-dev-dbc-vaults-launch.md`, constants and fee split).
- DAMM v2 (`referralTokenAccount`) and DLMM (`host_fee_in`) pay the same 20% of the protocol fee to a referral account (KB `meteora/02-dev-dlmm-damm.md`, section 4 and build hooks).
- As the DBC config's partner, the launchpad earns its partner share of the curve's trading fee on every swap, whoever routes it (inference from the DBC partner role in the KB).
- A direct swap needs no aggregator, so it works on devnet and pays no Jupiter fee.
- Stoker's ADR 0003 has the server build every transaction and the browser only sign (`stonk-fun-solana/docs/adr/0003-server-built-transactions.md`); the same shape suits Top-pad, since any of our own rules (creator lock, sniper tax) can be added to the transaction there.

#### 3.2 Jupiter Swap API v2

- Two paths: `/order` + `/execute`, where Metis, JupiterZ RFQ, Dflow and OKX compete and Jupiter lands the transaction, and `/build`, Metis only, which returns raw instructions for your own transaction or CPI (https://developers.jup.ag/docs/swap/index.md).
- Fees on `/order`: 0 bps for Jupiter tokens and pegged assets, 2 bps SOL-stable, 5 bps LST-stable, 10 bps for everything else, "and 50 bps on tokens less than 24 hours old" (same page, FAQ).
- Integrator fee on `/order`: `referralAccount` + `referralFee` of 50 to 255 bps; "Jupiter keeps 20% of your fee and charges no separate platform fee"; referral token accounts must exist for each fee mint (same page; KB section 2.6).
- `/build` "has no Jupiter swap fee"; `platformFeeBps` (0 to 10000) with a `feeAccount` the integrator controls (https://developers.jup.ag/docs/api-reference/swap/build.md).
- Metis lists new markets instantly by token age on Meteora Dynamic Bonding Curve, Dynamic AMM, DAMM V2 and DLMM, and swaps a bonding-curve market for the graduated one (KB section 2.12).
- Live check (keyless, 2026-10-26): `/order` routed SOL into the on-curve DBC coin `5Cd9M3sw2gR64RZ7JMQLCYJexwAvHygiCk9XENXvXXWT` through "Dynamic Bonding Curve", and into `GrnhudjWwYWyvhT4mDrGdpLs5NyDU5tqdo1JM8Xgtps`, whose DBC pool was under 5 minutes old and already graduated, through "Meteora DAMM v2"; `/build` routed the latter too.
- Live check: those `/order` quotes carried `feeBps: 10`, not the documented 50 bps for tokens under 24 hours; which rule applies to real trades is **unverified**.
- Stoker verified `/build` inside its own transaction: ExactIn only, `otherAmountThreshold` as the only promise, and `maxAccounts` lowered to 36 to leave room for its own instruction (KB section 2.7).
- Licence: label the API "Metis" (or "Jupiter Ultra") and show "Powered by Jupiter" (KB section 13.4).
- The Jupiter Plugin swap widget is a client of Jupiter Ultra (KB section 10.1), so it cannot trade devnet pools either (inference).

#### 3.3 Titan

- Titan always returns instructions and lookup tables; the integrator builds, signs and lands the transaction; fees are `feeAccount` + `feeBps` on every swap, and "if omitted the default fee for your account is used"; whether Titan keeps a share of an integrator's fee is undocumented (KB `titan-exchange.md` sections 5.2, 11 and 11.0).
- Portal plans match Jupiter's rps ladder ($25, $100, $500), but exhausting credits is a hard stop (KB section 11.2).
- The Titan docs mirror in the KB (86 pages, 2026-10-07) never mentions devnet, and the Portal has a single mainnet hostname (KB section 3.3).
- Live check with the stored Portal key: `/api/v1/info` 200 (protocol 1.10.0, default `slippageBps` 100); `/api/v1/providers` lists only `Titan` and `Titan-DART`, not Metis or OKX; `/api/v1/venues` includes "Meteora DBC", "Meteora DAMM V2", "Meteora DLMM", "Raydium Launchlab", "PumpFun" and "Pump.fun Amm".
- Live check: Titan routed the on-curve DBC coin `5Cd9M3...` through "Meteora DBC", but answered `-7 NoRoutesFound` twice, about five minutes apart, for `GrnhudjW...` in its just-graduated DAMM v2 pool, which Jupiter routed.
- Live check: with `feeBps=100`, `feeFromInputMint=true` and an existing wSOL `feeAccount`, the quote succeeded and the fee account appeared in the swap instruction, but the documented `platformFee` field was absent from the route.

#### 3.4 Earning on routed trades

| Path | Who lands it | Devnet | Aggregator's cut | Our fee |
| --- | --- | --- | --- | --- |
| Direct swap on our pool | Us | Yes | None | Partner fee from the config, plus 20% of Meteora's protocol fee via referral |
| Jupiter `/build` | Us (own RPC or `tx.jup.ag` with a 0.001 SOL tip) | No | None documented | `platformFeeBps` into our `feeAccount` |
| Jupiter `/order` + `/execute` | Jupiter | No | 20% of our referral fee; no platform fee when referral is set | 80% of 50 to 255 bps |
| Titan Portal | Us | No | Undocumented | `feeBps` to `feeAccount` |

## Open points and unverified items

- Whether TradingView would grant Advanced Charts to Top-pad, and how long the application takes.
- Which endpoint feeds pump.fun's candles.
- Whether TradingView ever lists DLMM pools of new tokens, and on what criteria.
- Jupiter's real fee on tokens under 24 hours old (docs 50 bps, quotes 10 bps).
- Whether `datapi.jup.ag` use is covered or forbidden by Jupiter's API licence.
- Titan's share of integrator fees, why the `platformFee` field was missing, and whether a paid plan adds the Metis and OKX providers.
- Birdeye, Codex and Mobula indexing delay for a new DBC coin (no keys were available to test).
- Helius DAS holder queries on devnet.

## Questions for the map

- Aggregators reach our Meteora pools directly, so any rule that only our own program or our server enforces (a creator lock, a sniper tax, a humans-first window) does not apply to trades routed through Jupiter or Titan; which rules must therefore live in Meteora's own pool settings (fee scheduler, activation point, Alpha Vault)?
- Bundle Radar needs each buyer's funding source: build that graph ourselves from Helius transfer history, or lean on Jupiter's undocumented holder feed or Birdeye's `/wallet/v2/funded-by`?
- Advanced Charts needs a company running a public site: does the owner plan an entity before mainnet, and is that the trigger for the switch?
- Which candle resolutions do launch-day traders need (pump.fun-style 1-second and 15-second bars), and how long must sub-minute history be kept?
- Does the indexer run on Cloudflare like Stoker (webhooks only, no long-lived sockets) or on a host that can hold a LaserStream or websocket connection?
