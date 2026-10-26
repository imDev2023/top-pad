# What should the prototype be built on?

Research for Top-pad's wayfinder map, ticket [#9](https://github.com/imDev2023/top-pad/issues/9), captured 2026-10-26.
It compares three bases for a devnet prototype that grows into the mainnet product: (a) Meteora's fun-launch scaffold, (b) reusing parts of Stoker, and (c) a new codebase.
It is judged on quality, robustness, simplicity and long-term maintainability, not on build speed (owner, 2026-10-26).
Every claim names its source; code claims name the file, and the repository commit is listed under "Sources" at the end.
Anything not checked against a primary source is marked **unverified**.

## Answer

Build a new codebase (c).
Seed it with the parts of Stoker that are chain-agnostic and already proven (the Arweave package, the webhook-plus-backfill indexer pattern, the job runner, the black-box test stack and its Wallet Standard test wallet), and use fun-launch only as a reference for screens and for the shape of Meteora SDK calls.
Neither existing base can launch both a DLMM Fair Open with an Alpha Vault and a DBC curve today: fun-launch does DBC only, and Stoker does Raydium only.
Fun-launch also cannot run on devnet as a product, because every data and trading feature it has is a Jupiter mainnet service.

### The three bases compared

| Criterion | (a) fun-launch scaffold | (b) Stoker parts | (c) New codebase |
| - | - | - | - |
| DBC launch | Yes: one `POOL_CONFIG_KEY`, `client.creator.createPool` (`pages/api/upload.ts`), on DBC SDK `^1.5.11`, a major version behind 2.0.0 | No: LaunchLab and CPMM only (`packages/chain/src/programs.ts`) | Yes, through a DBC adapter on DBC SDK 2.x |
| DLMM Fair Open with Alpha Vault | No; Meteora's studio CLI has the steps as keypair scripts, not as a product | No | Yes, through a DLMM plus Alpha Vault adapter and a durable launch orchestrator |
| Works on devnet as a product | No: explore, token pages, holders, trades and swaps all read Jupiter mainnet services (`datapi.jup.ag`, `trench-stream.jup.ag`, `plugin.jup.ag`), and the wallet adapter is fixed to `mainnet-beta` (`pages/_app.tsx`) | The pattern does: Stoker runs a devnet rehearsal with its own Helius devnet webhook (Stoker `CLAUDE.md`, run-and-test notes) | Yes, by design |
| Own indexer and database | None | Yes: raw Helius webhook, fast path, backfill, idempotent writes into Postgres | Yes, reusing Stoker's pattern with Meteora decoders |
| Own on-chain program | None | None, by design ("No custom on-chain program", Stoker `CLAUDE.md`) | Yes: an Anchor program for the rules Meteora cannot enforce |
| Tests | None in the repository; CI runs format, lint, build and typecheck (`.github/workflows/ci.yml`) | Black-box backend suite on a throwaway stack, Playwright with a Wallet Standard test wallet, pixel baselines | Stoker's test approach from the first commit |
| Safety of what is there | Unauthenticated upload route that overwrites any mint's image and metadata; a relay route with simulation commented out; a hard-coded third-party R2 URL | Strong, but its trust model (off-chain Creator Forward, one hot wallet holding every role) is the opposite of Top-pad's promise | Designed around Top-pad's rule that the chain enforces, not the server |
| Coupling to replace | Jupiter data layer, R2 metadata, single config | Everything in `packages/chain`, most of `apps/api` and the database schema are LaunchLab-specific | None |
| Licence | MIT in `LICENSE.md`, ISC in `package.json` | The owner's own code (repository has no licence file) | The owner's |

### Recommendation per layer

| Layer | Choice | Why |
| - | - | - |
| Web app | Next.js 16 App Router on Cloudflare Workers through OpenNext, a pure client of our API, TypeScript, Wallet Standard wallets | Proven by Stoker in production on the same host (`apps/web/wrangler.jsonc`, `open-next.config.ts`); a pure client keeps every Meteora SDK and its churn out of the browser; server-rendered token pages give share previews |
| Transactions | The API builds and simulates every transaction and the wallet only signs (Stoker ADR 0003's shape) | One place for Meteora SDK upgrades and for the fast-path indexing; the reason is maintainability, not licence (Meteora's SDKs are MIT or ISC), and it is never a security boundary, because anyone can build their own transaction |
| Backend | TypeScript Hono API on Workers, zod contract package shared with the web app, Drizzle on Postgres through Hyperdrive | Stoker's proven shape (`apps/api`, `packages/contract`, `packages/db`); D1's 10 GB per-database cap that cannot be raised is a poor fit for every trade of every launch (Cloudflare KB `build/03-storage-database.md`) |
| Indexer | Decode Meteora events ourselves from pinned IDLs; ingest from Helius raw devnet webhooks plus a client fast path plus RPC reconciliation; add a LaserStream (Yellowstone gRPC) consumer before mainnet if Bundle Radar needs complete intra-slot ordering | Webhooks are cheap and work on devnet but can lose events after three retries; Helius's parsed products are mainnet-only and its catalog lags DBC; a gRPC stream gives slot order, the in-block `index` and 48 hours of replay |
| Launch orchestration | Cloudflare Workflows for the Fair Open lifecycle, Cron Triggers for sweeps, Durable Objects for live trade fan-out | A Fair Open is a timed sequence (pool, seed, vault, deposit window, fills, activation, vesting); Workflows persist each step, retry it and sleep until a timestamp (Cloudflare KB `web3-launch-playbook.md` 4.6) |
| Metadata | Image and JSON on Arweave through ArDrive Turbo, signed at prepare time, uploaded after the launch lands; R2 only as a cache | Stoker ADR 0008 and `packages/arweave` are chain-agnostic and proven; fun-launch's mutable R2 objects can be overwritten by anyone |
| On-chain program | Anchor 1.2.x in Rust, CPI through `declare_program!` from pinned IDLs, LiteSVM or Mollusk unit tests and Surfpool integration tests against dumped Meteora binaries | Every Meteora program is an Anchor program and every CPI path Meteora publishes is Anchor; Anchor's account constraints are what auditors read; Pinocchio has no IDL or CPI generation for calling Anchor programs; Anchor v2 is an unpublished alpha |
| Hosting | Cloudflare: Workers (web, API, webhook), Workflows, Durable Objects, Queues, Cron, R2, KV (Alpha Vault Merkle proofs if a permissioned vault is used), Hyperdrive to Postgres, and a Container only for a gRPC consumer | The owner's standing platform (Stoker ADR 0002) with a canonical knowledge base; Containers are the documented home for a Yellowstone gRPC consumer (Cloudflare KB `build/01-compute.md`) |

