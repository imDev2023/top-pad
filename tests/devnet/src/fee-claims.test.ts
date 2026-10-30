// The fee claims on devnet (#44), against DBC's deployed program and the fee program upgraded with them. A Heat coin,
// launched as the launch service launches it: the window claim refused inside its Tax window, then run once it ends,
// whether this test's claim or the deployed keeper's lands first, paying exactly the window's tax; then the creator's
// claim, exact while fees accrue, and the creator role handed to another wallet. And a pool made around Heat's flow,
// which no keeper claims, so a claim sent late can be shown moving exactly the late seconds' fees. Each step reads back
// what the chain paid, to the lamport. It spends about 0.1 devnet SOL from the Solana CLI's wallet and signs with the
// keeper key, which only this Mac holds (~/.config/top-pad/devnet/keeper.json, never CI); without it, it is skipped.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  compileTransaction,
  createKeyPairSignerFromBytes,
  generateKeyPairSigner,
  type Address,
  type Instruction,
  type KeyPairSigner,
} from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  claimablePool,
  creatorClaimMessages,
  creatorShare,
  DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS,
  eventAuthorityAddress,
  FEE_CLAIMER_ADDRESS,
  FEE_PROGRAM_ADDRESS,
  instantLaunchAccounts,
  instantLaunchInstructions,
  quoteAccount,
  TOKEN_PROGRAM_ADDRESS,
  windowClaimInstructions,
  type ClaimablePool,
  type InstantLaunch,
} from "@top-pad/chain";
import { fetchVirtualPool, getTransferPoolCreatorInstruction } from "@top-pad/clients/dbc";
import { fetchCoinRecord, fetchWindowClaim, findWindowClaimPda, getClaimFeesInstructionAsync } from "@top-pad/clients/fee";
import { decodeTransaction, type WindowClaimed } from "@top-pad/indexer";
import { chainTime, devnet, fundedWallets, landed, poolAroundHeat, programCompute, rpc, send, simulatedError, swap, sweep } from "./devnet";

const keeperFile = join(homedir(), ".config/top-pad/devnet/keeper.json");
const load = async (path: string) => createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const HEAT = new Set<string>([devnet.configs!.instant, devnet.configs!.fairOpen]);
const quoteMint = devnet.quote.mint;
const treasury = devnet.keys!.treasury;
const MAX = 2n ** 64n - 1n;
/** A transaction's network fee: one signature, no priority fee. */
const NETWORK_FEE = 5_000n;
/** The fee program's custom errors this test meets (programs/fee, `FeeError`). */
const TAX_WINDOW_OPEN = 6009;
const WINDOW_ALREADY_CLAIMED = 6010;
const NOT_THE_CREATORS_ACCOUNT = 6013;

const pool = async (address: Address): Promise<ClaimablePool> => claimablePool(address, (await fetchVirtualPool(rpc, address)).data.poolState, quoteMint);
const lamports = async (owner: Address) => (await rpc.getBalance(owner, { commitment: "confirmed" }).send()).value;

/** A landed transaction as the indexer decodes it. */
const decoded = async (signature: string) => decodeTransaction(await landed(signature), HEAT);

/** What the fee program used of a landed transaction's compute. */
const feeProgramCompute = (signature: string) => programCompute(signature, FEE_PROGRAM_ADDRESS);

/** How a landed transaction changed `owner`'s balance of the quote, from its own token balances. */
async function quoteChange(signature: string, owner: Address): Promise<bigint> {
  type Balance = { owner?: string; mint: string; uiTokenAmount: { amount: string } };
  const meta = (await landed(signature)).meta as { preTokenBalances?: Balance[]; postTokenBalances?: Balance[] };
  const of = (balances: Balance[] = []) => BigInt(balances.find((b) => b.owner === owner && b.mint === quoteMint)?.uiTokenAmount.amount ?? "0");
  return of(meta.postTokenBalances) - of(meta.preTokenBalances);
}

/** The window claim among an account's transactions (a coin's record), newest first. */
async function windowClaimAmong(account: Address, mint: Address): Promise<{ signature: string; claim: WindowClaimed }> {
  const signatures = await rpc.getSignaturesForAddress(account, { limit: 10, commitment: "confirmed" }).send();
  for (const { signature, err } of signatures) {
    if (err) continue;
    const claim = (await decoded(signature)).windowClaims.find((w) => w.mint === mint);
    if (claim) return { signature, claim };
  }
  throw new Error(`no window claim of ${mint} among ${account}'s transactions`);
}

/** A creator's claim of one pool, signed and sent by the creator. */
async function claimAll(who: KeyPairSigner, p: ClaimablePool, heat: boolean, maxAmount: bigint) {
  const { value: lifetime } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const [message, ...more] = await creatorClaimMessages({ creator: who, treasury, computeUnitPrice: 0n, claims: [{ pool: p, heat, maxAmount }] }, lifetime);
  expect(more).toHaveLength(0);
  return { signature: await send(who, message!.instructions as Instruction[]), bytes: compileTransaction(message!).messageBytes.length };
}

