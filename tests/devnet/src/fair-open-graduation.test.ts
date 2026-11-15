// A Fair Open in a token quote on devnet (#91, #62, spec 11.2), against the Fair Open program, the fee program, DBC and
// DAMM v2 as deployed, in the quote `FAIR_OPEN_QUOTE` names:
//
// - `token2022` (the default): the stand-in xStock's run, in devnet's Token-2022 test quote T22Q while Meteora has not
//   badged the stand-in (`rehearsals.ts`). It is scheduled on T22Q's Fair Open rehearsal config, which T22Q's
//   `QuoteSettings` name, a Graduation Target of 25 T22Q (0.25 SOL's worth, one T22Q standing for 0.01 SOL); three
//   depositors ask past the pot's cap, so the pot spends its cap and refunds the rest; then a trader buys until the curve
//   completes, and `graduate.ts` takes the coin through Graduation and checks every step.
// - `usdc`: Circle's devnet USDC, on the Fair Open config USDC's `QuoteSettings` name (the band job's pair, at 8.5 SOL's
//   worth, so this run never graduates it): three depositors ask less than the cap, so the pot opens on the rung at or
//   below what they asked and refunds each the rest; once the Tax window ends the creator claims their Creator Earnings
//   in USDC, half the partner's part of the pot's own fee, and the depositors sell their coins back in USDC.
//
// In either, our keeper opens it at its time with the creator signing at the open, the pot's buy a `TransferChecked` of
// the quote into DBC's quote vault; every seat is pushed its coins and its refund in the quote to the raw unit, the Tax
// Share is collected and pushed in the quote, and the launch closes. Every depositor and the trader are swept back to the
// bank, their quote with them. It spends about 0.1 devnet SOL (T22Q) or 0.03 (USDC, moving about 1 USDC and returning all
// but the fees), and signs with the keeper and admission keys only this Mac holds (~/.config/top-pad/devnet); without
// them it is skipped.
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
  claimablePool,
  creatorClaimInstructions,
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
import { fetchPoolConfig, fetchVirtualPool } from "@top-pad/clients/dbc";
import { bankFile, chainTime, coinBalance, devnet, fund, fundedWallets, landed, rpc, send } from "./devnet";
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
  quoteFairOpenConfig,
  quoteHeld,
  recoverDeposits,
  scheduleFairOpen,
  seatOf,
  settleOpened,
  sweepDepositors,
  type ScheduledFairOpen,
} from "./fairOpen";
import { graduateAndCheck } from "./graduate";
import { REHEARSALS, type RehearsalName } from "./rehearsals";

const keyDir = join(homedir(), ".config/top-pad/devnet");
const quoteName = (process.env.FAIR_OPEN_QUOTE ?? "token2022") as RehearsalName;
if (quoteName !== "token2022" && quoteName !== "usdc") throw new Error(`FAIR_OPEN_QUOTE is token2022 or usdc, not ${quoteName}`);
const rehearsal = REHEARSALS[quoteName];
const { quote, symbol } = rehearsal;
/** Only T22Q's `QuoteSettings` name its rehearsal config, small enough to graduate in a run. */
const graduates = quoteName === "token2022";
/** How far ahead of now the window closes: time to deposit. */
const OPENS_IN = 90n;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function untilChainTime(at: bigint) {
  for (let now = await chainTime(); now < at; now = await chainTime()) await sleep(Math.min(Number(at - now) * 1_000, 20_000) + 500);
}

