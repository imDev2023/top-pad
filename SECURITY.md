# Security policy

This repository holds a devnet prototype of a Solana launchpad: two on-chain programs (a fee program and a Fair Open program), their clients, and the services around them.
Nothing here is deployed to mainnet yet, and nothing here has been audited.

## Reporting a vulnerability

Report it privately through GitHub's private vulnerability reporting: https://github.com/imDev2023/top-pad/security/advisories/new.
Do not open a public issue for it.

Say which program, instruction or service is affected, how to reproduce the problem, and what an attacker gains.
Reports go to the project's owner.

## Scope

- The programs under `programs/`, at the ids their `security.txt` names.
- The API and web Workers under `apps/`.

Meteora's and Jupiter's programs are out of scope here; report those to Meteora and Jupiter.
