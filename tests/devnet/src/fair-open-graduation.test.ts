// A Fair Open in a Token-2022 quote run through to Graduation on devnet (#91, spec 11.2), against the Fair Open program,
// the fee program, DBC and DAMM v2 as deployed: the stand-in xStock's run, in devnet's Token-2022 test quote T22Q while
// Meteora has not badged the stand-in (`rehearsals.ts`). It is scheduled on T22Q's Fair Open rehearsal config, which
// T22Q's `QuoteSettings` name, a Graduation Target of 25 T22Q (0.25 SOL's worth, one T22Q standing for 0.01 SOL); three
// depositors put T22Q in its pot, a token account of the quote, and our keeper opens it at its time with the creator
// signing at the open, the pot's buy a `TransferChecked` of T22Q into DBC's Token-2022 quote vault. Every seat is pushed
// its coins and its refund in T22Q, the Tax Share is collected and pushed in T22Q, and the launch closes; then a trader
// buys until the curve completes, and `graduate.ts` takes the coin through Graduation and checks every step. Every
// depositor and the trader are swept back to the bank, their T22Q with them. It spends about 0.1 devnet SOL, and signs
// with the keeper and admission keys only this Mac holds (~/.config/top-pad/devnet); without them it is skipped.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  generateKeyPairSigner,
  getBase64Encoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  type Base64EncodedWireTransaction,
  type KeyPairSigner,
} from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  allocate,
  dbcPoolAddress,
  potCapOf,
  referralAccountOf,
  rungAtOrBelow,
  seatOutcome,
  swapInstructions,
  Tier,
  type Creation,
} from "@top-pad/chain";
import { fetchLaunch, LaunchStatus } from "@top-pad/clients/fair-open";
import { fetchPoolConfig } from "@top-pad/clients/dbc";
import { bankFile, chainTime, devnet, fund, fundedWallets, landed, rpc, send } from "./devnet";
import {
  admitted,
  closeNonce,
  creationSignedNow,
  deposit,
  depositorsOf,
  fundQuote,
  keeper,
  newPerson,
  pushAll,
  quoteHeld,
  recoverDeposits,
  scheduleFairOpen,
  seatOf,
  settleOpened,
  sweepDepositors,
  type ScheduledFairOpen,
} from "./fairOpen";
import { graduateAndCheck } from "./graduate";
import { REHEARSALS } from "./rehearsals";

const keyDir = join(homedir(), ".config/top-pad/devnet");
const T22Q = REHEARSALS.token2022;
const { quote } = T22Q;
const config = T22Q.fairOpen;
/** How far ahead of now the window closes: time to deposit. */
const OPENS_IN = 90n;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function untilChainTime(at: bigint) {
  for (let now = await chainTime(); now < at; now = await chainTime()) await sleep(Math.min(Number(at - now) * 1_000, 20_000) + 500);
}