describe.skipIf(!existsSync(join(keyDir, "keeper.json")) || !existsSync(join(keyDir, "admission.json")) || !existsSync(bankFile))(
  `A Fair Open in ${symbol} on devnet`,
  () => {
    it(`opens in ${symbol}, pushes every seat and the Tax Share in ${symbol}${graduates ? ", and graduates" : ", and pays the creator in it"}`, { timeout: 900_000 }, async () => {
      const signer = await keeper();
      const config = await quoteFairOpenConfig(quote);
      if (graduates) expect(config).toBe(rehearsal.fairOpen);
      const target = (await fetchPoolConfig(rpc, config)).data.migrationQuoteThreshold;
      const float = (target * 105n) / 100n + target / 4n;
      const [creator, trader] = await fundedWallets(60_000_000n, 40_000_000n);
      if (graduates) await fundQuote([trader], [float], quote, rehearsal.decimals);
      let scheduled: ScheduledFairOpen | null = null;
      let depositors: KeyPairSigner[] = [];
      let sellBack = null as (() => Promise<unknown>) | null;
      try {
        // Scheduled on the config the quote's settings name, its window already running and closing in 90 s.
        const s = (scheduled = await scheduleFairOpen(creator, (await chainTime()) + OPENS_IN - 600n, 0n, quote));
        const launch = (await fetchLaunch(rpc, s.launch)).data;
        expect(launch.dbcConfig).toBe(config);
        expect(launch.potCap).toBe(potCapOf(target));
        const step = launch.step;
        console.log(`scheduled ${s.launch} in ${symbol} on ${config}: step ${step}, pot cap ${launch.potCap}`);

        // Three depositors asking 9 steps between them. In T22Q that is past the pot cap of 5 steps, so the pot spends its
        // cap and refunds the rest; in USDC it is under the cap, so the pot opens on the rung at or below what they asked,
        // and each seat gets back what its fill leaves.
        const asks: [Tier, bigint][] = [[Tier.Verified, 4n], [Tier.Scored, 3n], [Tier.Unverified, 2n]];
        depositors = await depositorsOf(s.launch, asks.length);
        await fund(depositors, asks.map(() => 30_000_000n));
        await fundQuote(depositors, asks.map(([, n]) => n * step), quote, rehearsal.decimals);
        for (const [i, [tier, n]] of asks.entries()) {
          await deposit(s.launch, depositors[i]!, n * step, await admitted(s.launch, depositors[i]!.address, newPerson(), tier, {}, step), quote);
        }
        const before = (await fetchLaunch(rpc, s.launch)).data;
        const a = allocate(before.counts, before.unverifiedCounts, before.step, before.potCap);
        const rung = rungAtOrBelow(before.potCap, a.spend)!;
        expect(rung).not.toBeNull();
        if (graduates) expect(rung).toBe(before.potCap);
        else expect(rung).toBeLessThan(a.spend);

        // The open at its time, the creator signing at the open: the pot's rung of the quote buys the coin's first coins.
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
        console.log(`opened ${mint.address} with a rung of ${rung} ${symbol} raw: ${signature}, ${(opened.meta as { computeUnitsConsumed?: number } | null)?.computeUnitsConsumed} CU`);

        // Every seat pushed its coins and its refund in the quote, to the raw unit.
        const seats = await Promise.all(depositors.map(async (d) => ({ seat: (await seatOf(s.launch, d.address))!.address, wallet: d.address })));
        const quoteBefore = await Promise.all(depositors.map((d) => quoteHeld(d.address, quote)));
        const pushes = await pushAll(s.launch, mint.address, seats, quote);
        console.log(`pushed ${seats.length} seats in ${pushes.length} transaction(s): ${pushes.join(", ")}`);
        const refunds: bigint[] = [];
        for (const [i, [tier, n]] of asks.entries()) {
          const refund = seatOutcome(after, tier, n * step).refund;
          expect(refund).toBeGreaterThan(0n);
          expect((await quoteHeld(depositors[i]!.address, quote)) - quoteBefore[i]!).toBe(refund);
          refunds.push(refund);
        }
        console.log(`refunds in ${symbol} raw: ${refunds.join(", ")}`);

        // The Tax Share collected once the window ends and pushed in the quote; every seat closed, then the launch.
        const settled = await settleOpened(s.launch);
        expect(settled.collect).not.toBeNull();
        expect(settled.close).not.toBeNull();
        for (const seat of seats) expect(await seatOf(s.launch, seat.wallet)).toBeNull();
        console.log(`Tax Share: ${settled.collect}, pushed in ${settled.pushes.join(", ")}; closed ${settled.close}`);

        const pool = await dbcPoolAddress(config, mint.address, quote.mint);
        const referral = await referralAccountOf(devnet.keys!.treasury, quote.mint, quote.tokenProgram);
        if (!graduates) {
          // The creator's Creator Earnings in the quote: half the partner's part of the pot's own fee, which the Tax
          // Share left in the pool for the 50/50 split, paid into the creator's account of the quote to the raw unit.
          const curve = claimablePool(pool, (await fetchVirtualPool(rpc, pool, { commitment: "confirmed" })).data.poolState, quote);
          expect(curve.partnerQuoteFee).toBeGreaterThan(0n);
          const creatorBefore = await quoteHeld(creator.address, quote);
          const claim = await send(
            creator,
            await creatorClaimInstructions({ creator, claims: [{ pool: curve, heat: true, maxAmount: curve.partnerQuoteFee }], treasury: devnet.keys!.treasury, computeUnitPrice: 0n }),
          );
          const earned = (await quoteHeld(creator.address, quote)) - creatorBefore;
          expect(earned).toBe(curve.partnerQuoteFee / 2n);
          console.log(`the creator's Creator Earnings: ${earned} ${symbol} raw (${claim})`);
          // Every depositor sells their coins back in the quote before the sweep (CLAUDE.md, Traps).
          for (const d of depositors) {
            const held = await coinBalance(d.address, mint.address);
            if (held === 0n) continue;
            await send(
              d,
              await swapInstructions({ config, pool, mint: mint.address, quoteMint: quote.mint, quoteTokenProgram: quote.tokenProgram, trader: d, side: "sell", amountIn: held, minimumOut: 1n, referralAccount: referral }),
            );
          }
          return;
        }

        // A trader completes the curve, and the coin graduates.
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
