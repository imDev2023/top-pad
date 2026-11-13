# Anyone launches with a wallet; X is optional

Status: accepted by the owner on 2026-11-08 ("Drop the link with X. Let anyone launch."), built in [#103](https://github.com/imDev2023/top-pad/issues/103) on 2026-11-13, replacing "every launch needs an X account" in spec sections 2.1, 6, 7, 9, 10 and 11.

Until now every launch needed an X account linked through OAuth, and the Creator record belonged to that account (spec 7: "a wallet resets for free, an audience does not").
The owner dropped the requirement: launching needs only a wallet, and linking X becomes optional everywhere.
A reader would expect a launchpad built around accountable creators to keep the one identity a creator cannot reset for free; the owner chose reach instead, since an X account kept away every creator who would not link one, and Heat's own deposit rules and Bundle Radar already work on wallets.

## What changes

- **Signing in is with the wallet.**
  The wallet signs a Sign In With Solana message (CAIP-122, as Phantom and Solflare read it) that names Heat's site as its domain and URI, the wallet, the cluster as its chain id, a nonce and an expiry ten minutes on.
  The API keeps each message it gives (`wallet_sign_ins`) and takes it once: a replayed message, an expired one, one edited, one given to another wallet or a signature not the wallet's is refused, and none of the last three uses the message up.
  It gives the browser the same session linking X gives (`sessions`, now with the wallet that signed in).
- **The Creator record is the Creator wallet's.**
  The wallet that signs in is the record's Creator wallet from then on (`creator_wallets.via = 'sign_in'`, its proof the signature and the message it signs, so anyone can check it again); signing in again, from any browser, finds the same record.
  A record has its X account linked or not (`creators.x_*`, all set or all null).
- **X stays, as an optional link.**
  Linked from a browser signed in with a wallet, the X account joins that record, and shows on the record and in its coins' metadata (`twitter`), which names no X when none is linked.
  Linking X still raises the record's wallets to Scored as #48 built it, and a browser signed out may still sign in by linking X alone, as before.
  An X account belongs to one record and a record has one X account: linking an X account another record holds, or a second one, is refused and changes nothing (`?x=taken`).
- **Everything that asked for an X session takes either sign-in**: the launch flow, `/appeal`, the creator's at-open rung (`POST /fair-opens/<launch>/open`, now to whoever is signed in as the Creator wallet that scheduled it, or as its record by X), the creator's pages and Creator Earnings, which never needed a session.
- **Rate limits and appeals per creator count per record**, so per Creator wallet.
- **Admissions:** a Creator wallet whose record linked no X is Unverified unless another tier source applies; linking X still raises it to Scored.
  The creator's own cluster is still refused through any wallet but the Creator wallet: for a record with no X, that cluster is the Creator wallet's funding root.

## What it costs

- **A Bar now follows the Creator wallet, and a new wallet is free.**
  Spec 8's premise, "a wallet resets for free, an audience does not", was why the record belonged to an X account: a barred creator had to give up their audience to launch again.
  Now a barred creator can come back under a new wallet with an empty record.
  What a fresh record lacks still costs them: no graduations, so no verified-creator mark and no featured calendar slots, and any coin they launched before stays on the old record with its finding.
  Bundle Radar's funding links still tie a new wallet to an old one when its SOL came from it, which is how most fresh wallets are funded, and a Bar keeps barring a linked X account and any World ID nullifier.
- **A creator who links no X deposits as Unverified**, so their own Fair Open needs Scored or Verified depositors to open: Unverified fills are capped at a quarter of what the pot spends, and a pot of Unverified seats alone, the creator's included, buys nothing and fails (found on devnet on 2026-11-13, a USDC Fair Open whose only depositor was its creator).
  The rule is unchanged; what changed is that a creator is no longer Scored by default.
- **The X handle no longer vouches for every coin.**
  Traders see an X link only on coins whose creator chose to link one; the coin card names the Creator wallet otherwise.
- **Two ways in, one record each.**
  A wallet that signed in and an X account linked before from a signed-out browser are two records, and they are never merged here: merging would move launches, appeals, reviews and clearances between records and orphan the audit log's references, which never change.
  A record that linked X and has no Creator wallet yet takes the wallet that signs in from the same browser, or a wallet already verified for its X account, as its Creator wallet; any other pair stays two records until the Creator record's handover ([#55](https://github.com/imDev2023/top-pad/issues/55)) can move a wallet between them.

## Considered Options

- **Wallet sign-in, X an optional link that also still signs in on its own (chosen).**
  Nobody needs X to launch, and nothing built on X sessions (#48's "Verify once", the stand-in) had to change.
- **Wallet sign-in only, X linkable only once signed in (rejected):** it would make every depositor who only wants Scored sign in with a wallet first, adding a signature to #48's flow, for no gain in what is proven.
- **Merging an X record into a wallet's record on link (rejected):** see "Two ways in"; the audit log and the operator's clearances refer to records by id.
- **Keep X required (rejected by the owner).**
