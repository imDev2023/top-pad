// A Fair Open in Circle's devnet USDC (ADR 0007 decision 1, #88), an SPL Token quote DBC takes with no badge, against the
// Fair Open program deployed from its verified build and the deployed API: its pot, a token account of USDC the launch
// owns, takes deposits through the API the Fair Open page uses and straight to the program, and gives one back in the
// window; the window closes below the lowest rung, the launch fails, and every deposit comes back in USDC to the raw
// unit, one through the API's refund and the rest as Heat's keeper returns them; then the launch closes, its pot with it,
// every rent back to the creator in SOL. USDC's `QuoteSettings` must exist (`quote-settings --quote`) and Heat's bank must
// hold a little devnet USDC (`pnpm --filter @top-pad/chain devnet-usdc devnet <SOL> --send`): the run moves about 0.6
// USDC and returns all of it. It spends about 0.02 devnet SOL in fees and signs with the keeper and admission keys only
// this Mac holds (~/.config/top-pad/devnet); without them it is skipped.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  lamports,
  signTransaction,
  type Address,
  type KeyPairSigner,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import { getCloseAccountInstruction, getTransferCheckedInstruction } from "@solana-program/token";
import { describe, expect, it } from "vitest";
import {
  closeLaunchInstructions,
  DEVNET_USDC,
  FAIR_OPEN_PROGRAM_ADDRESS,
  lowestRung,
  quoteTokenAccount,
  quoteTokenAccountInstruction,
  Tier,
  TOKEN_PROGRAM_ADDRESS,
  type QuoteToken,
} from "@top-pad/chain";
import { fetchLaunch, fetchMaybeLaunch, fetchMaybeQuoteSettings, findPotPda, findQuoteSettingsPda, Failure, LaunchStatus } from "@top-pad/clients/fair-open";
import { bank, chainTime, fund, programCompute, rpc, send } from "./devnet";
import { admitted, closeNonce, deposit, depositorsOf, markFailed, newPerson, quoteHeld, recoverDeposits, refundAll, scheduleFairOpen, seatOf } from "./fairOpen";

const keys = ["keeper.json", "admission.json", "bank.json"].every((name) => existsSync(join(homedir(), ".config/top-pad/devnet", name)));
const API = process.env.HEAT_API_URL || "https://top-pad-api-devnet.imdev2023.workers.dev";
const USDC: QuoteToken = { mint: DEVNET_USDC, tokenProgram: TOKEN_PROGRAM_ADDRESS };
const SOL = 1_000_000_000n;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A transaction the API prepared for `wallet`, signed by it and sent; its signature once confirmed. */
async function throughApi(path: string, wallet: KeyPairSigner, body: Record<string, string>): Promise<string> {
  const response = await fetch(`${API}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wallet: wallet.address, ...body }) });
  const answer = (await response.json()) as { transaction?: string; error?: string };
  if (!response.ok || !answer.transaction) throw new Error(`${path} answered ${response.status}: ${answer.error}`);
  const signed = await signTransaction([wallet.keyPair], getTransactionDecoder().decode(getBase64Encoder().encode(answer.transaction)));
  const signature = getSignatureFromTransaction(signed);
  await rpc.sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: "base64", preflightCommitment: "confirmed" }).send();
  for (let i = 0; i < 60; i++) {
    const { value } = await rpc.getSignatureStatuses([signature]).send();
    if (value[0]?.err) throw new Error(`${path}'s transaction failed: ${JSON.stringify(value[0].err)}`);
    if (value[0]?.confirmationStatus === "confirmed" || value[0]?.confirmationStatus === "finalized") return signature;
    await sleep(1_000);
  }
  throw new Error(`${path}'s transaction ${signature} did not confirm`);
}

/** Waits until the chain's clock reaches `at` (Unix seconds). */
async function untilChainTime(at: bigint) {
  for (let now = await chainTime(); now < at; now = await chainTime()) await sleep(Math.min(Number(at - now) * 1_000, 20_000) + 1_000);
}

