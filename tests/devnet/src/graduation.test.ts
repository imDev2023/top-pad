// Graduation on devnet (#51, #91), against DBC, DAMM v2 and the fee program as deployed. A Heat coin is launched on a
// rehearsal config, every value of the Instant config's but a Graduation Target of 0.25 SOL's worth (spec 11.4), in the
// quote `GRADUATION_QUOTE` names (`rehearsals.ts`): SOL by default, `usdc` for Circle's devnet USDC, an SPL Token quote
// that is not wrapped SOL, or `token2022` for devnet's Token-2022 test quote T22Q, every account of which is Token-2022's
// as an xStock's will be. The window claim runs at 60 s, the coin is bought until its curve completes, and `graduate.ts`
// takes it through Graduation and checks every step. The coins are sold back at the end and every token quote swept back
// to the bank. It spends about 0.07 devnet SOL from Heat's devnet bank (with `GRADUATION=real`, SOL's Instant config
// itself and about 2 SOL); in USDC it moves about 3.5 USDC from the bank and returns all but about 0.6, a fifth of the
// target locked forever in the graduated pool and the fees. It signs with the keeper key, which, like the bank, only this
// Mac holds (~/.config/top-pad/devnet, never CI); without them it is skipped.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createKeyPairSignerFromBytes, generateKeyPairSigner } from "@solana/kit";
import { describe, it } from "vitest";
import {
  claimablePool,
  inSol,
  instantLaunchAccounts,
  instantLaunchInstructions,
  referralAccountOf,
  swapInstructions,
  windowClaimInstructions,
  type InstantLaunch,
} from "@top-pad/chain";
import { fetchPoolConfig, fetchVirtualPool } from "@top-pad/clients/dbc";
import { bankFile, chainTime, devnet, fundedWallets, rpc, send, sweep } from "./devnet";
import { fundQuote, sweepDepositors } from "./fairOpen";
import { graduateAndCheck } from "./graduate";
import { rehearsalOf } from "./rehearsals";

const keeperFile = join(homedir(), ".config/top-pad/devnet/keeper.json");
const load = async (path: string) => createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rehearsal = rehearsalOf();
const real = process.env.GRADUATION === "real";
if (real && !inSol(rehearsal.quote)) throw new Error("GRADUATION=real graduates on SOL's Instant config only");
const config = real ? devnet.configs!.instant : rehearsal.instant;
const { quote } = rehearsal;
const treasury = devnet.keys!.treasury;
/** The Tax window: the test buys after it, at the 1.25% curve fee. */
const TAX_WINDOW_SECONDS = 60n;

describe.skipIf(!existsSync(keeperFile) || !existsSync(bankFile))(`Graduation on devnet in ${rehearsal.symbol}`, () => {
  it(
    "migrates a complete curve into DAMM v2 with both LP halves locked forever, splits its surplus, burns its leftover, and trades on",
    { timeout: 600_000 },
    async () => {
      const keeper = await load(keeperFile);
      const target = (await fetchPoolConfig(rpc, config)).data.migrationQuoteThreshold;
      // The trader's buy reaches the target with its 1.25% fee; the rest of its float trades on the graduated pool. In a
      // token quote that float is the quote's, and SOL pays only the fees and the accounts' rent.
      const float = (target * 105n) / 100n + target / 4n;
      const [creator, trader] = await fundedWallets(40_000_000n, inSol(quote) ? float : 40_000_000n);
      if (!inSol(quote)) await fundQuote([trader], [float], quote, rehearsal.decimals);
      // Once the coin has graduated, what the trader still holds is sold back into its pool at the end.
      let sellBack = null as (() => Promise<unknown>) | null;
      try {
        const mint = await generateKeyPairSigner();
        const launch: InstantLaunch = {
          config,
          quoteMint: quote.mint,
          quoteTokenProgram: quote.tokenProgram,
          creator,
          mint,
          launchKey: keeper,
          coin: { name: `Heat Graduation ${rehearsal.symbol}`, ticker: "HEATGRAD", uri: "https://turbo-gateway.com/heat-devnet-graduation-test" },
          computeUnitPrice: 0n,
        };
        const { pool } = await instantLaunchAccounts(launch);
        await send(creator, await instantLaunchInstructions(launch));
        console.log(`launched ${mint.address} in ${rehearsal.symbol} on ${real ? "the Instant config" : "the rehearsal config"} ${config}, pool ${pool}`);
        const opened = (await fetchVirtualPool(rpc, pool)).data.poolState.activationPoint;
        while ((await chainTime()) < opened + TAX_WINDOW_SECONDS) await sleep(1_000);
        // The window claim, as the keeper sends it at 60 s, so the creator's claim later may run.
        const curve = claimablePool(pool, (await fetchVirtualPool(rpc, pool)).data.poolState, quote);
        await send(keeper, await windowClaimInstructions({ pool: curve, heat: true, treasury, payer: keeper, computeUnitPrice: 0n }));

        // The buy that completes the curve, a partial fill as quick buy sends it, with Heat's referral account.
        const referral = await referralAccountOf(treasury, quote.mint, quote.tokenProgram);
        await send(
          trader,
          await swapInstructions({
            config,
            pool,
            mint: mint.address,
            quoteMint: quote.mint,
            quoteTokenProgram: quote.tokenProgram,
            trader,
            side: "buy",
            amountIn: (target * 103n) / 100n,
            minimumOut: 1n,
            mode: "partial_fill",
            referralAccount: referral,
          }),
        );
        await graduateAndCheck({ config, pool, mint: mint.address, quote, creator, trader, keeper, referral }, (s) => (sellBack = s));
      } finally {
        await sellBack?.().catch((e: Error) => console.error(`selling back failed: ${e.message}`));
        if (inSol(quote)) await sweep(trader, creator);
        else await sweepDepositors([trader, creator], quote);
      }
    },
  );
});
