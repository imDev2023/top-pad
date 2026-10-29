// The fee claims on devnet (#44), against DBC's deployed program and the fee program upgraded with them: an Instant
// launch built as the launch service builds it, trades inside its Tax window and after it, the window claim, the
// creator's claim, and the creator role handed to another wallet. Each step reads back what the chain paid, to the
// lamport. It spends about 0.05 devnet SOL from the Solana CLI's wallet and signs with the keeper key, which only this
// Mac holds (~/.config/top-pad/devnet/keeper.json, never CI); without it, it is skipped.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  appendTransactionMessageInstructions,
  compileTransaction,
  createKeyPairSignerFromBytes,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
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
import { fetchCoinRecord, findCoinRecordPda, getClaimFeesInstructionAsync } from "@top-pad/clients/fee";
import { decodeTransaction, fetchRawTransaction } from "@top-pad/indexer";
import { devnet, fundedWallets, rpc, rpcUrl, send, swap, sweep } from "./devnet";

const keeperFile = join(homedir(), ".config/top-pad/devnet/keeper.json");
const load = async (path: string) => createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const HEAT = new Set<string>([devnet.configs!.instant, devnet.configs!.fairOpen]);
const quoteMint = devnet.quote.mint;
const treasury = devnet.keys!.treasury;
/** A transaction's network fee: one signature, no priority fee. */
const NETWORK_FEE = 5_000n;
/** The fee program's custom errors this test meets (programs/fee, `FeeError`). */
const TAX_WINDOW_OPEN = 6009;
const NOT_THE_CREATORS_ACCOUNT = 6013;

const pool = async (address: Address): Promise<ClaimablePool> => claimablePool(address, (await fetchVirtualPool(rpc, address)).data.poolState, quoteMint);
const lamports = async (owner: Address) => (await rpc.getBalance(owner, { commitment: "confirmed" }).send()).value;
async function tokens(account: Address) {
  const { value } = await rpc.getTokenAccountBalance(account, { commitment: "confirmed" }).send().catch(() => ({ value: { amount: "0" } }));
  return BigInt(value.amount);
}

/** The chain's clock now: the block time of the latest confirmed slot. */
async function chainTime(): Promise<bigint> {
  const slot = await rpc.getSlot({ commitment: "confirmed" }).send();
  return BigInt((await rpc.getBlockTime(slot).send()) ?? 0n);
}

/** What the fee program used of a landed transaction's compute, from its log lines. */
async function feeProgramCompute(signature: string): Promise<number[]> {
  const tx = await landed(signature);
  const pattern = new RegExp(`^Program ${FEE_PROGRAM_ADDRESS} consumed (\\d+) of`);
  return (tx?.meta?.logMessages ?? []).flatMap((line) => {
    const match = pattern.exec(line);
    return match ? [Number(match[1])] : [];
  });
}

/**
 * A landed transaction as the RPC serves it, asked again while it is not served yet or the public endpoint answers
 * 429, whose per-IP budget every session on this Mac shares.
 */
async function landed(signature: string) {
  for (let attempt = 0; ; attempt++) {
    const raw = await fetchRawTransaction(rpcUrl, signature).catch((e: Error) => {
      if (!/429/.test(e.message) || attempt > 8) throw e;
      return null;
    });
    if (raw) return raw;
    if (attempt > 12) throw new Error(`${signature} was not served`);
    await sleep(Math.min(1_000 * 2 ** Math.min(attempt, 3), 8_000));
  }
}

/** A landed transaction as the indexer decodes it. */
const decoded = async (signature: string) => decodeTransaction(await landed(signature), HEAT);

/** The custom error a simulated transaction of `instructions` fails with, `payer` paying. */
async function simulatedError(payer: KeyPairSigner, instructions: Instruction[]): Promise<number | null> {
  const { value: lifetime } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const signed = await signTransactionMessageWithSigners(
    pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(payer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
      (m) => appendTransactionMessageInstructions(instructions, m),
    ),
  );
  const { value } = await rpc.simulateTransaction(getBase64EncodedWireTransaction(signed), { encoding: "base64", commitment: "confirmed" }).send();
  const err = value.err as { InstructionError?: [number, { Custom?: bigint | number }] } | null;
  const custom = err?.InstructionError?.[1]?.Custom;
  return custom !== undefined ? Number(custom) : err ? -1 : null;
}

