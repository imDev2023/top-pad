// Quick buy and sell on devnet (#43), against DBC's deployed program: a Heat coin launched as the launch service
// launches it, then buys and sells built exactly as Heat's API builds them (`swapMessage`, Heat's referral account,
// buys as partial fills), inside the sniper tax's minute and after it. Each must do exactly what `@top-pad/meteora`'s
// quote said for the pool as it stood and the second it ran, to the raw unit; the fee a page showed before sending
// must be within one 1-second step of what the chain charged; and the referral share must land in Heat's referral
// account. It spends about 0.06 devnet SOL from Heat's devnet bank, most of it sniper tax, and signs the launch with
// the keeper key, which, like the bank, only this Mac holds (~/.config/top-pad/devnet, never CI); without them it is
// skipped.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createKeyPairSignerFromBytes, generateKeyPairSigner, getBase58Encoder, type Address, type Instruction, type KeyPairSigner } from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS,
  instantLaunchAccounts,
  instantLaunchInstructions,
  referralAccountOf,
  SWAP_COMPUTE_UNITS,
  swapMessage,
  TOKEN_PROGRAM_ADDRESS,
  type InstantLaunch,
} from "@top-pad/chain";
import { EVT_SWAP3_EVENT_DISCRIMINATOR, fetchPoolConfig, fetchVirtualPool, parseEvtSwap3Event, type EvtSwap3Event } from "@top-pad/clients/dbc";
import { decodeTransaction } from "@top-pad/indexer";
import { SNIPER_TAX } from "@top-pad/meteora";
import { minimumOut, quoteSwap } from "@top-pad/meteora/quote";
import { bankFile, chainTime, coinBalance, devnet, fundedWallets, landed, rpc, send, sweep } from "./devnet";

const keeperFile = join(homedir(), ".config/top-pad/devnet/keeper.json");
const load = async (path: string) => createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const HEAT = new Set<string>([devnet.configs!.instant, devnet.configs!.fairOpen]);
const quoteMint = devnet.quote.mint;
const treasury = devnet.keys!.treasury;
/** Anchor's tag on an event CPI's data, before the event's own discriminator. */
const EVENT_IX_TAG = [0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d];
/** The page shows the fee of the second a trade sent now would land in (`QuickTrade.tsx`). */
const LANDING_SECONDS = 1n;

/** DBC's swap event in a landed transaction. */
async function swapEvent(signature: string): Promise<EvtSwap3Event> {
  const raw = await landed(signature);
  const keys = [...raw.transaction.message.accountKeys, ...(raw.meta?.loadedAddresses?.writable ?? []), ...(raw.meta?.loadedAddresses?.readonly ?? [])];
  const events = (raw.meta?.innerInstructions ?? [])
    .flatMap((g) => g.instructions)
    .filter((ix) => keys[ix.programIdIndex] === DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS)
    .map((ix) => getBase58Encoder().encode(ix.data))
    .filter((data) => EVENT_IX_TAG.every((b, i) => data[i] === b) && EVT_SWAP3_EVENT_DISCRIMINATOR.every((b, i) => data[8 + i] === b))
    .map((data) => parseEvtSwap3Event(data.subarray(8)));
  expect(events).toHaveLength(1);
  return events[0]!;
}

/** How a landed transaction changed `owner`'s balance of the quote, from its own token balances. */
async function quoteChange(signature: string, owner: Address): Promise<bigint> {
  type Balance = { owner?: string; mint: string; uiTokenAmount: { amount: string } };
  const meta = (await landed(signature)).meta as { preTokenBalances?: Balance[]; postTokenBalances?: Balance[] };
  const of = (balances: Balance[] = []) => BigInt(balances.find((b) => b.owner === owner && b.mint === quoteMint)?.uiTokenAmount.amount ?? "0");
  return of(meta.postTokenBalances) - of(meta.preTokenBalances);
}