describe.skipIf(!keys)("a Fair Open in Circle's devnet USDC", () => {
  it(
    "takes deposits and a withdrawal into its pot, fails, and returns every deposit in USDC",
    async () => {
      const settings = await fetchMaybeQuoteSettings(rpc, (await findQuoteSettingsPda({ quoteMint: USDC.mint }))[0], { commitment: "confirmed" });
      if (!settings.exists) throw new Error("devnet has no QuoteSettings for USDC: run quote-settings --quote first");
      const step = settings.data.step;
      const payer = await bank();
      const bankUsdc = await quoteTokenAccount(payer.address, USDC);
      const steps = { api: 2n, scored: 3n, verified: 1n };
      const needed = (steps.api + steps.scored + steps.verified) * step;
      const banked = await quoteHeld(payer.address, USDC);
      if (banked < needed) throw new Error(`the bank holds ${banked} raw USDC, less than the ${needed} this run moves: run devnet-usdc`);

      // A window that closes about 100 s from now, Heat's bank its creator.
      const launch = await scheduleFairOpen(payer, (await chainTime()) + 100n - 600n, 0n, USDC);
      const depositors = await depositorsOf(launch.launch, 3);
      const [viaApi, scored, verified] = depositors as [KeyPairSigner, KeyPairSigner, KeyPairSigner];
      const holds: Record<string, bigint> = {};
      try {
        const created = await fetchLaunch(rpc, launch.launch);
        expect(created.data).toMatchObject({ quoteMint: USDC.mint, step, status: LaunchStatus.Scheduled });
        const [pot] = await findPotPda({ launch: launch.launch });
        expect(await quoteHeldAt(pot)).toBe(0n);
        // Everything deposited stays below the lowest rung, so the window's close fails it at once.
        expect(needed).toBeLessThan(lowestRung(created.data.potCap));

        // Each depositor gets a little SOL for rents and fees, and the USDC it deposits, from the bank.
        await fund(depositors, depositors.map(() => SOL / 50n));
        const amounts = [steps.api, steps.scored, steps.verified].map((n) => n * step);
        await send(payer, [
          ...(await Promise.all(depositors.map((d) => quoteTokenAccountInstruction(payer, d.address, USDC)))),
          ...(await Promise.all(
            depositors.map(async (d, i) =>
              getTransferCheckedInstruction({ source: bankUsdc, mint: USDC.mint, destination: await quoteTokenAccount(d.address, USDC), authority: payer, amount: amounts[i]!, decimals: 6 }),
            ),
          )),
        ]);
        for (const d of depositors) holds[d.address] = await quoteHeld(d.address, USDC);

        // One deposit through the API the Fair Open page uses, admitted by our admission server; two straight to the
        // program with admissions the admission key signs.
        const viaApiDeposit = await throughApi(`/fair-opens/${launch.launch}/deposit`, viaApi, { amount: `${steps.api * step}` });
        console.log(`a USDC deposit through the API: ${viaApiDeposit}, ${await programCompute(viaApiDeposit, FAIR_OPEN_PROGRAM_ADDRESS)} compute units`);
        await deposit(launch.launch, scored, steps.scored * step, await admitted(launch.launch, scored.address, newPerson(), Tier.Scored, {}, step), USDC);
        await deposit(launch.launch, verified, steps.verified * step, await admitted(launch.launch, verified.address, newPerson(), Tier.Verified, {}, step), USDC);
        expect(await quoteHeldAt(pot)).toBe(needed);
        for (const d of depositors) expect(await quoteHeld(d.address, USDC)).toBe(0n);

        // One step back in the window, through the API, to the wallet's account of USDC.
        const back = await throughApi(`/fair-opens/${launch.launch}/withdraw`, viaApi, { amount: `${step}` });
        console.log(`a USDC withdrawal through the API: ${back}`);
        expect(await quoteHeld(viaApi.address, USDC)).toBe(step);
        expect(await quoteHeldAt(pot)).toBe(needed - step);
        const held = await fetchLaunch(rpc, launch.launch);
        expect(held.data).toMatchObject({ seats: 3, unverifiedDeposits: step, scoredDeposits: 3n * step, verifiedDeposits: step });

        // The window closes below the lowest rung: anyone marks it failed at once.
        await untilChainTime(held.data.opensAt);
        await markFailed(launch.launch, payer);
        expect((await fetchLaunch(rpc, launch.launch)).data).toMatchObject({ status: LaunchStatus.Failed, failure: { __option: "Some", value: Failure.BelowLowestRung } });

        // Every deposit back in USDC: one through the API's refund, the others as our keeper returns them.
        const refunded = await throughApi(`/fair-opens/${launch.launch}/refund`, viaApi, {});
        console.log(`a USDC refund through the API: ${refunded}, ${await programCompute(refunded, FAIR_OPEN_PROGRAM_ADDRESS)} compute units`);
        const keeperRefunds = await refundAll(launch.launch, payer, USDC);
        console.log(`the keeper's refunds: ${keeperRefunds.join(", ")}`);
        for (const d of depositors) {
          expect(await quoteHeld(d.address, USDC), d.address).toBe(holds[d.address]);
          expect(await seatOf(launch.launch, d.address)).toBeNull();
        }
        expect(await quoteHeldAt(pot)).toBe(0n);

        // The launch closes, its pot with it, every rent back to the creator in SOL.
        const creatorBefore = (await rpc.getBalance(payer.address, { commitment: "confirmed" }).send()).value;
        const rents = await Promise.all([launch.launch, launch.vault, pot].map(async (a) => (await rpc.getBalance(a, { commitment: "confirmed" }).send()).value));
        const closed = await send(payer, await closeLaunchInstructions({ launch: launch.launch, creator: payer.address, computeUnitPrice: 0n, quote: USDC }));
        console.log(`close_launch with its pot: ${closed}, ${await programCompute(closed, FAIR_OPEN_PROGRAM_ADDRESS)} compute units`);
        const after = (await rpc.getBalance(payer.address, { commitment: "confirmed" }).send()).value;
        expect(after - creatorBefore).toBe(rents.reduce((a: bigint, b) => a + b, 0n) - 5_000n);
        expect((await fetchMaybeLaunch(rpc, launch.launch)).exists).toBe(false);
        expect((await rpc.getAccountInfo(pot).send()).value).toBeNull();
        await closeNonce(launch.nonce, payer.address);
      } finally {
        await recoverDeposits(launch.launch, payer, depositors);
        // The USDC back to the bank, each depositor's account of it closed into the bank, and their SOL swept back.
        for (const d of depositors) {
          const account = await quoteTokenAccount(d.address, USDC);
          const amount = await quoteHeld(d.address, USDC);
          if (!(await rpc.getAccountInfo(account).send()).value) continue;
          await send(d, [
            ...(amount > 0n ? [getTransferCheckedInstruction({ source: account, mint: USDC.mint, destination: bankUsdc, authority: d, amount, decimals: 6 })] : []),
            getCloseAccountInstruction({ account, destination: payer.address, owner: d }),
          ]);
          const { value: left } = await rpc.getBalance(d.address, { commitment: "confirmed" }).send();
          if (left > 5_000n) await send(d, [getTransferSolInstruction({ source: d, destination: payer.address, amount: lamports(left - 5_000n) })]);
        }
      }
    },
    10 * 60_000,
  );
});

/** What a token account holds, in raw units; 0 once it is gone. */
async function quoteHeldAt(account: Address): Promise<bigint> {
  const balance = await rpc.getTokenAccountBalance(account, { commitment: "confirmed" }).send().catch(() => null);
  return balance ? BigInt(balance.value.amount) : 0n;
}
