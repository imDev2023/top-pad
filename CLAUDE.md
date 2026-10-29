# Top-pad

A fair-launch token launchpad on Solana, built on Meteora's pools.
The product is named **Heat** (owner, 2026-10-28, [#65](https://github.com/imDev2023/top-pad/issues/65); it was Greenflag until 2026-10-27); the code, its packages, Workers and database keep the working name `top-pad`.
The owner's original brief is `resources.md`; the project's terms are in `GLOSSARY.md`.

The build follows **`docs/spec.md`**, the one build-ready spec (decisions in `docs/adr/0001` to `0006`), as tickets labelled `build` (#39 to #64), sub-issues of the map wired with native blocking edges; the open ones with no open blocker are the frontier.
Each build ticket lands as its own PR, which the session merges itself once the ticket's devnet demo works end to end and CI is green (owner, 2026-10-29): `main` is fast-forwarded to the PR's head, so the commits keep the SHAs tickets cite; if `main` has moved, rebase the branch and wait for CI on the new head first.
The wayfinder map (GitHub issue #1, label `wayfinder:map`) indexes every decision and its `## Next` section names the next unit of work.
Start any session by reading that section: `gh issue view 1 --repo imDev2023/top-pad`.
The product stays separate from Stoker; merging is revisited only after the devnet cohort ([ADR 0001](docs/adr/0001-separate-product-from-stoker.md)).

For anything about Jupiter or Meteora, read the owner's canonical knowledge base first, not this repo and not the web: `/Volumes/Farhan/Work Folder/Dev/AI/Research-Projects/jupiter-meteora` locally, or https://github.com/imDev2023/jupiter-meteora-resources in the cloud.

## The build

A pnpm monorepo shaped like Stoker's: `apps/api` (Hono on Workers), `apps/web` (Next.js 16 on Workers through OpenNext, a pure client of the API), `packages/*` (`contract` the zod API contract, `db` Drizzle and its migrations, `clients` the Codama-generated Kit clients, `chain` Heat's own addresses per cluster (program ids, the fee claimer PDA, the DBC configs), `meteora` the only home of web3.js v1 and the config generator, `arweave`, `jobs` and `indexer` copied from Stoker commit `43e196b`), `programs/*` (the Anchor workspace) and `tests/*`.

- `docker compose up -d` starts the local Postgres (port 5452); `pnpm lint`, `pnpm typecheck` and `TEST_DATABASE_URL=postgres://toppad:toppad@127.0.0.1:5452/toppad pnpm test` are what CI runs, each test file on its own throwaway database.
- `pnpm programs` builds both programs, then `pnpm test:programs` runs their LiteSVM tests; `pnpm test:devnet` reads Meteora's real accounts on devnet with the generated clients, and Heat's two DBC configs field by field.
- `pnpm --filter @top-pad/meteora configs devnet` simulates Heat's two DBC configs, and `--send` creates them; devnet's exist (spec 3.2), and a config can never be changed, only replaced by new ones recorded in `@top-pad/chain`.
- `pnpm --filter @top-pad/meteora idls` refreshes the pinned IDLs from the SDK packages, then `pnpm clients` regenerates `packages/clients/src/generated` (never edited by hand; CI fails if it is stale).
- Locally: `DATABASE_URL=postgres://toppad:toppad@127.0.0.1:5452/toppad pnpm db:migrate`, then `pnpm exec wrangler dev --port 8801` in `apps/api` and `NEXT_PUBLIC_API_URL=http://localhost:8801 pnpm exec next dev --port 3110` in `apps/web`.
- Devnet: `direnv exec "<this folder>" pnpm deploy:devnet` migrates the Neon devnet database (`DATABASE_URL` in the gitignored `.env`), then deploys the API and the web Worker, in that order; the devnet demo is https://top-pad-web-devnet.imdev2023.workers.dev, its API https://top-pad-api-devnet.imdev2023.workers.dev.

## Traps

- Research findings live on `research/<name>` branches, pushed and never merged, so `main` does not hold them; read one with `git show origin/research/<name>:research/<name>.md`.
  Prototypes live the same way on `prototype/<name>` branches (`fair-open-creation-tx`, `screens-mockup`).
- An agent started with worktree isolation is refused any git or gh command its guard cannot prove stays in its own worktree: `cd` followed by git, loops, `source` or `.` of an env file, and even `git -C` on its own worktree path (likely the space in `Work Folder`).
  What works: one plain command per call, plain `git <cmd>` from the worktree itself, `git -C /private/tmp/claude-501/...` read-only commands on clones in the scratchpad (allowed in `~/.claude/settings.json`), and API keys through `direnv exec "<this folder>" <cmd>`.
- In auto mode, a batch of `gh issue edit` calls across many tickets was refused as an external write (2026-10-28) while single comments went through: draft the new bodies in the scratchpad, ask the owner once for the whole batch, and refetch each body before writing so a newer edit is not overwritten.
- Never download, dump or commit Meteora's program binaries: Meteora suggested on 2026-10-28 (#26) that tests run against its deployed devnet programs, so Surfpool, which runs them locally, stays out too.
  Cloning Meteora's repos pulls them in anyway (`tests/fixtures/*.so`, SDK `artifacts/*.so`): read source on GitHub, or delete those files the moment a clone lands.
- The devnet build runs on free-tier RPC (spec 10.5), and of the endpoints in `global.env` only the shared Helius key serves Solana devnet (the Chainstack and Validation Cloud URLs are other chains', QuickNode has a token but no endpoint); it sends 1 transaction per second and is rate-limited when agents run in parallel, so tests default to the public `api.devnet.solana.com` and on-chain-heavy work is staggered.
- Devnet SOL is scarce: CLI airdrops are refused, and faucet.solana.com gives at most 10 SOL every 8 hours (spec 11.4); the owner collects it into `3hTTgfj2YqqYJeEgSF49U8ZyZwyHnwPhF9LRsXy4fMY8`.
- Build the programs with `pnpm programs`, never a bare `anchor build`: Anchor 1.2.1 defaults to SBPF v3, which neither devnet nor mainnet has activated (2026-10-27), and the program tests fail on a v3 binary.
  The program ids are fixed, `HeatF…` (fee) and `HeatP…` (Fair Open) ([#65](https://github.com/imDev2023/top-pad/issues/65), spec 5.1), and their keypairs exist only in this Mac's gitignored `target/deploy` and the owner's password manager (spec 10.3), so a fresh checkout builds with random ones and warns of a mismatch, which is expected: never "fix" it with `anchor keys sync`, which writes the random ids into the source.
- Anchor 1.2.1 is pinned in `Anchor.toml` (`[toolchain]`), so avm's `anchor` runs it here while the machine's default stays 0.31.1 for other projects; `avm install` switches the default, so run `avm use 0.31.1` after installing another version.
- Codama's output for the DBC IDL is not clean on its own; `packages/clients/scripts/generate.ts` fixes the IDL first (see its comment), so always generate through `pnpm clients`.
- The devnet database is on Neon, not Supabase (spec 10.4): project `top-pad-devnet` (`odd-firefly-70405620`, London, Postgres 17, like docker and CI), behind Hyperdrive `top-pad-devnet` (`4226d6abb4c54484a3e6ab28a6b2a421`) with its query cache off (spec 10.4).
  `npx neonctl` is signed in, but every command needs `--org-id org-wispy-snow-11801955` or it stops at an interactive prompt.
- The Cloudflare token in `global.env` cannot use Hyperdrive or Secrets Store; the owner's wrangler login can, so run those commands with the token unset (`env -u CLOUDFLARE_API_TOKEN pnpm exec wrangler hyperdrive ...`); deploys work with the token.
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