describe.skipIf(!existsSync(keeperFile))("fee claims on devnet", () => {
  it(
    "pays a Heat coin's Tax window to the treasury once it ends, then splits later fees 50/50 with whoever holds the creator role",
    { timeout: 360_000 },
    async () => {
      const keeper = await load(keeperFile);
      expect(keeper.address).toBe(devnet.keys!.keeper);
      const [creator, trader, heir] = await fundedWallets(60_000_000n, 300_000_000n, 10_000_000n);
      try {
        // An Instant launch, as the launch service builds it, with the Creator wallet as DBC's creator.
        const mint = await generateKeyPairSigner();
        const launch: InstantLaunch = {
          config: devnet.configs!.instant,
          quoteMint,
          creator,
          mint,
          launchKey: keeper,
          coin: { name: "Heat Fee Claims Test", ticker: "HEATFEES", uri: "https://turbo-gateway.com/heat-devnet-fee-claims-test" },
          computeUnitPrice: 0n,
        };
        const { pool: address, coinRecord } = await instantLaunchAccounts(launch);
        await send(creator, await instantLaunchInstructions(launch));
        const opened = await pool(address);

        // Two buys inside the window pay the sniper tax; the partner's 80% of it waits in the pool.
        await swap(trader, mint.address, "buy", 10_000_000n);
        await swap(trader, mint.address, "buy", 10_000_000n);
        const taxed = (await pool(address)).partnerQuoteFee;
        expect(taxed).toBeGreaterThan(2_000_000n);

        // Refused while the chain's clock is inside the window.
        const windowClaim = async () => windowClaimInstructions({ pool: await pool(address), heat: true, treasury, payer: keeper, computeUnitPrice: 0n });
        if ((await chainTime()) < opened.windowEndsAt - 3n) expect(await simulatedError(keeper, await windowClaim())).toBe(TAX_WINDOW_OPEN);
        while ((await chainTime()) < opened.windowEndsAt) await sleep(500);

        // This test's claim races the deployed keeper's, which keeps every Heat coin on devnet: whichever lands first
        // runs the window claim, once, and the other is refused.
        const ours = await send(keeper, await windowClaim()).catch((e: { cause?: { context?: { code?: number } } }) => {
          if (e.cause?.context?.code !== WINDOW_ALREADY_CLAIMED) throw e;
          return null;
        });
        const { signature, claim } = await windowClaimAmong(coinRecord, mint.address);
        const treasuryAccount = await quoteAccount(treasury, quoteMint);
        expect(claim).toMatchObject({ pool: address, heat: true, destination: treasuryAccount, amount: taxed, windowEndedAt: opened.windowEndsAt });
        expect(claim.claimedAt - claim.windowEndedAt).toBeLessThan(10n);
        expect(await quoteChange(signature, treasury)).toBe(taxed);
        console.log(
          `the window claim (${ours === signature ? "this test's" : "the deployed keeper's"}) ran ${claim.claimedAt - claim.windowEndedAt} s ` +
            `after the window ended and paid the treasury ${claim.amount} lamports; claim_window_fees used ${await feeProgramCompute(signature)} compute units`,
        );
        expect((await fetchCoinRecord(rpc, coinRecord)).data.windowClaimed).toBe(true);
        expect((await pool(address)).partnerQuoteFee).toBe(0n);
        expect(await simulatedError(keeper, await windowClaim())).toBe(WINDOW_ALREADY_CLAIMED);

        // Normal trades after the claim: their fees are the creator's half and the treasury's half. More fees land after
        // the creator's page showed its figure; the claim pays exactly the figure.
        await swap(trader, mint.address, "buy", 80_000_000n);
        const shown = (await pool(address)).partnerQuoteFee;
        await swap(trader, mint.address, "buy", 20_000_000n);
        const accrued = (await pool(address)).partnerQuoteFee;
        const creatorBefore = await lamports(creator.address);
        const split = await claimAll(creator, await pool(address), true, shown);
        expect(await lamports(creator.address)).toBe(creatorBefore + creatorShare(shown) - NETWORK_FEE);
        expect(await quoteChange(split.signature, treasury)).toBe(shown - creatorShare(shown));
        expect((await pool(address)).partnerQuoteFee).toBe(accrued - shown);
        expect((await decoded(split.signature)).feeClaims).toMatchObject([{ pool: address, creator: creator.address, creatorAmount: creatorShare(shown) }]);
        console.log(
          `the creator's claim (${split.bytes} bytes of message) paid them ${creatorShare(shown)} and the treasury ${shown - creatorShare(shown)}; ` +
            `claim_fees used ${await feeProgramCompute(split.signature)} compute units`,
        );

        // Claimed again, only what accrued after the figure is paid, and a third claim pays nothing: no fee twice.
        const rest = accrued - shown;
        const second = await claimAll(creator, await pool(address), true, MAX);
        expect((await decoded(second.signature)).feeClaims).toMatchObject([{ creatorAmount: creatorShare(rest), treasuryAmount: rest - creatorShare(rest) }]);
        const third = await claimAll(creator, await pool(address), true, MAX);
        expect((await decoded(third.signature)).feeClaims).toEqual([]);
        expect(await lamports(creator.address)).toBe(creatorBefore + creatorShare(shown) + creatorShare(rest) - 3n * NETWORK_FEE);

        // The creator role moves to another wallet: the next claim pays the new holder, and the old one's is refused.
        await send(creator, [
          getTransferPoolCreatorInstruction({
            virtualPool: address,
            config: devnet.configs!.instant,
            creator,
            newCreator: heir.address,
            eventAuthority: await eventAuthorityAddress(DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS),
            program: DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS,
          }),
        ]);
        await swap(trader, mint.address, "sell", 1_000_000_000n);
        const toHeir = await pool(address);
        expect(toHeir.creator).toBe(heir.address);
        const oldCreators = await getClaimFeesInstructionAsync({
          window: coinRecord,
          creatorTokenAccount: await quoteAccount(creator.address, quoteMint),
          treasuryTokenAccount: treasuryAccount,
          feeClaimerTokenAccount: await quoteAccount(FEE_CLAIMER_ADDRESS, quoteMint),
          config: devnet.configs!.instant,
          pool: address,
          baseVault: toHeir.baseVault,
          quoteVault: toHeir.quoteVault,
          mint: mint.address,
          quoteMint,
          tokenBaseProgram: TOKEN_PROGRAM_ADDRESS,
          tokenQuoteProgram: TOKEN_PROGRAM_ADDRESS,
          eventAuthority: await eventAuthorityAddress(FEE_PROGRAM_ADDRESS),
          program: FEE_PROGRAM_ADDRESS,
          maxAmount: toHeir.partnerQuoteFee,
        });
        expect(await simulatedError(creator, [oldCreators])).toBe(NOT_THE_CREATORS_ACCOUNT);
        const heirBefore = await lamports(heir.address);
        const heirs = await claimAll(heir, toHeir, true, toHeir.partnerQuoteFee);
        expect(await lamports(heir.address)).toBe(heirBefore + creatorShare(toHeir.partnerQuoteFee) - NETWORK_FEE);
        expect((await decoded(heirs.signature)).feeClaims[0]).toMatchObject({ creator: heir.address, creatorAmount: creatorShare(toHeir.partnerQuoteFee) });
      } finally {
        await sweep(creator, trader, heir);
      }
    },
  );

  it(
    "pays a pool made around Heat's flow its window too, and a claim sent late moves exactly the late seconds' fees",
    { timeout: 240_000 },
    async () => {
      const [stranger, trader] = await fundedWallets(60_000_000n, 150_000_000n);
      try {
        // No keeper claims a pool no record lists, so this test alone decides when its window claim runs.
        const { mint, pool: address } = await poolAroundHeat(stranger);
        const opened = await pool(address);
        await swap(trader, mint, "buy", 10_000_000n);
        const taxed = (await pool(address)).partnerQuoteFee;
        while ((await chainTime()) < opened.windowEndsAt) await sleep(500);

        // A trade after the window and before the claim: the late claim moves its normal fee, and nothing else.
        const late = (await decoded(await swap(trader, mint, "buy", 50_000_000n))).swaps[0]!;
        expect(late.timestamp).toBeGreaterThanOrEqual(opened.windowEndsAt);
        const beforeClaim = await pool(address);
        const lateFee = beforeClaim.partnerQuoteFee - taxed;
        const claim = await send(stranger, await windowClaimInstructions({ pool: beforeClaim, heat: false, treasury, payer: stranger, computeUnitPrice: 0n }));
        const [window] = (await decoded(claim)).windowClaims;
        expect(window).toMatchObject({ pool: address, heat: false, amount: taxed + lateFee });
        expect(await quoteChange(claim, treasury)).toBe(taxed + lateFee);
        console.log(
          `a window claim ${window!.claimedAt - window!.windowEndedAt} s late paid ${taxed} lamports of tax and ${lateFee} of one late ` +
            `trade's normal fee; claim_unlisted_window_fees used ${await feeProgramCompute(claim)} compute units`,
        );
        const [windowClaim] = await findWindowClaimPda({ pool: address });
        expect((await fetchWindowClaim(rpc, windowClaim)).data.pool).toBe(address);

        // After it, the pool's fees split like a Heat coin's, with its own creator.
        await swap(trader, mint, "buy", 40_000_000n);
        const fees = (await pool(address)).partnerQuoteFee;
        const before = await lamports(stranger.address);
        await claimAll(stranger, await pool(address), false, fees);
        expect(await lamports(stranger.address)).toBe(before + creatorShare(fees) - NETWORK_FEE);
      } finally {
        await sweep(stranger, trader);
      }
    },
  );
});