describe.skipIf(!existsSync(join(keyDir, "keeper.json")) || !existsSync(join(keyDir, "admission.json")) || !existsSync(bankFile))(
  "A Fair Open in a Token-2022 quote through Graduation on devnet",
  () => {
    it("opens in T22Q, pushes every seat and the Tax Share in T22Q, and graduates", { timeout: 900_000 }, async () => {
      const signer = await keeper();
      const target = (await fetchPoolConfig(rpc, config)).data.migrationQuoteThreshold;
      const float = (target * 105n) / 100n + target / 4n;
      const [creator, trader] = await fundedWallets(60_000_000n, 40_000_000n);
      await fundQuote([trader], [float], quote, T22Q.decimals);
      let scheduled: ScheduledFairOpen | null = null;
      let depositors: KeyPairSigner[] = [];
      let sellBack = null as (() => Promise<unknown>) | null;
      try {
        // Scheduled on the config T22Q's settings name, its window already running and closing in 90 s.
        const s = (scheduled = await scheduleFairOpen(creator, (await chainTime()) + OPENS_IN - 600n, 0n, quote));
        const launch = (await fetchLaunch(rpc, s.launch)).data;
        expect(launch.dbcConfig).toBe(config);
        expect(launch.potCap).toBe(potCapOf(target));
        const step = launch.step;
        console.log(`scheduled ${s.launch} in T22Q on ${config}: step ${step}, pot cap ${launch.potCap}`);

        // Three depositors asking 9 steps between them, past the pot cap of 5: the pot spends its cap and refunds the rest.
        const asks: [Tier, bigint][] = [[Tier.Verified, 4n], [Tier.Scored, 3n], [Tier.Unverified, 2n]];
        depositors = await depositorsOf(s.launch, asks.length);
        await fund(depositors, asks.map(() => 30_000_000n));
        await fundQuote(depositors, asks.map(([, n]) => n * step), quote, T22Q.decimals);
        for (const [i, [tier, n]] of asks.entries()) {
          await deposit(s.launch, depositors[i]!, n * step, await admitted(s.launch, depositors[i]!.address, newPerson(), tier, {}, step), quote);
        }
        const before = (await fetchLaunch(rpc, s.launch)).data;
        const a = allocate(before.counts, before.unverifiedCounts, before.step, before.potCap);
        const rung = rungAtOrBelow(before.potCap, a.spend)!;
        expect(rung).toBe(before.potCap);

        // The open at its time, the creator signing at the open: the pot's rung of T22Q buys the coin's first coins.
        await untilChainTime(before.opensAt);
        const mint = await generateKeyPairSigner();
        const creation: Creation = {
          launch: s.launch,
          dbcConfig: config,
          quoteMint: quote.mint,
          quoteTokenProgram: quote.tokenProgram,
          creator,
          keeper: signer,
          mint,
          coin: s.coin,
          rung,
          computeUnitPrice: 0n,
        };
        const wire = await creationSignedNow(creation);
        const signature = getSignatureFromTransaction(getTransactionDecoder().decode(getBase64Encoder().encode(wire)));
        await rpc.sendTransaction(wire as Base64EncodedWireTransaction, { encoding: "base64" }).send();
        const opened = await landed(signature);
        expect(opened.meta?.err ?? null).toBeNull();
        const after = (await fetchLaunch(rpc, s.launch)).data;
        expect(after).toMatchObject({ status: LaunchStatus.Opened, spent: rung });
        console.log(`opened ${mint.address} with a rung of ${rung} T22Q raw: ${signature}, ${(opened.meta as { computeUnitsConsumed?: number } | null)?.computeUnitsConsumed} CU`);

        // Every seat pushed its coins and its refund in T22Q, to the raw unit.
        const seats = await Promise.all(depositors.map(async (d) => ({ seat: (await seatOf(s.launch, d.address))!.address, wallet: d.address })));
        const quoteBefore = await Promise.all(depositors.map((d) => quoteHeld(d.address, quote)));
        const pushes = await pushAll(s.launch, mint.address, seats, quote);
        console.log(`pushed ${seats.length} seats in ${pushes.length} transaction(s): ${pushes.join(", ")}`);
        for (const [i, [tier, n]] of asks.entries()) {
          expect((await quoteHeld(depositors[i]!.address, quote)) - quoteBefore[i]!).toBe(seatOutcome(after, tier, n * step).refund);
        }

        // The Tax Share collected once the window ends and pushed in T22Q; every seat closed, then the launch.
        const settled = await settleOpened(s.launch);
        expect(settled.collect).not.toBeNull();
        expect(settled.close).not.toBeNull();
        for (const seat of seats) expect(await seatOf(s.launch, seat.wallet)).toBeNull();
        console.log(`Tax Share: ${settled.collect}, pushed in ${settled.pushes.join(", ")}; closed ${settled.close}`);

        // A trader completes the curve, and the coin graduates.
        const pool = await dbcPoolAddress(config, mint.address, quote.mint);
        const referral = await referralAccountOf(devnet.keys!.treasury, quote.mint, quote.tokenProgram);
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
        await graduateAndCheck({ config, pool, mint: mint.address, quote, creator, trader, keeper: signer, referral }, (sb) => (sellBack = sb));
      } finally {
        await sellBack?.().catch((e: Error) => console.error(`selling back failed: ${e.message}`));
        if (scheduled) {
          await recoverDeposits(scheduled.launch, creator, depositors).catch((e: Error) => console.error(`recovering deposits failed: ${e.message}`));
          await closeNonce(scheduled.nonce, creator.address).catch(() => null);
        }
        await sweepDepositors([...depositors, trader, creator], quote);
      }
    });
  },
);