### What to take from each base

- From Stoker, copy and adapt: `packages/arweave` (ANS-104 items and Turbo's HTTP API, no Raydium code), the webhook receiver with a timing-safe secret and the idempotent indexer with fast path and backfill cursor (`apps/api/src/index.ts`, `src/indexer.ts`), the job runner with `job_runs`, `job_locks` and operator alerts, the API-key and rate-limit modules, Token-2022 transfer-fee math (`packages/chain/src/transferFee.ts`), the unsigned v0 transaction and temporary wSOL helpers (`packages/chain/src/wallet.ts`), the test stack (`tools/stack`, `tools/localnet`) and the Wallet Standard test wallet (`tests/ui/src/wallet.ts`).
- From Stoker, take as lessons rather than code: the traps in its `CLAUDE.md` about Workers (six connections waiting at once, send in small batches with a fresh blockhash), Helius (raw payload shape, new addresses take minutes to deliver), Surfpool and secrets.
- From fun-launch, take as reference only: the explore grid, the token page layout (chart, holders, trades, bonding-curve bar) and the DBC create call; rebuild them against our own API.
- From Meteora's studio, take the DLMM launch-pool, seeding and Alpha Vault call sequences (`studio/src/actions/dlmm/*.ts`, `studio/src/actions/alpha_vault/*.ts`) as the reference for the DLMM adapter.

### What must not be carried over from Stoker

- The off-chain Creator Forward as a trust model (Stoker ADR 0009): it is a promise the server makes, which is what Top-pad exists to avoid.
- One hot operations wallet holding every authority (Stoker ADR 0004): on Top-pad, authorities that decide who may buy or what a creator may sell belong to program PDAs or a multisig, and hot keys only pay fees and crank.
- Everything LaunchLab-specific: `packages/chain` launch, curve, CPMM, lock and migration code, the curve-rule bands and Quote Registry (ADR 0005), Reward Tax and Reward Rounds (ADR 0006), the Fee Key collector.
- Stoker's brand, design tokens, copy and anything derived from StonkFun's copy (Stoker `CLAUDE.md` traps), since Top-pad is a separate product (Top-pad ADR 0001).
- Any key, address, database reference, webhook id or environment value from Stoker's runbooks.
- The Raydium SDK: it is GPL-3.0 (npm `@raydium-io/raydium-sdk-v2` 0.2.75-alpha), and Stoker's production code does not import it (a search of `apps`, `packages`, `tools` and `tests` finds it only in comments and in a UI test that forbids it), but its spike does (`spike/launchlab-devnet/README.md`), so no spike code should be copied.

### Not verified here

- That `declare_program!` in Anchor 1.2 compiles cleanly against Meteora's current DLMM, Alpha Vault and DBC IDLs; nothing was built.
- That Meteora's TypeScript SDKs (web3.js v1, `@coral-xyz/anchor` 0.31) run inside a Worker; Stoker's analogous stack does, but Meteora's was not tested.
- Whether the "Meteora Non-commercial Licence" on the DBC and DAMM v2 program repositories affects compiling their `cpi` crates into a commercial program (see "Licences").
- Stoker ADR 0008's statement that Irys retires its Arweave endpoints on 2026-11-01; no primary source was found.
- Devnet availability of Yellowstone gRPC providers other than Helius.

## Evidence

### 1. The fun-launch scaffold

Read from `MeteoraAg/meteora-invent` at commit `dd77ef3`, folder `scaffolds/fun-launch`, plus the owner's knowledge base (`jupiter-meteora/meteora/01-products-and-protocol.md` section 14.8 and `03-dev-dbc-vaults-launch.md` "Fun Launch scaffold").

What it is:

- A Next.js 15 pages-router app with React 19, Tailwind, TanStack, jotai, `@jup-ag/wallet-adapter`, `@meteora-ag/dynamic-bonding-curve-sdk ^1.5.11` and `@aws-sdk/client-s3` (`package.json`).
- Three pages: explore (`pages/index.tsx`), create (`pages/create-pool.tsx`) and token (`pages/token/[tokenId].tsx`), and two API routes (`pages/api/upload.ts`, `pages/api/send-transaction.ts`).
- The README deploys it to Vercel.

How it launches:

- The browser generates the mint keypair (`create-pool.tsx` line 70), posts the logo, name, symbol, mint and wallet to `/api/upload`, partially signs the returned legacy `Transaction` with the mint key, has the wallet sign, and posts it to `/api/send-transaction`.
- The server uploads `images/<mint>.<ext>` and `metadata/<mint>.json` to R2 and builds `client.creator.createPool` on the one `POOL_CONFIG_KEY` (`upload.ts` lines 108 to 194).
- So it supports DBC launches on one partner config and nothing else: no DLMM, no Alpha Vault, no DAMM v2 launch pool.

Where its data comes from:

- Token lists, pools, holders, charts, trades and descriptions come from `https://datapi.jup.ag` (`components/Explore/client.ts` line 16).
- Live updates come from `wss://trench-stream.jup.ag/ws` (`contexts/DataStreamProvider.tsx` line 9).
- The chart library is loaded from `https://static.jup.ag/tv/charting_library/charting_library.js` (`components/TokenChart/TokenChart.tsx` lines 64 and 82).
- Trading is the Jupiter Plugin loaded from `https://plugin.jup.ag/plugin-v1.js` (`pages/_document.tsx` line 8, `components/Terminal/index.tsx`).
- The wallet provider is configured with `env: 'mainnet-beta'` (`pages/_app.tsx` line 31).
- The knowledge base records that Jupiter is deployed on mainnet only, with no devnet deployment documented (`jupiter-meteora/jupiter/02-developer-platform-and-apis.md` lines 83 and 1930).
- Consequence: on devnet a fun-launch fork can create a pool, but its explore page, token page, holders, trades, chart and swap show nothing, and it has no data of its own to compute a Fairness card or Bundle Radar from.

Quality and safety, from reading the code (not exercised end to end):

- `/api/upload` has no authentication and takes the mint address from the request body, then writes `metadata/<mint>.json` and `images/<mint>.<ext>` with `PutObjectCommand`, which replaces an existing object (`upload.ts` lines 66 to 82 and 149 to 161).
  The on-chain URI points at that same mutable object, so anyone who posts a launched coin's mint can replace its image and metadata.
- The public URL written into the metadata is hard-coded to `https://pub-85c7f5f0dc104dc784e656b623d999e5.r2.dev` (`upload.ts` line 26), a bucket a fork does not own; the knowledge base flags the same gotcha.
- `/api/send-transaction` relays any signed transaction, logs the whole request body, and has simulation commented out (`send-transaction.ts` lines 20 and 31 to 48).
- `next.config.ts` sets `typescript.ignoreBuildErrors` and `eslint.ignoreDuringBuilds` to true; the repository's CI does run a typecheck that includes the scaffold (`tsconfig.typecheck.json`, `.github/workflows/ci.yml`).
- No test files exist anywhere in the repository.
- The DBC SDK range `^1.5.11` cannot reach SDK 2.0.0, which syncs with DBC program 0.2.2 and moves config creation to `create_config2` (`dynamic-bonding-curve-sdk` `packages/dynamic-bonding-curve/CHANGELOG.md`, "2.0.0 - 2026-10-10").
- Licence: `LICENSE.md` is MIT ("Copyright (c) 2025 Meteora"), while the root and scaffold `package.json` say ISC.

Verdict: a good picture of what a Meteora launchpad's screens contain, and a poor base, because its data layer, metadata storage and transaction relay would all be replaced and it covers one of Top-pad's two launch mechanisms.

### 2. Meteora's studio as the DLMM and Alpha Vault reference

- The same repository's `studio` workspace has scripts for every step of a DLMM launch pool and its Alpha Vault: `dlmm-create-pool`, `dlmm-seed-liquidity-lfg`, `dlmm-seed-liquidity-single-bin`, `dlmm-set-pool-status`, `alpha-vault-create`, `alpha-vault-deposit`, `alpha-vault-crank-fill`, `alpha-vault-claim` and more (`studio/package.json`; knowledge base section 14.2).
- They are config-file-driven CLI actions signed by a local keypair file (knowledge base section 14.1), useful as call sequences, not as product code.
- Seeding only works before pool activation (knowledge base section 14.3).
- Alpha Vault fills are permissionless during pre-activation, a non-whitelisted cranker pays 0.0001 SOL per fill, and fills swap with `minimum_amount_out = 0` (knowledge base section 6.5), so the crank is part of the product.
- The studio's localnet validator loads compiled binaries of all Meteora programs, including the closed-source DLMM (`lb_clmm.so`) and Alpha Vault (`alpha_vault.so`), from `studio/src/tests/artifacts`.
  It runs DLMM under `LbVRzDTvBDEcrthxfZ4RL6yiq3uZw8bS6MwtdY6UhFQ` and Alpha Vault under `SNPmGgnywBvvrAKMLundzG6StojyHTHDLu7T4sdhP4k`, not the mainnet and devnet ids (`studio/package.json`, script `start-test-validator`), so tests of our program would either build with localnet ids or load binaries dumped from devnet under their real ids.
- The studio uploads metadata through `@metaplex-foundation/umi-uploader-irys` (`studio/src/helpers/metadata.ts` line 2); if Stoker's date for Irys retiring its Arweave endpoints is right (unverified), that path stops working on 2026-11-01.

### 3. Stoker: how coupled each part is

Read from the local checkout `/Volumes/Farhan/Work Folder/Dev/AI/stonk-fun-solana` on 2026-10-26 (read-only; `main` on GitHub was `715be49` at the time), especially `CONTEXT.md`, `CLAUDE.md`, `docs/adr/0001` to `0010`, `apps/`, `packages/`, `tests/`, `tools/` and `spike/`.

What Stoker is: a launchpad on Raydium LaunchLab with "No custom on-chain program: our own LaunchLab `PlatformConfig` plus a Cloudflare backend and a Next.js app" (`CLAUDE.md` line 4).

| Part | Size | Coupling to LaunchLab | Use for Meteora DLMM and DBC |
| - | - | - | - |
| `packages/chain` | about 3,400 lines | High: IDLs and coders for LaunchLab, CPMM and Raydium's lock (`src/coder.ts`), their program ids (`src/programs.ts`), launch, curve, trade, migration, revenue and decode modules | Rewrite as a Meteora adapter; keep `transferFee.ts`, `wallet.ts`, `lookup.ts` and the Jupiter route helper |
| `packages/arweave` | about 300 lines | None: ANS-104 data items signed with ed25519 and ArDrive Turbo's HTTP endpoints, one dependency (`@noble/curves`) | Reuse as is |
| `packages/contract` | about 1,300 lines | Medium: the zod pattern is generic, the schemas describe LaunchLab launches, quote assets, reward rounds and burns | Reuse the pattern, write new schemas |
| `packages/db` | 587-line schema, 21 migrations | Medium to high: `curves`, `quote_assets`, `graduations`, `reward_*`, `fee_keys` are LaunchLab or Stoker concepts; `job_runs`, `job_locks`, `operator_alerts`, `api_keys`, `api_key_usage`, `metadata_uploads`, `arweave_top_ups`, `ledger_entries` are generic | Reuse the generic tables and Drizzle setup, new domain tables |
| `apps/api` | about 6,700 lines | Mixed: `index.ts` (Hono, webhook auth, fast path), `jobs.ts`, `apiKeys.ts`, `metadata.ts` and `helius.ts` are generic; `launch.ts`, `graduation.ts`, `quotes/`, `fees/`, `rewards/`, `burn/` are LaunchLab or Stoker economics | Reuse the skeleton and infrastructure modules, new domain modules |
| `apps/web` | Next.js 16 on OpenNext, pure API client | Low in architecture, high in content: Stoker's brand, tokens and contract | Reuse the architecture, not the UI |
| `tests/backend`, `tests/ui` | 23 backend test files and 15 UI spec files, plus their harnesses | The harness is generic; the tests are Stoker's behaviour | Reuse the harness, the throwaway stack approach and `tests/ui/src/wallet.ts` |
| `tools/localnet`, `tools/stack` | about 1,750 lines | `tools/localnet` boots Raydium fixtures; `tools/stack` (Postgres, chain, API, stand-ins for Helius's webhook API and Turbo) is generic | Reuse `tools/stack`; rewrite `tools/localnet` for Meteora binaries |
| `spike/launchlab-devnet` | spike | Raydium only, uses the GPL Raydium SDK | Do not copy |
| `spike/turbo-workers` | spike | None | Its findings back the Arweave choice |

Details that matter for reuse:

- The indexer receives raw Helius payloads, checks the `authorization` header with a timing-safe compare, indexes idempotently, and answers 500 for a batch it could not fully index so Helius delivers it again (`apps/api/src/index.ts` lines 163 to 197).
- A client fast path, `POST /v1/transactions/:signature`, indexes a confirmed transaction the browser reports, so the site does not wait for the webhook (`index.ts` lines 199 to 208).
- A backfill reads an account's history with `getSignaturesForAddress` from a stored cursor and never moves the cursor past a transaction it could not index (`apps/api/src/indexer.ts` `indexAccountHistory`).
- New addresses are added to the webhook through Helius's API with a read-then-replace `PUT /v0/webhooks/:id` (`apps/api/src/helius.ts`).
- The pattern maps directly onto DBC: DBC's `swap` names the partner `config` account (`dynamic-bonding-curve` `programs/dynamic-bonding-curve/src/instructions/swap/ix_swap.rs`, `SwapCtx`), so one watched address catches every launch and curve trade on our config, as Stoker's PlatformConfig does; each graduated DAMM v2 pool is added afterwards, as Stoker adds each CPMM pool.
- DLMM launch pools are separate pairs, and a DLMM swap names the pair, its reserves, mints and oracle but no launchpad-wide account (knowledge base `02-dev-dlmm-damm.md` line 649, `swap2` accounts), so every pair and its Alpha Vault must be added to the watch list when created.
- ADR 0002 names Queues and Durable Objects, but the API's `wrangler.jsonc` binds only Hyperdrive, R2 and five Cron Triggers; nothing in Stoker exercises Queues, Durable Objects or Workflows.
- ADR 0003 kept server-built transactions because the Raydium SDK is GPL-3.0; Stoker's `packages/chain` ended up building instructions from IDLs with Anchor's `BorshCoder` and has no Raydium SDK dependency (`packages/chain/package.json`, `src/coder.ts`).

### 4. A new codebase: what a clean design looks like

A sketch of the seams, to be settled by the map's "Backend design" and "our own program" items:

- `programs/top-pad` (Rust, Anchor): the rules Meteora's programs cannot enforce, calling DLMM, Alpha Vault, DBC and DAMM v2 through `declare_program!` modules generated from pinned IDL files.
- `packages/meteora` (TypeScript, server-only): one adapter per launch mechanism, `dbc` and `dlmm-fair-open`, each turning a launch plan into unsigned transactions and each decoding its program's events into domain events; the only package that imports Meteora SDKs or Anchor.
- `packages/contract` (zod) and `packages/db` (Drizzle, Postgres), shared as in Stoker.
- `packages/arweave`, copied from Stoker.
- `apps/api` (Hono on Workers): prepare endpoints, webhook receiver, fast path, read API, Workflows for each Fair Open, Cron Triggers for reconciliation, Durable Objects for live trades.
- `apps/web` (Next.js on OpenNext): a pure client.
- `apps/stream` (optional, before mainnet): a TypeScript LaserStream consumer in a Cloudflare Container, forwarding raw transactions to the same indexer entry point the webhook uses.
- `tools/stack` and `tools/localnet`: Postgres, a local chain with Meteora's binaries and our program, the API and stand-ins, so backend and UI suites run black-box from day one.

Why the Meteora SDKs stay behind one adapter:

- They are pinned to web3.js v1 and `@coral-xyz/anchor` 0.31 (npm metadata: DBC SDK 2.0.0 depends on `@solana/web3.js ^1.98.0` and `@coral-xyz/anchor ^0.31.0`; `@meteora-ag/dlmm` 1.9.14 on `@coral-xyz/anchor 0.31.0`).
- web3.js v1 is now maintenance-only: `@solana/web3.js` 3.0.0 shipped on 2026-10-01 as the `latest` tag, "rebuilds the internals on Solana Kit", and "Version 1.x is no longer actively maintained and receives critical fixes only" (npm README of 3.1.1).
- Anchor 1.0 renamed its TypeScript package from `@coral-xyz/anchor` to `@anchor-lang/core` (Anchor `CHANGELOG.md`, 1.0.0, PR 4141).
- `@meteora-ag/alpha-vault` 1.1.16 depends on `@meteora-ag/dlmm` 1.5.0 while the current DLMM SDK is 1.9.14, and on an Anchor 0.28 alias (npm metadata), so two DLMM SDK versions end up in the tree.
- `@meteora-ag/dlmm` lists `express` as a runtime dependency, used by `ts-client/src/server/index.ts`.
- Keeping all of this in one server-side package means one place to upgrade, and lets hot paths later move to clients generated from the IDLs (for example with Codama, whose `@codama/nodes-from-anchor` package is meant for Anchor IDLs; not tried here) without touching the rest.

### 5. Indexer options

| Option | Devnet | Ordering and completeness | Cost and plan | Fit |
| - | - | - | - | - |
| Helius raw webhook | Yes: webhook types `rawDevnet`, `enhancedDevnet`, `discordDevnet` (Helius webhooks FAQ) | No ordering promise; duplicates possible; retried "up to 3 times with a 1-second gap", after which "the event is permanently lost" (Helius webhooks FAQ) | 1 credit per event, 100 credits per webhook edit (Helius webhooks docs); up to 100,000 addresses per webhook (FAQ) | Prototype ingestion, with reconciliation |
| Helius enhanced webhook and Enhanced Transactions API | Yes for webhooks | Parsed by Helius | Enhanced Transactions is "legacy, maintenance mode", succeeded by Parsed Events (Helius `llms.txt`) | Avoid |
| Helius Parsed Streams and Parsed Events | No: served from the Gatekeeper host `beta.helius-rpc.com`, "Mainnet only for now"; Parsed Events' base URL is mainnet (Helius `llms.txt`) | Decoded through Helius's IDL catalog | 1 credit per event, all plans (Parsed Streams quickstart) | Not on devnet; and the catalog lags DBC (below) |
| Helius LaserStream gRPC | "LaserStream Devnet is available on all plans" | Yellowstone-compatible stream, up to 48 hours of replay from a chosen slot (Helius LaserStream docs) | Mainnet "requires a Business or Professional plan" (same page); Business is $499 a month (Helius RPC docs) | Mainnet ingestion if Bundle Radar needs it |
| Other Yellowstone gRPC providers (Triton, QuickNode, Chainstack, GetBlock, RPCFast) | Unverified | Same protocol: each transaction update carries `slot` and its in-block `index` (`yellowstone-grpc` `geyser.proto`, `SubscribeUpdateTransactionInfo`) | Varies; the owner's env has QuickNode and Chainstack keys but no Triton key | A second source or fallback |
| RPC history (`getTransactionsForAddress`) | Yes (Helius devnet RPC) | Returns `slot` and `transactionIndex` per transaction, sortable ascending (Helius RPC docs) | 10 credits per 100 full transactions, Developer plan and up (same page) | Reconciliation and backfill |
| Jupiter data API (fun-launch's source) | No (mainnet only, knowledge base) | Jupiter's view of all launchpads | n/a | Not ours to control |

Findings that decide the shape:

- Decode Meteora events ourselves from pinned IDLs.
  Helius's catalog decodes `lb_clmm`, `dynamic_bonding_curve`, `alpha_vault`, `cp_amm` and `presale` (a `describeProgram` call to `wss://fs-beta.helius-rpc.com`, run 2026-10-26), but its DBC entry lists 28 instructions including `claim_protocol_fee` and `zap_protocol_fee` and lacks `create_config2`, the transfer-hook instructions and `claim_protocol_fee2`.
  `zap_protocol_fee` arrived in DBC 0.1.10, transfer hooks in 0.2.0, the removal of `claim_protocol_fee` in 0.2.1 and `create_config2` in 0.2.2 (knowledge base `03-dev-dbc-vaults-launch.md` changelog table; `dynamic-bonding-curve` `CHANGELOG.md`), so the catalog matches DBC 0.1.10, three releases behind the program.
  DBC and DLMM emit Anchor event-CPI events (knowledge base `03-dev-dbc-vaults-launch.md` line 55), which an Anchor coder decodes from the transaction's inner instructions, as Stoker's `packages/chain/src/decode.ts` does for LaunchLab.
- Treat webhooks as a doorbell, not a ledger: because a delivery can be lost after three failed retries, a reconciliation job must re-read each watched account's history from a cursor, which is Stoker's backfill pattern made permanent rather than limited to a window after Graduation.
- Bundle Radar and zero-block detection need to know which buys landed in the launch slot and in what order; the standard `getTransaction` result that raw webhooks deliver carries the slot but no position in the block, which comes from Yellowstone's `index` or from `getTransactionsForAddress`'s `transactionIndex`.
- A gRPC stream cannot run inside a Worker isolate; the Cloudflare knowledge base names "a Solana geyser or Yellowstone gRPC consumer" as a Container workload, checkpointing the last slot to durable storage because instances can be stopped by host restarts (`build/01-compute.md` lines 1882 to 1885).
- Helius takes minutes to start delivering a newly added webhook address (Stoker `CLAUDE.md` traps; runbook section 7), which matters for DLMM pairs created minutes before a deposit window; a gRPC subscription can instead be updated on the open stream (unverified for LaserStream specifically).

Recommendation: on devnet, a raw webhook on our DBC config, our program and each DLMM pair and Alpha Vault, plus the fast path, plus a reconciliation job on `getTransactionsForAddress`; before mainnet, decide with ticket #5 whether Bundle Radar needs a LaserStream consumer, and if so run it in a Container feeding the same indexer.

### 6. The on-chain program framework

What Meteora's programs and published CPI paths use:

- DBC builds with Anchor 1.0.2 and Solana 3.1.10 (`dynamic-bonding-curve` `Anchor.toml` and `README.md`).
- DLMM's IDL is an Anchor IDL (`metadata.spec` 0.1.0, version 0.12.0, address `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo`, `dlmm-sdk` `idls/dlmm.json`); Meteora's own Rust crate CPIs into it with `declare_program!(dlmm)` (`dlmm-sdk` `commons/src/lib.rs` line 5).
- Alpha Vault's interface crate is five lines: `declare_program!(alpha_vault)` over its IDL (`alpha-vault-sdk` `programs/alpha-vault/src/lib.rs`), IDL version 0.4.1, spec 0.1.0.
- Meteora's `cpi-examples` (Anchor 0.31, last pushed 2025-04-05) uses `declare_program!` for DLMM, DAMM v1, Dynamic Vault and M3M3 (`programs/cpi-example/src/lib.rs` lines 8 to 11), including DAMM v1, which is built with Anchor 0.29 (knowledge base section 13.4), so the caller's Anchor version does not have to match the callee's.
- DLMM and Alpha Vault are closed source; only their IDLs and SDKs are public (knowledge base section 1.1 and `github-repos.md`).

Constraints our program inherits from Meteora (knowledge base `02-dev-dlmm-damm.md` 1.9 and `03-dev-dbc-vaults-launch.md` "Rust integration"):

- Event-CPI instructions need the `event_authority` and `program` accounts.
- DBC's `enableFirstSwapWithMinFee` requires pool initialization earlier in the same top-level transaction, so a CPI-only path is not eligible.
- DBC's rate-limiter fee mode checks the instructions sysvar (`FailToValidateSingleSwapInstruction`), and migrations involve nested CPIs that Meteora advises doing as top-level SDK transactions.
- The Alpha Vault's authority-managed mode lets the vault authority create an escrow with a per-wallet `max_cap` for a chosen wallet (`create_permissioned_escrow_with_authority`, knowledge base section 6.4 and the Alpha Vault CPI table); whether our program's PDA can hold that authority is a question for the program-scope item.

Options:

| Framework | Status | CPI into Meteora | Audit-friendliness | Maintenance |
| - | - | - | - | - |
| Anchor 1.x | `anchor-lang` 1.2.1, released 2026-10-05; 1.0.0 shipped 2026-04-02 (Anchor `CHANGELOG.md`) | `declare_program!` from the IDL generates typed CPI calls, accounts and events; it gained an instruction parser in 1.0 | Account constraints (owner, seeds, `has_one`, discriminators) are declarative; 1.x disallows duplicate mutable accounts by default, checks the owner on account reload and re-runs ownership checks on lazy accounts after a CPI (`CHANGELOG.md` 1.0.0 and 1.2.0); `security.json` metadata and verified builds through OtterSec's registry (1.1.1, 1.2.0) | Repository now lives at `otter-sec/anchor` (crates.io metadata; GitHub redirects `coral-xyz/anchor` and `solana-foundation/anchor` there), Apache-2.0, pushed 2026-10-25; the announcement of the move was not found (unverified) |
| Pinocchio | `pinocchio` 0.11.2 (crates.io, last updated 2026-06-09), Anza, Apache-2.0 | No IDL-driven CPI: discriminators, argument encoding and account metas are written by hand, or generated with a tool that does not target Pinocchio (unverified that one exists) | Fewer abstractions, so every owner and signer check is hand-written and reviewed line by line; no audit statement in the README | Pre-1.0, `no_std`, zero-dependency design |
| Anchor v2 | Alpha on the `anchor-next` branch with no published crates; its compatibility notes map v1 types onto Pinocchio's `AccountView` (Anchor v2 docs) | Not documented on the get-started page | Unknown while alpha | Claims up to 94 or 95% smaller binaries and roughly 3 to 50 times fewer compute units (the page's title and banner differ); AVM cannot manage it yet |

Recommendation: Anchor 1.2.x.
Our program is small and sits beside or wraps Meteora's Anchor programs, so the deciding factors are typed CPI from Meteora's IDLs, declarative account checks an auditor can follow, and a maintained toolchain, not compute units, which DLMM's and Alpha Vault's own work dominates.
Revisit Anchor v2 once it publishes stable crates, since the port is mostly renames (Anchor v2 docs).

Testing the program:

- Unit tests in LiteSVM (Anchor 1.0's default `anchor init` template) or Mollusk, integration in Surfpool (Anchor 1.0's default for `anchor test` and `anchor localnet`) (`CHANGELOG.md` 1.0.0).
- Load DLMM, Alpha Vault, DBC and DAMM v2 binaries dumped from devnet under their real ids, or Meteora's localnet artifacts with feature-flagged ids (section 2).
- Pin each IDL file in the repository with its source and version, and refresh deliberately when Meteora ships a release.

### 7. Hosting

- Stoker runs the web app on Workers through OpenNext and the API, webhook receiver and five Cron Triggers on Workers, with Postgres (Supabase) through Hyperdrive and R2 (`apps/web/wrangler.jsonc`, `apps/api/wrangler.jsonc`, `CLAUDE.md` traps on Hyperdrive and Supabase).
- The Cloudflare knowledge base's reference architecture for a launchpad uses the same pieces plus Durable Objects with hibernatable WebSockets for live trades, Queues for confirmation pipelines and Workflows for launch steps (`web3-launch-playbook.md` 4.1 to 4.7).
- Workflows persist each step's result, retry with backoff, sleep up to 365 days and wait for events (`web3-launch-playbook.md` 4.6), which matches a Fair Open's timeline better than Stoker's per-minute crons.
- KV is eventually consistent for up to 60 seconds, so nothing a buyer's money depends on in the next minute should be read from it; Meteora's own pattern serves Alpha Vault Merkle proofs from KV (`web3-launch-playbook.md` 4.4 and 6.1; `MeteoraAg/cloudflare-kv-merkle-proof`).
- Worker limits that shape the backend: six connections waiting for headers at once, `waitUntil` capped at 30 seconds, 15 minutes for crons, queue consumers and alarms (`web3-launch-playbook.md` 8.2), and Stoker's lesson to send transactions a few at a time with fresh blockhashes (`CLAUDE.md` traps).
- Containers need the Workers Paid plan, cold-start "often in the 1-3 second range", have no fixed maximum runtime but can be stopped by host restarts, and bill per 10 ms of activity (`build/01-compute.md` section 3).
- Fun-launch's README deploys to Vercel; on Cloudflare a Next.js app runs through OpenNext (`web3-launch-playbook.md` 6.1).

### 8. Licences

| Component | Licence | Source |
| - | - | - |
| `meteora-invent` (studio and fun-launch) | MIT in `LICENSE.md`; ISC in `package.json` | Repository files |
| DBC program repository | "Meteora Non-commercial Licence" (`license.md`): permitted purposes are noncommercial, personal research or use by named noncommercial organisations "save for any organization which is affiliated with a blockchain project or protocol" | `dynamic-bonding-curve` `license.md` |
| DAMM v2 program repository | "Meteora Noncommercial Licence" | `damm-v2` licence file via the GitHub API |
| DBC TypeScript SDK repository and npm package | MIT | GitHub API; `package/LICENSE` in the npm tarball |
| DAMM v2 SDK | MIT | npm, GitHub API |
| `@meteora-ag/dlmm`, `@meteora-ag/alpha-vault` | ISC on npm; their GitHub repositories have no licence file | npm metadata, GitHub API |
| `MeteoraAg/cpi-examples` | No licence file | GitHub API |
| Anchor | Apache-2.0 (`@coral-xyz/anchor` is MIT OR Apache-2.0) | GitHub API, npm |
| Pinocchio | Apache-2.0 | GitHub API |
| `@raydium-io/raydium-sdk-v2` | GPL-3.0 | npm metadata |
| `rpcpool/yellowstone-grpc` (server) | AGPL-3.0; its Node client `@triton-one/yellowstone-grpc` is Apache-2.0 | GitHub API, npm |
| `helius-laserstream`, `helius-sdk` | MIT | npm |
| Hono, `@opennextjs/cloudflare` | MIT | npm |
| Drizzle ORM, `lightweight-charts`, `@ardrive/turbo-sdk` | Apache-2.0 | npm |

What follows (not legal advice):

- Calling a deployed program on-chain does not copy its code; compiling the DBC or DAMM v2 crates with their `cpi` feature into our program would.
  Generating CPI bindings with `declare_program!` from the IDL shipped in the MIT DBC SDK repository (`packages/dynamic-bonding-curve/src/idl/`) avoids depending on the non-commercially licensed crates; whether that fully settles the question is unverified and worth one question to Meteora.
- The DLMM and Alpha Vault IDLs come from SDK repositories without a licence file but from npm packages marked ISC; the same caution applies.
- The GPL issue that drove Stoker's ADR 0003 does not arise with Meteora's SDKs.

## Questions the findings raise for the map

- Licence: does Meteora's non-commercial licence on the DBC and DAMM v2 program repositories restrict a commercial launchpad from using their CPI crates or IDLs, and will Meteora confirm in writing that IDL-generated bindings are fine?
- Indexer completeness: does Bundle Radar (ticket #5) need every buy in the launch slot in exact in-block order within seconds, which on mainnet means a LaserStream Business plan or another Yellowstone provider, or are webhooks plus reconciliation enough?
- Program authority on DLMM: can our program's PDA be the Alpha Vault authority (authority-managed escrows with per-wallet caps), the DLMM pool creator with `creator_pool_on_off_control`, or the pre-activation swap address, so the creator lock and anti-bundling caps are enforced on-chain?
- Testing closed-source programs: dump DLMM and Alpha Vault from devnet under their real ids, or build our program with localnet ids to use Meteora's studio artifacts?
- Shared code with Stoker: copy the generic modules (Arweave, job runner, test wallet) into Top-pad, or extract them into a package both repositories consume, which keeps ADR 0001's option C cheaper but couples two products' release cycles?
- Client libraries: accept web3.js v1 inside the Meteora adapter until Meteora moves, or generate Kit clients from the IDLs now?

## Sources

Repositories (commit read):

- `MeteoraAg/meteora-invent` `dd77ef3d5aede3f0ff21d566d052097200417f5e` (2026-09-20): `scaffolds/fun-launch`, `studio`, `skills/meteora/references/scaffolds.md`, `LICENSE.md`, `.github/workflows/ci.yml`, `tsconfig.typecheck.json`.
- `MeteoraAg/dynamic-bonding-curve` `91e696eef6a3764157220f6c104f079b7830fc04` (2026-10-16): `CHANGELOG.md`, `license.md`, `Anchor.toml`, `README.md`, `programs/dynamic-bonding-curve/src/instructions/swap/ix_swap.rs`, `programs/dynamic-bonding-curve/src/lib.rs`.
- `MeteoraAg/dlmm-sdk` `af36dd53ab180783ccecda306926189a4700953c` (2026-10-23): `idls/dlmm.json`, `commons/src/lib.rs`, `commons/Cargo.toml`, `Anchor.toml`, `ts-client/src/server/index.ts`.
- `MeteoraAg/alpha-vault-sdk` `1bfa0c8277b336d5ee80e698970696bab5829873` (2026-10-22): `idls/alpha_vault.json`, `programs/alpha-vault/src/lib.rs`, `programs/alpha-vault/Cargo.toml`, `Anchor.toml`.
- `MeteoraAg/cpi-examples` `3326f57fb616c5a310920aa4d2c22073eb3dc6fb` (2025-04-05): `Anchor.toml`, `programs/cpi-example/src/lib.rs`.
- `MeteoraAg/dynamic-bonding-curve-sdk` (GitHub API, 2026-10-26): `packages/dynamic-bonding-curve/CHANGELOG.md`, licence.
- `MeteoraAg/damm-v2` `5398b5c7c534de014091132da37c6478cce671a8`: licence file.
- `otter-sec/anchor` `85c5293e7a01aa43b9cf015986bd7c7188ed4a74`: `CHANGELOG.md`, `README.md`.
- `anza-xyz/pinocchio` (GitHub API, 2026-10-26): `README.md`.
- `rpcpool/yellowstone-grpc` `master` (2026-10-26): `yellowstone-grpc-proto/proto/geyser.proto`.
- Stoker, local checkout read-only on 2026-10-26 (`imDev2023/Stoker-Markets` `main` at `715be49665a0aed39a41b9901fee1d1aea21fcb5`): `CONTEXT.md`, `CLAUDE.md`, `docs/adr/0001` to `0010`, `docs/runbooks/mainnet.md` section 7, `apps/api/src/index.ts`, `apps/api/src/indexer.ts`, `apps/api/src/helius.ts`, `apps/api/wrangler.jsonc`, `apps/web/wrangler.jsonc`, `packages/*/package.json`, `packages/chain/src/{index,programs,coder,transferFee,wallet}.ts`, `packages/db/src/schema.ts`, `tests/ui/src/wallet.ts`, `tools/localnet/src/index.ts`, `spike/*/README.md`.

Documentation and registries (fetched 2026-10-26):

- Helius: https://www.helius.dev/docs/webhooks , https://www.helius.dev/docs/faqs/webhooks.md , https://www.helius.dev/docs/laserstream , https://www.helius.dev/docs/parsed-streams/quickstart.md , https://www.helius.dev/docs/api-reference/parsed-streams/describeprogram.md , https://www.helius.dev/docs/llms.txt , https://www.helius.dev/docs/api-reference/rpc/http-methods ; plus a live `describeProgram` query for the five Meteora program ids.
- Anchor v2: https://v2.anchor-lang.com/docs/v2/get-started/
- crates.io API for `anchor-lang`, `pinocchio`, `litesvm`, `mollusk-svm`; npm registry metadata for every package named above, including the README of `@solana/web3.js` 3.1.1.
- The owner's knowledge bases (canonical copies): `Research-Projects/jupiter-meteora` (`meteora/01-products-and-protocol.md` sections 1, 6, 13.4 and 14; `meteora/02-dev-dlmm-damm.md`; `meteora/03-dev-dbc-vaults-launch.md`; `jupiter/02-developer-platform-and-apis.md`; `github-repos.md`) and `Research-Projects/cloudflare` (`web3-launch-playbook.md`, `build/01-compute.md`, `build/03-storage-database.md`).
