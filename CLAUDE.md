# Top-pad

A fair-launch token launchpad on Solana, built on Meteora's pools.
The product is named **Heat** ([#65](https://github.com/imDev2023/top-pad/issues/65), formerly Greenflag); the code, its packages, Workers and database keep the working name `top-pad`.
The owner's original brief is `resources.md`; the project's terms are in `GLOSSARY.md`.

The build follows **`docs/spec.md`**, the one build-ready spec (decisions in `docs/adr/0001` to `0006`), as tickets labelled `build` (#39 to #64), sub-issues of the map wired with native blocking edges; the open ones with no open blocker are the frontier.
Each build ticket lands as its own PR, which the session merges itself once the ticket's devnet demo works end to end and CI is green (owner, 2026-10-29): `main` is fast-forwarded to the PR's head, so the commits keep the SHAs tickets cite; if `main` has moved, rebase the branch and wait for CI on the new head first.
The wayfinder map (GitHub issue #1, label `wayfinder:map`) indexes every decision and its `## Next` section names the next unit of work.
Start any session by reading that section: `gh issue view 1 --repo imDev2023/top-pad`.
The product stays separate from Stoker; merging is revisited only after the devnet cohort ([ADR 0001](docs/adr/0001-separate-product-from-stoker.md)).

For anything about Jupiter or Meteora, read the owner's canonical knowledge base first, not this repo and not the web: `/Volumes/Farhan/Work Folder/Dev/AI/Research-Projects/jupiter-meteora` locally, or https://github.com/imDev2023/jupiter-meteora-resources in the cloud.

## The build

A pnpm monorepo shaped like Stoker's: `apps/api` (Hono on Workers), `apps/web` (Next.js 16 on Workers through OpenNext, a pure client of the API), `packages/*` (`contract` the zod API contract, `db` Drizzle and its migrations, `clients` the Codama-generated Kit clients, `chain` Heat's own addresses per cluster and the Instant launch's instructions, `meteora` the only home of web3.js v1 and the config generator, `vamp-shield` the text rules and folded keys, `indexer` the decoding, trades and candles, `arweave` and `jobs` copied from Stoker commit `43e196b`), `programs/*` (the Anchor workspace) and `tests/*` (`devnet` and `ui`, both run by hand, and `x-stand-in`, a stand-in for X's OAuth).

- `docker compose up -d` starts the local Postgres (port 5452); `pnpm lint`, `pnpm typecheck` and `TEST_DATABASE_URL=postgres://toppad:toppad@127.0.0.1:5452/toppad pnpm test` are what CI runs, each test file on its own throwaway database.
- `pnpm programs` builds `tests/dbc-stand-in` (our stand-in for DBC's partner fee claim, never deployed, which the fee program's claim tests load in DBC's place, so it is built first: `anchor build`'s IDL step compiles those tests), then both programs, and copies the fee program's IDL to `packages/clients/idl` (CI fails if the build changes it); then `pnpm test:programs` runs their LiteSVM tests.
  `direnv exec . pnpm test:devnet` checks Meteora's accounts and Heat's two DBC configs on devnet, sends a real Instant launch with the creator's own buy, runs the fee claims against DBC (the window claim, the 50/50 split, a handover), runs a Fair Open's window and failure path with no Heat server (the program's refusals on chain, a missed minimum raise, an open 15 minutes late, every deposit and rent back to the lamport), and stops and restarts the indexer under `wrangler dev` on a throwaway database while trades land (about 0.15 SOL a run from Heat's devnet bank, signed with the keeper and admission keys only this Mac holds; the late open makes it about 20 minutes).
- A program is deployed only from a verified build (spec 5.2 records the fee program's): `solana-verify build --library-name <name> --arch v2 --cargo-build-sbf-args="--tools-version v1.57"` (0.5.2, in `~/.local/share/solana-verify-0.5.2/bin`; the flags match `pnpm programs`) in a clean clone of the commit, `solana program deploy` of that binary with `--program-id target/deploy/<name>-keypair.json --upgrade-authority ~/.config/top-pad/devnet/upgrade-authority.json --keypair ~/.config/top-pad/devnet/bank.json` (the bank pays the buffer and the rent), then `solana-verify verify-from-repo -u devnet` with the same flags and `-k` the upgrade authority, which rebuilds from GitHub and records the verification on chain.
  `pnpm --filter @top-pad/chain fee-config devnet [--send]` sets the fee program's `FeeConfig` with the upgrade authority, and `fair-open-config` the Fair Open program's `ProgramConfig`.
- Fair Opens are scheduled by script until the creator's scheduling flow exists: `pnpm --filter @top-pad/chain fair-open devnet [--in <seconds>] [--min-raise <SOL>] [--send]`, Heat's devnet bank the creator and the keeper co-signing; it prints the launch's page.
  The program's allocation must equal `@top-pad/chain`'s reference to the lamport: both test suites read `packages/chain/src/fixtures/allocations.json`, which `pnpm --filter @top-pad/chain allocation-cases` writes, and only when the rules change.
- Heat's devnet keys live outside the repo in `~/.config/top-pad/devnet`: the upgrade authority, the treasury, the keeper key, which is also the launch key, the admission key, which signs each Fair Open deposit's admission and holds no funds (spec 10.3), and the bank, which pays for every devnet test, script and deploy; `@top-pad/chain` records the treasury's, keeper's and admission signer's addresses.
- `pnpm --filter @top-pad/meteora configs devnet` simulates Heat's two DBC configs and `--send` creates them (devnet's exist, spec 3.2); a config can never be changed, only replaced, and its curve integers come only from `packages/meteora/src/configs.ts`, never by hand: DBC refused spec 3.3's first, real-valued ones (`InvalidTokenSupply`, #40).
- `pnpm --filter @top-pad/meteora idls` refreshes the pinned IDLs from the SDK packages, then `pnpm clients` regenerates `packages/clients/src/generated` (never edited by hand; CI fails if it is stale).
- Locally: `DATABASE_URL=postgres://toppad:toppad@127.0.0.1:5452/toppad pnpm db:migrate`, then start the API (port 8801) and the web app (port 3110) as the `webServer` entries in `tests/ui/playwright.config.ts` do, on devnet, the only cluster with Heat's configs; `pnpm --filter @top-pad/x-stand-in dev` stands in for X on port 8890.
- `direnv exec . pnpm --filter @top-pad/tests-ui e2e` runs the launch flow, a coin's first minute of trades, the fee claims (the keeper's window claim, the creator's page claiming exactly what it shows, a handover) and a Fair Open's window and failure from its page end to end with that stand-in (the config's header says what else is real), reusing servers already up, and photographs every step into `tests/ui/test-results/shots`; `e2e:devnet` runs it against the deployed devnet site; both spend devnet SOL (about 0.4 a run) and run by hand, never in CI.
  `E2E_LATE=1` makes the Fair Open fail 15 minutes after its open rather than on a missed minimum raise, about 20 minutes more.
- The indexer is a Durable Object in the API Worker (spec 10.2): `GET /indexer` says how it stands and which version it runs, and starts it, which locally nothing else does (the cron does on devnet); `DATABASE_URL=... pnpm --filter @top-pad/indexer check-candles` compares every coin's candles with a rebuild from its trades.
- The keeper's Workflow sends each Instant launch's window claim at 60 s (spec 10.2); `wrangler dev` runs it locally, where `curl localhost:8801/cdn-cgi/local/explorer/api/workflows/top-pad-instant-launches/instances` lists its instances and `curl localhost:8801/cdn-cgi/local/scheduled` runs the cron, whose sweep catches any coin a keeper missed; on devnet, `env -u CLOUDFLARE_API_TOKEN pnpm exec wrangler workflows instances list top-pad-instant-launches-devnet` in `apps/api`.
- Devnet: `direnv exec "<this folder>" pnpm deploy:devnet` migrates the Neon devnet database (`DATABASE_URL` in the gitignored `.env`), then deploys the X stand-in, the API and the web Worker, in that order; the devnet demo is https://top-pad-web-devnet.imdev2023.workers.dev, its API https://top-pad-api-devnet.imdev2023.workers.dev.
  The devnet API's one secret is `RPC_URL` (the Helius devnet URL), and its keeper and admission keys are `top-pad-devnet-keeper-key` and `top-pad-devnet-admission-key` in the account's Secrets Store; locally the e2e config passes both as vars from `~/.config/top-pad/devnet`.
  Until Heat has its own X app (owner, 2026-10-29), the devnet API links X through the stand-in's Worker, `top-pad-x-stand-in-devnet`, named by four vars in `apps/api/wrangler.jsonc`; the real app replaces them with the secrets `X_CLIENT_ID` and `X_CLIENT_SECRET`.

## Traps

- Research findings live on `research/<name>` branches, pushed and never merged, so `main` does not hold them; read one with `git show origin/research/<name>:research/<name>.md`.
  Prototypes live the same way on `prototype/<name>` branches (`fair-open-creation-tx`, `screens-mockup`).
- An agent started with worktree isolation is refused any git or gh command its guard cannot prove stays in its own worktree: `cd` followed by git, loops, `source` or `.` of an env file, and even `git -C` on its own worktree path (likely the space in `Work Folder`).
  What works: one plain command per call, plain `git <cmd>` from the worktree itself, `git -C /private/tmp/claude-501/...` read-only commands on clones in the scratchpad (allowed in `~/.claude/settings.json`), and API keys through `direnv exec "<this folder>" <cmd>`.
- Auto mode refuses some writes outright: a batch of `gh issue edit` calls across many tickets (2026-10-28; single edits and comments go through), deleting a branch, even a merged one, and Cloudflare secret writes, `wrangler secret put` and creating the Secrets Store alike (2026-10-29).
  Hand the owner one `!` command, or one batch drafted in the scratchpad, reading any secret through `$(cat <file>)` or a pipe so it never lands in shell history; refetch an issue's body just before writing it, so a newer edit is not overwritten.
  Creating a Secrets Store secret is the exception on this Mac: a rule in the local `.claude/settings.local.json` allows `env -u CLOUDFLARE_API_TOKEN pnpm exec wrangler secrets-store secret create` (owner, 2026-10-30), so run it from `apps/api` with `--value "$(cat <key file>)"` before handing the owner anything.
- A PR body's `Closes #N` closes the ticket when `main` is fast-forwarded, and `gh issue close --comment` on a closed ticket drops its comment: post the closing record with `gh issue comment`.
- Of the RPC endpoints in `global.env` only the shared Helius key serves Solana devnet (the Chainstack and Validation Cloud URLs are other chains', QuickNode has a token but no endpoint), on a free tier that sends 1 transaction per second and is rate-limited when agents run in parallel (spec 10.5).
  Solana's public endpoints answer a Worker with 403, "Your IP or provider is blocked", even under `wrangler dev` (2026-10-29), so the API always needs `RPC_URL`, while Node code such as the tests defaults to the public `api.devnet.solana.com`, which answers bursts with 429 and at times refuses WebSockets: send through `tests/devnet/src/devnet.ts`, which retries on 429 and confirms over HTTP, and stagger on-chain-heavy work.
- `turbo-gateway.com` serves a fresh Turbo upload at once, `arweave.net` only once Turbo has bundled it onto Arweave, minutes later (spec 16), so coins' metadata URIs name `turbo-gateway.com`.
- Write a non-ASCII test string as `\u{...}` escapes: agents' file tools have written `\uXXXX` escapes to disk as the raw character, which puts invisible or lookalike characters in source.
- Never download, dump or commit Meteora's program binaries: Meteora suggested on 2026-10-28 (#26) that tests run against its deployed devnet programs, so Surfpool, which runs them locally, stays out too.
  Cloning Meteora's repos pulls them in anyway (`tests/fixtures/*.so`, SDK `artifacts/*.so`): read source on GitHub, or delete those files the moment a clone lands.
- Devnet SOL is scarce: CLI airdrops are refused, and faucet.solana.com gives at most 10 SOL every 8 hours (spec 11.4); the owner collects it into Heat's devnet bank, `Ew6E318g8SYCSjCUdRqcpSywRUzuFUPoxLAQWYfZD933` (`~/.config/top-pad/devnet/bank.json`).
  Nothing of Heat's spends from the Solana CLI's default wallet (owner, 2026-10-30): the scripts take `BANK_KEYPAIR` to pay from another, and a `solana` command that sends takes `--keypair` the bank.
- Build the programs with `pnpm programs`, never a bare `anchor build`: Anchor 1.2.1 defaults to SBPF v3, which neither devnet nor mainnet has activated (2026-10-27), and the program tests fail on a v3 binary.
  The program ids are fixed, `HeatF…` (fee) and `HeatP…` (Fair Open) ([#65](https://github.com/imDev2023/top-pad/issues/65), spec 5.1), and their keypairs exist only in this Mac's gitignored `target/deploy` and the owner's password manager (spec 10.3), so a fresh checkout builds with random ones and warns of a mismatch, which is expected: never "fix" it with `anchor keys sync`, which writes the random ids into the source.
- Anchor 1.2.1 is pinned in `Anchor.toml` (`[toolchain]`), so avm's `anchor` runs it here while the machine's default stays 0.31.1 for other projects; `avm install` switches the default, so run `avm use 0.31.1` after installing another version.
- Codama's output for the DBC IDL is not clean on its own; `packages/clients/scripts/generate.ts` fixes the IDL first (see its comment), so always generate through `pnpm clients`.
- The devnet database is Neon project `odd-firefly-70405620` (London, Postgres 17 like docker and CI), behind the Hyperdrive named in `apps/api/wrangler.jsonc`, whose query cache is off (spec 10.4); `npx neonctl` needs `--org-id org-wispy-snow-11801955` on every command or it stops at an interactive prompt.
  Its free plan's 100 compute-hours a month last only while it sleeps between requests, so anything that queries it on a timer keeps it awake: the indexer reconciles against the chain first and opens the database only for something new (spec 16).
- The Cloudflare token in `global.env` cannot use Hyperdrive or Secrets Store; the owner's wrangler login can, so run those commands with the token unset (`env -u CLOUDFLARE_API_TOKEN pnpm exec wrangler hyperdrive ...`).
  Deploys work with the token, except the API's: binding its Secrets Store secret fails with code 10021, so `@top-pad/api`'s `deploy:devnet` unsets the token itself.
- A Durable Object busy with a socket and an alarm, as the indexer always is, can go on running the code before a deploy for minutes (2026-10-29: it decoded none of the window claims sent after the deploy that taught it claims). The API deploys with `--durable-objects-code-update-mode immediate`, and the indexer resets itself when the Worker calling it runs another version: after a deploy, `GET /indexer` should name the deploy's version.
- The indexer passes over every transaction it has indexed before, so a deploy that teaches it events in transactions it had already indexed through another watched account must index that account's history again, or those events are never recorded: `DATABASE_URL=... RPC_URL=... pnpm --filter @top-pad/indexer reindex <cluster> <account>`.
  On 2026-10-30 every `create_launch` had been indexed through Heat's Fair Open config, so #45's first deploy met each launch's failure with no launch to fail, and its reconciliation stopped there until the Fair Open program was indexed again.
- The owner's Discord (Meteora ticket `devlaunch-6428`, Jupiter `#dev-support`) runs in Brave, reachable through the Claude in Chrome extension, not the Discord desktop app.

## Agent skills

### Issue tracker

Issues, the wayfinder map and the build tickets live in GitHub issues on `imDev2023/top-pad`. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context. See `docs/agents/domain.md`.

## Multica dashboard

This project is mirrored on the owner's Multica dashboard (workspace Pandora) as project `2525b9a3-ec70-47d8-9d09-140deece218d`.
The GitHub issues on `imDev2023/top-pad` stay the source of truth; Multica only mirrors them.
At the end of every session, after the tracker is updated, run the `multica-sync` skill for this project: mirror ticket statuses, add any new tickets, and refresh the project's "Current step" section.
Every Multica write passes `--no-start` and no ticket is ever assigned to an agent, so the sync never starts an agent run.
If the `multica` CLI is not signed in, say so in the session summary and stop anyway; the sync never blocks the work.