describe.skipIf(!existsSync(keeperFile))("fee claims on devnet", () => {
  it(
    "pays the Tax window to the treasury at 60 s, then splits later fees 50/50 with whoever holds the creator role",
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
        const { pool: address } = await instantLaunchAccounts(launch);
        await send(creator, await instantLaunchInstructions(launch));
        const opened = await pool(address);
        console.log(`launched ${mint.address}, pool ${address}, its Tax window ending at ${opened.windowEndsAt}`);

        // Two buys inside the window pay the sniper tax; the partner's 80% of it waits in the pool.
        await swap(trader, mint.address, "buy", 10_000_000n);
        await swap(trader, mint.address, "buy", 10_000_000n);
        const taxed = (await pool(address)).partnerQuoteFee;
        console.log(`the window's buys left ${taxed} lamports of partner fees`);
        expect(taxed).toBeGreaterThan(10_000_000n);

        // The window claim is refused until the chain's clock passes the window's end.
        const windowClaim = (p: ClaimablePool) => windowClaimInstructions({ pool: p, heat: true, treasury, payer: keeper, computeUnitPrice: 0n });
        if ((await chainTime()) < opened.windowEndsAt - 3n) expect(await simulatedError(keeper, await windowClaim(await pool(address)))).toBe(TAX_WINDOW_OPEN);
        while ((await chainTime()) < opened.windowEndsAt) await sleep(1_000);

        // A trade lands after the window and before the claim: its normal fee is moved into the window by the late claim.
        const lateTrade = await swap(trader, mint.address, "buy", 50_000_000n);
        const late = (await decoded(lateTrade)).swaps[0]!;
        expect(late.timestamp).toBeGreaterThanOrEqual(opened.windowEndsAt);
        const beforeClaim = await pool(address);
        const treasuryAccount = await quoteAccount(treasury, quoteMint);
        const treasuryBefore = await tokens(treasuryAccount);
        const claimSignature = await send(keeper, await windowClaim(beforeClaim));
        const [window] = (await decoded(claimSignature)).windowClaims;
        expect(window).toMatchObject({ pool: address, mint: mint.address, heat: true, destination: treasuryAccount, amount: beforeClaim.partnerQuoteFee });
        expect(window!.windowEndedAt).toBe(opened.windowEndsAt);
        expect(await tokens(treasuryAccount)).toBe(treasuryBefore + beforeClaim.partnerQuoteFee);
        const movedNormal = beforeClaim.partnerQuoteFee - taxed;
        console.log(
          `the window claim ran ${window!.claimedAt - window!.windowEndedAt} s late and paid ${window!.amount} lamports: ` +
            `${taxed} of tax and ${movedNormal} of one late trade's normal fee; fee program compute ${await feeProgramCompute(claimSignature)}`,
        );
        expect((await fetchCoinRecord(rpc, (await findCoinRecordPda({ mint: mint.address }))[0])).data.windowClaimed).toBe(true);
        expect((await pool(address)).partnerQuoteFee).toBe(0n);
        expect(await tokens(await quoteAccount(FEE_CLAIMER_ADDRESS, quoteMint))).toBe(0n);

        // Normal trades after the claim: their fees are the creator's half and the treasury's half.
        await swap(trader, mint.address, "buy", 80_000_000n);
        const shown = (await pool(address)).partnerQuoteFee;
        const share = creatorShare(shown);
        // More fees land after the page showed its figure; the claim pays exactly the figure.
        await swap(trader, mint.address, "buy", 20_000_000n);
        const accrued = (await pool(address)).partnerQuoteFee;
        const creatorBefore = await lamports(creator.address);
        const treasuryBeforeSplit = await tokens(treasuryAccount);
        const { value: lifetime } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
        const claimAll = async (who: KeyPairSigner, maxAmount: bigint) => {
          const [message, ...more] = await creatorClaimMessages(
            { creator: who, treasury, computeUnitPrice: 0n, claims: [{ pool: await pool(address), heat: true, maxAmount }] },
            lifetime,
          );
          expect(more).toHaveLength(0);
          console.log(`a one-pool creator's claim is ${compileTransaction(message!).messageBytes.length} bytes of message`);
          return send(who, message!.instructions as Instruction[]);
        };
        const split = await claimAll(creator, shown);
        expect(await lamports(creator.address)).toBe(creatorBefore + share - NETWORK_FEE);
        expect(await tokens(treasuryAccount)).toBe(treasuryBeforeSplit + shown - share);
        expect((await pool(address)).partnerQuoteFee).toBe(accrued - shown);
        const [paid] = (await decoded(split)).feeClaims;
        expect(paid).toMatchObject({ pool: address, creator: creator.address, creatorAmount: share, treasuryAmount: shown - share });
        console.log(`the creator's claim paid them ${share} and the treasury ${shown - share}; fee program compute ${await feeProgramCompute(split)}`);

        // Claimed again, only what accrued after the figure is paid, and a third claim pays nothing: no fee twice.
        const rest = accrued - shown;
        const second = await claimAll(creator, 2n ** 64n - 1n);
        expect((await decoded(second)).feeClaims).toMatchObject([{ creatorAmount: creatorShare(rest), treasuryAmount: rest - creatorShare(rest) }]);
        const third = await claimAll(creator, 2n ** 64n - 1n);
        expect((await decoded(third)).feeClaims).toEqual([]);
        expect((await pool(address)).partnerQuoteFee).toBe(0n);
        expect(await lamports(creator.address)).toBe(creatorBefore + share + creatorShare(rest) - 3n * NETWORK_FEE);

        // The creator role moves to another wallet: the next claim pays the new holder, and the old one's is refused.
        const config = devnet.configs!.instant;
        await send(creator, [
          getTransferPoolCreatorInstruction({
            virtualPool: address,
            config,
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
          window: (await findCoinRecordPda({ mint: mint.address }))[0],
          creatorTokenAccount: await quoteAccount(creator.address, quoteMint),
          treasuryTokenAccount: treasuryAccount,
          feeClaimerTokenAccount: await quoteAccount(FEE_CLAIMER_ADDRESS, quoteMint),
          config,
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
        const heirs = await claimAll(heir, toHeir.partnerQuoteFee);
        expect(await lamports(heir.address)).toBe(heirBefore + creatorShare(toHeir.partnerQuoteFee) - NETWORK_FEE);
        expect((await decoded(heirs)).feeClaims[0]).toMatchObject({ creator: heir.address, creatorAmount: creatorShare(toHeir.partnerQuoteFee) });
        console.log(`after the handover the heir was paid ${creatorShare(toHeir.partnerQuoteFee)} lamports`);
      } finally {
        await sweep(creator, trader, heir);
      }
    },
  );
});
