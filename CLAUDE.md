# Top-pad

A fair-launch token launchpad on Solana, built on Meteora's pools.
The owner's original brief is `resources.md`; the project's terms are in `GLOSSARY.md`.
The product's name is **Greenflag** (owner, 2026-10-27, in the screens ticket #15); "Top-pad" stays only as the repo's and folder's working name.

The work is being planned as a wayfinder map: one GitHub issue labelled `wayfinder:map`, with its tickets as sub-issues.
Start any session by reading that map issue (`gh issue list --label wayfinder:map`).

For anything about Jupiter or Meteora, read the owner's canonical knowledge base first, not this repo and not the web: `/Volumes/Farhan/Work Folder/Dev/AI/Research-Projects/jupiter-meteora` locally, or https://github.com/imDev2023/jupiter-meteora-resources in the cloud.

## Traps for research agents

- Research findings live on `research/<name>` branches, pushed and never merged, so `main` does not hold them; read one with `git show origin/research/<name>:research/<name>.md`.
- An agent started with worktree isolation is refused any git or gh command its guard cannot prove stays in its own worktree: `cd` followed by git, loops, `source` or `.` of an env file, and even `git -C` on its own worktree path (likely the space in `Work Folder`).
  What works: one plain command per call, plain `git <cmd>` from the worktree itself, `git -C /private/tmp/claude-501/...` read-only commands on clones in the scratchpad (allowed in `~/.claude/settings.json`), and API keys through `direnv exec "<this folder>" <cmd>`.
- Never download, dump or commit Meteora's program binaries: the licence research says that needs Meteora's written permission, which #26 has asked for.
- Parallel agents share one free-tier Helius key and get rate-limited; stagger on-chain-heavy research.

## Agent skills

### Issue tracker

Issues, the wayfinder map and its tickets live in GitHub issues on `imDev2023/top-pad`. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context. See `docs/agents/domain.md`.

## Multica dashboard

This project is mirrored on the owner's Multica dashboard (workspace Pandora) as project `2525b9a3-ec70-47d8-9d09-140deece218d`.
The GitHub issues on `imDev2023/top-pad` (the wayfinder map and its sub-issues) stay the source of truth; Multica only mirrors them.
At the end of every session, after the tracker is updated, run the `multica-sync` skill for this project: mirror ticket statuses, add any new tickets, and refresh the project's "Current step" section.
Every Multica write passes `--no-start` and no ticket is ever assigned to an agent, so the sync never starts an agent run.
If the `multica` CLI is not signed in, say so in the session summary and stop anyway; the sync never blocks the work.
