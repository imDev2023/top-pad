# Top-pad

A fair-launch token launchpad on Solana, built on Meteora's pools.
The product's name is **Greenflag**; "Top-pad" stays only as the repo's and folder's working name.
The owner's original brief is `resources.md`; the project's terms are in `GLOSSARY.md`.

Planning is finished: the build starts from **`docs/spec.md`**, the one build-ready spec (decisions in `docs/adr/0001` to `0006`).
The wayfinder map (GitHub issue #1, label `wayfinder:map`) indexes every decision and its `## Next` section names the next unit of work.
Start any session by reading that section: `gh issue view 1 --repo imDev2023/top-pad`.
Greenflag stays a separate product from Stoker; merging is revisited only after the devnet cohort ([ADR 0001](docs/adr/0001-separate-product-from-stoker.md)).

For anything about Jupiter or Meteora, read the owner's canonical knowledge base first, not this repo and not the web: `/Volumes/Farhan/Work Folder/Dev/AI/Research-Projects/jupiter-meteora` locally, or https://github.com/imDev2023/jupiter-meteora-resources in the cloud.

## Traps

- Research findings live on `research/<name>` branches, pushed and never merged, so `main` does not hold them; read one with `git show origin/research/<name>:research/<name>.md`.
  Prototypes live the same way on `prototype/<name>` branches (`fair-open-creation-tx`, `screens-mockup`).
- An agent started with worktree isolation is refused any git or gh command its guard cannot prove stays in its own worktree: `cd` followed by git, loops, `source` or `.` of an env file, and even `git -C` on its own worktree path (likely the space in `Work Folder`).
  What works: one plain command per call, plain `git <cmd>` from the worktree itself, `git -C /private/tmp/claude-501/...` read-only commands on clones in the scratchpad (allowed in `~/.claude/settings.json`), and API keys through `direnv exec "<this folder>" <cmd>`.
- Never download, dump or commit Meteora's program binaries (Meteora's 2026-10-27 reply in #26 did not cover them, so the rule stands).
  Cloning Meteora's repos pulls them in anyway (`tests/fixtures/*.so`, SDK `artifacts/*.so`): read source on GitHub, or delete those files the moment a clone lands.
- The devnet build runs on free-tier RPC (spec 10.5): the shared Helius free key sends 1 transaction per second and is rate-limited when agents run in parallel, so prefer a Chainstack or QuickNode devnet endpoint and stagger on-chain-heavy work.
- Devnet SOL is scarce: CLI airdrops are refused, and faucet.solana.com gives at most 10 SOL every 8 hours (spec 11.4); the owner collects it into `3hTTgfj2YqqYJeEgSF49U8ZyZwyHnwPhF9LRsXy4fMY8`.
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