describe.skipIf(!existsSync(keeperFile) || !existsSync(bankFile))("quick buy and sell on devnet", () => {
  it(
    "does exactly what its quote said, inside the sniper tax and after it, and pays Heat's referral account its share",
    { timeout: 300_000 },
    async () => {
      const keeper = await load(keeperFile);
      const [creator, trader] = await fundedWallets(40_000_000n, 200_000_000n);
      try {
        const mint = await generateKeyPairSigner();
        const launch: InstantLaunch = {
          config: devnet.configs!.instant,
          quoteMint,
          creator,
          mint,
          launchKey: keeper,
          coin: { name: "Heat Quick Trade Test", ticker: "HEATQUICK", uri: "https://turbo-gateway.com/heat-devnet-quick-trade-test" },
          computeUnitPrice: 0n,
        };
        const { pool } = await instantLaunchAccounts(launch);
        await send(creator, await instantLaunchInstructions(launch));
        console.log(`launched ${mint.address}, pool ${pool}`);
        const { data: config } = await fetchPoolConfig(rpc, devnet.configs!.instant);
        const opened = (await fetchVirtualPool(rpc, pool)).data.poolState.activationPoint;
        const referral = await referralAccountOf(treasury, quoteMint, TOKEN_PROGRAM_ADDRESS);

        /** A quick trade at `second` after the open, checked against its quote. */
        async function quick(who: KeyPairSigner, second: number, side: "buy" | "sell", amount: () => Promise<bigint>) {
          while ((await chainTime()) < opened + BigInt(second)) await sleep(400);
          const amountIn = await amount();
          const before = (await fetchVirtualPool(rpc, pool, { commitment: "confirmed" })).data.poolState;
          const now = await chainTime();
          // What the page shows before signing: the quote for the second the trade would land in.
          const shown = quoteSwap({ pool: before, config, side, amountIn, currentPoint: now + LANDING_SECONDS, hasReferral: true });
          const first = quoteSwap({ pool: before, config, side, amountIn, currentPoint: now, hasReferral: true });
          const { value: lifetime } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
          const message = await swapMessage(
            {
              config: devnet.configs!.instant,
              pool,
              mint: mint.address,
              quoteMint,
              quoteTokenProgram: TOKEN_PROGRAM_ADDRESS,
              trader: who,
              side,
              amountIn,
              minimumOut: minimumOut(first.amountOut, 100),
              mode: side === "buy" ? "partial_fill" : "exact_in",
              referralAccount: referral,
            },
            { computeUnitPrice: 0n, lifetime },
          );
          const signature = await send(who, message.instructions as Instruction[]);
          const event = await swapEvent(signature);
          // Nobody else trades this coin, so the pool the quote read is the pool the swap ran on.
          expect(event.nextSqrtPrice).not.toBe(before.sqrtPrice);
          const exact = quoteSwap({ pool: before, config, side, amountIn, currentPoint: event.currentTimestamp, hasReferral: true });
          expect({
            taken: event.includedTransferFeeAmountIn,
            out: event.excludedTransferFeeAmountOut,
            tradingFee: event.tradingFee,
            protocolFee: event.protocolFee,
            referralFee: event.referralFee,
            nextSqrtPrice: event.nextSqrtPrice,
          }).toEqual({
            taken: exact.amountIn,
            out: exact.amountOut,
            tradingFee: exact.tradingFee,
            protocolFee: exact.protocolFee,
            referralFee: exact.referralFee,
            nextSqrtPrice: exact.nextSqrtPrice,
          });
          expect(event.hasReferral).toBe(true);
          // The referral share lands in Heat's referral account, the treasury's quote account.
          expect(event.referralFee).toBeGreaterThan(0n);
          expect(await quoteChange(signature, treasury)).toBe(event.referralFee);
          // The trade as the indexer records it.
          const [indexed] = decodeTransaction(await landed(signature), HEAT).swaps;
          expect(indexed).toMatchObject({ side, fee: exact.fee, quoteAmount: exact.quoteAmount });
          const rate = (q: { fee: bigint; quoteAmount: bigint }) => Number(q.fee) / Number(q.quoteAmount);
          const units = ((await landed(signature)).meta as { computeUnitsConsumed?: number }).computeUnitsConsumed ?? 0;
          return {
            second: Number(event.currentTimestamp - opened),
            shownAt: Number(now + LANDING_SECONDS - opened),
            side,
            shown: rate(shown),
            charged: rate(exact),
            referralFee: event.referralFee,
            units,
          };
        }

        const all = () => coinBalance(trader.address, mint.address);
        const half = async () => (await all()) / 2n;
        const runs = [
          await quick(trader, 4, "buy", async () => 10_000_000n),
          await quick(trader, 18, "buy", async () => 20_000_000n),
          await quick(trader, 33, "sell", half),
          await quick(trader, 48, "buy", async () => 10_000_000n),
          await quick(trader, 63, "buy", async () => 50_000_000n),
          await quick(trader, 70, "sell", all),
        ];
        console.table(runs.map((r) => ({ ...r, shown: `${(r.shown * 100).toFixed(3)}%`, charged: `${(r.charged * 100).toFixed(3)}%` })));
        // The fee shown before signing is within one of the sniper tax's 1-second steps of what the chain charged.
        const step = Number(SNIPER_TAX.reductionFactor) / 1e9;
        for (const r of runs) expect(Math.abs(r.shown - r.charged), `the ${r.side} at ${r.second} s`).toBeLessThanOrEqual(step + 1e-9);
        // Inside the tax's minute and after it.
        expect(runs.filter((r) => r.second < 60).length).toBeGreaterThanOrEqual(3);
        expect(runs.at(-1)!.charged).toBeCloseTo(0.0125, 6);
        for (const r of runs) expect(r.units).toBeLessThanOrEqual(SWAP_COMPUTE_UNITS);
        console.log(`compute units: ${runs.map((r) => r.units).join(", ")} of ${SWAP_COMPUTE_UNITS}; referral shares: ${runs.map((r) => r.referralFee).join(", ")} lamports`);
        expect(await all()).toBe(0n);
      } finally {
        await sweep(trader, creator);
      }
    },
  );
});
