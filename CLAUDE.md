# Top-pad

A fair-launch token launchpad on Solana, built on Meteora's pools.
The product was named **Greenflag**, and the owner wants a new name (2026-10-27, [#65](https://github.com/imDev2023/top-pad/issues/65)); the code, its packages, Workers and database use the working name `top-pad`, so the rename touches no code.
The owner's original brief is `resources.md`; the project's terms are in `GLOSSARY.md`.

Planning is finished: the build starts from **`docs/spec.md`**, the one build-ready spec (decisions in `docs/adr/0001` to `0006`).
The wayfinder map (GitHub issue #1, label `wayfinder:map`) indexes every decision and its `## Next` section names the next unit of work.
Start any session by reading that section: `gh issue view 1 --repo imDev2023/top-pad`.
The build runs as tickets labelled `build` (#39 to #64), sub-issues of the map wired with native blocking edges; the open ones with no open blocker are the frontier.
Greenflag stays a separate product from Stoker; merging is revisited only after the devnet cohort ([ADR 0001](docs/adr/0001-separate-product-from-stoker.md)).

For anything about Jupiter or Meteora, read the owner's canonical knowledge base first, not this repo and not the web: `/Volumes/Farhan/Work Folder/Dev/AI/Research-Projects/jupiter-meteora` locally, or https://github.com/imDev2023/jupiter-meteora-resources in the cloud.

## The build

A pnpm monorepo shaped like Stoker's: `apps/api` (Hono on Workers), `apps/web` (Next.js 16 on Workers through OpenNext, a pure client of the API), `packages/*` (`contract` the zod API contract, `db` Drizzle and its migrations, `clients` the Codama-generated Kit clients, `meteora` the only home of web3.js v1, `arweave`, `jobs` and `indexer` copied from Stoker commit `43e196b`), `programs/*` (the Anchor workspace) and `tests/*`.

- `docker compose up -d` starts the local Postgres (port 5452); `pnpm lint`, `pnpm typecheck` and `TEST_DATABASE_URL=postgres://toppad:toppad@127.0.0.1:5452/toppad pnpm test` are what CI runs, each test file on its own throwaway database.
- `pnpm programs` builds both programs, then `pnpm test:programs` runs their LiteSVM tests; `pnpm test:devnet` reads Meteora's real accounts on devnet with the generated clients.
- `pnpm --filter @top-pad/meteora idls` refreshes the pinned IDLs from the SDK packages, then `pnpm clients` regenerates `packages/clients/src/generated` (never edited by hand; CI fails if it is stale).
- Locally: `DATABASE_URL=postgres://toppad:toppad@127.0.0.1:5452/toppad pnpm db:migrate`, then `pnpm exec wrangler dev --port 8801` in `apps/api` and `NEXT_PUBLIC_API_URL=http://localhost:8801 pnpm exec next dev --port 3110` in `apps/web`.

## Traps

- Research findings live on `research/<name>` branches, pushed and never merged, so `main` does not hold them; read one with `git show origin/research/<name>:research/<name>.md`.
  Prototypes live the same way on `prototype/<name>` branches (`fair-open-creation-tx`, `screens-mockup`).
- An agent started with worktree isolation is refused any git or gh command its guard cannot prove stays in its own worktree: `cd` followed by git, loops, `source` or `.` of an env file, and even `git -C` on its own worktree path (likely the space in `Work Folder`).
  What works: one plain command per call, plain `git <cmd>` from the worktree itself, `git -C /private/tmp/claude-501/...` read-only commands on clones in the scratchpad (allowed in `~/.claude/settings.json`), and API keys through `direnv exec "<this folder>" <cmd>`.
- Never download, dump or commit Meteora's program binaries (Meteora's 2026-10-27 reply in #26 did not cover them, so the rule stands).
  Cloning Meteora's repos pulls them in anyway (`tests/fixtures/*.so`, SDK `artifacts/*.so`): read source on GitHub, or delete those files the moment a clone lands.
- The devnet build runs on free-tier RPC (spec 10.5): the shared Helius free key sends 1 transaction per second and is rate-limited when agents run in parallel, so prefer a Chainstack or QuickNode devnet endpoint and stagger on-chain-heavy work.
- Devnet SOL is scarce: CLI airdrops are refused, and faucet.solana.com gives at most 10 SOL every 8 hours (spec 11.4); the owner collects it into `3hTTgfj2YqqYJeEgSF49U8ZyZwyHnwPhF9LRsXy4fMY8`.
- Build the programs with `pnpm programs`, never a bare `anchor build`: Anchor 1.2.1 defaults to SBPF v3, which neither devnet nor mainnet has activated (2026-10-27), and the program tests fail on a v3 binary.
  The program ids in the source are temporary until the product is named ([#65](https://github.com/imDev2023/top-pad/issues/65)); the keypairs are in `target/deploy` only, so a fresh checkout's build warns of a mismatch, which is expected.
- Anchor 1.2.1 is pinned in `Anchor.toml` (`[toolchain]`), so avm's `anchor` runs it here while the machine's default stays 0.31.1 for other projects; `avm install` switches the default, so run `avm use 0.31.1` after installing another version.
- Codama's output for the DBC IDL is not clean on its own; `packages/clients/scripts/generate.ts` fixes the IDL first (see its comment), so always generate through `pnpm clients`.
- The devnet database is on Neon (spec 10.4), not Supabase: the owner's two free Supabase projects are Stoker's.
- The Cloudflare token in `global.env` cannot use Hyperdrive or Secrets Store; the owner's wrangler login can, so run those commands with the token unset (`env -u CLOUDFLARE_API_TOKEN pnpm exec wrangler hyperdrive ...`).
- Of the RPC endpoints in `global.env`, only the Helius key serves Solana devnet (the Chainstack and Validation Cloud URLs are other chains', and QuickNode has a token but no endpoint), so the devnet tests default to the public `api.devnet.solana.com`.
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
