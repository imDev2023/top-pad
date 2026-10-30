// An Instant launch on devnet, built exactly as the launch service builds it, with the creator buying in the same
// transaction: the pool lands on Heat's Instant config, the fee program records the coin, and the creator's own
// creation-slot buy pays the sniper tax's 99% cliff, since an Instant launch has no creator buy (spec 2.2 step 3). It
// spends real devnet SOL from Heat's devnet bank (about 0.03 SOL a run) and signs with the keeper key, which, like the
// bank, only this Mac holds (~/.config/top-pad/devnet, never CI); without them it is skipped.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  AccountRole,
  appendTransactionMessageInstructions,
  assertIsTransactionWithBlockhashLifetime,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase58Encoder,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getSignatureFromTransaction,
  getTransactionSize,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
} from "@solana/kit";
import { getSetComputeUnitLimitInstruction } from "@solana-program/compute-budget";
import { getTransferSolInstruction } from "@solana-program/system";
import { findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstructionAsync, getSyncNativeInstruction, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { describe, expect, it } from "vitest";
import {
  CLUSTERS,
  DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS,
  eventAuthorityAddress,
  INSTANT_LAUNCH_COMPUTE_UNITS,
  instantLaunchAccounts,
  instantLaunchInstructions,
  type InstantLaunch,
} from "@top-pad/chain";
import { fetchVirtualPool, findBaseVaultPda, findQuoteVaultPda, getEvtSwap2EventDecoder, getSwap2Instruction } from "@top-pad/clients/dbc";
import { fetchCoinRecord, LaunchMode } from "@top-pad/clients/fee";
import { SNIPER_TAX, FEE_DENOMINATOR } from "@top-pad/meteora";

const rpcUrl = process.env.DEVNET_RPC_URL || "https://api.devnet.solana.com";
const rpc = createSolanaRpc(rpcUrl);
const devnet = CLUSTERS.devnet!;
const keeperFile = join(homedir(), ".config/top-pad/devnet/keeper.json");
const walletFile = process.env.BANK_KEYPAIR || join(homedir(), ".config/top-pad/devnet/bank.json");
const load = async (path: string) => createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
const SYSVAR_INSTRUCTIONS = "Sysvar1nstructions1111111111111111111111111" as Address;
/** Anchor's tag for an event emitted through a self-CPI. */
const EVENT_IX_TAG = Uint8Array.from([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);
const BUY_LAMPORTS = 10_000_000n;

describe.skipIf(!existsSync(keeperFile) || !existsSync(walletFile))("an Instant launch on devnet", () => {
  it("creates the pool on the Instant config and the coin's record, and the creator's creation-slot buy pays 99%", { timeout: 120_000 }, async () => {
    const creator = await load(walletFile);
    const launchKey = await load(keeperFile);
    expect(launchKey.address).toBe(devnet.keys!.keeper);
    const mint = await generateKeyPairSigner();
    const launch: InstantLaunch = {
      config: devnet.configs!.instant,
      quoteMint: devnet.quote.mint,
      creator,
      mint,
      launchKey,
      coin: { name: "Heat Devnet Test", ticker: "HEATTEST", uri: "https://arweave.net/heat-devnet-instant-launch-test" },
      computeUnitPrice: 0n,
    };
    const { pool, coinRecord } = await instantLaunchAccounts(launch);
    const launchInstructions = await instantLaunchInstructions(launch);
    const { value: lifetime } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
    const message = (instructions: Instruction[]) =>
      pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayerSigner(creator, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
        (m) => appendTransactionMessageInstructions(instructions, m),
      );

    // The launch alone, as the launch service sends it: its size and compute, against the limit it sets.
    const alone = await signTransactionMessageWithSigners(message(launchInstructions));
    const { value: aloneSimulation } = await rpc
      .simulateTransaction(getBase64EncodedWireTransaction(alone), { encoding: "base64", sigVerify: true, commitment: "confirmed" })
      .send();
    expect(aloneSimulation.err, (aloneSimulation.logs ?? []).join("\n")).toBeNull();
    console.log(`the creation transaction alone: ${getTransactionSize(alone)} bytes, ${aloneSimulation.unitsConsumed} compute units`);
    expect(Number(aloneSimulation.unitsConsumed)).toBeLessThan(INSTANT_LAUNCH_COMPUTE_UNITS);

    // The creator's buy, in the same transaction: wrap SOL, open the coin account, swap.
    const [wsol] = await findAssociatedTokenPda({ owner: creator.address, mint: devnet.quote.mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const [coinAccount] = await findAssociatedTokenPda({ owner: creator.address, mint: mint.address, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const swap = getSwap2Instruction({
      config: launch.config,
      pool,
      baseVault: (await findBaseVaultPda({ baseMint: mint.address, pool }))[0],
      quoteVault: (await findQuoteVaultPda({ quoteMint: devnet.quote.mint, pool }))[0],
      inputTokenAccount: wsol,
      outputTokenAccount: coinAccount,
      baseMint: mint.address,
      quoteMint: devnet.quote.mint,
      payer: creator,
      tokenBaseProgram: TOKEN_PROGRAM_ADDRESS,
      tokenQuoteProgram: TOKEN_PROGRAM_ADDRESS,
      eventAuthority: await eventAuthorityAddress(DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS),
      program: DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS,
      params: { amount0: BUY_LAMPORTS, amount1: 0n, swapMode: 0 },
    });
    // The SOL is wrapped beforehand, so the creation transaction with the buy still fits in 1,232 bytes.
    const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions: createSolanaRpcSubscriptions(rpcUrl.replace(/^http/, "ws")) });
    const wrap = await signTransactionMessageWithSigners(
      message([
        await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: creator, owner: creator.address, mint: devnet.quote.mint }),
        getTransferSolInstruction({ source: creator, destination: wsol, amount: BUY_LAMPORTS }),
        getSyncNativeInstruction({ account: wsol }),
      ]),
    );
    assertIsTransactionWithBlockhashLifetime(wrap);
    await sendAndConfirm(wrap, { commitment: "confirmed" });
    const buy: Instruction[] = [
      await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: creator, owner: creator.address, mint: mint.address }),
      // DBC reads the instructions sysvar on a swap, as Meteora's SDK passes it.
      { ...swap, accounts: [...swap.accounts, { address: SYSVAR_INSTRUCTIONS, role: AccountRole.READONLY }] },
    ];
    const withBuy = [getSetComputeUnitLimitInstruction({ units: 400_000 }), ...launchInstructions.slice(1), ...buy];
    const transaction = await signTransactionMessageWithSigners(message(withBuy));
    assertIsTransactionWithBlockhashLifetime(transaction);
    await sendAndConfirm(transaction, { commitment: "confirmed" });
    const signature = getSignatureFromTransaction(transaction);
    console.log(`launched ${mint.address} in ${signature}`);

    const poolAccount = await fetchVirtualPool(rpc, pool);
    expect(poolAccount.data.poolState).toMatchObject({ config: devnet.configs!.instant, creator: creator.address, baseMint: mint.address });
    const record = await fetchCoinRecord(rpc, coinRecord);
    expect(record.data).toMatchObject({ mint: mint.address, pool, launchMode: LaunchMode.Instant, potFee: 0n, windowClaimed: false });

    // The creator's buy, read from DBC's own swap event: the fee it paid is the cliff, 98.999996%.
    const landed = await rpc.getTransaction(signature, { encoding: "base64", maxSupportedTransactionVersion: 0, commitment: "confirmed" }).send();
    const keys = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes).staticAccounts;
    const events = (landed!.meta!.innerInstructions ?? [])
      .flatMap((group) => group.instructions)
      .filter((ix) => keys[ix.programIdIndex] === DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS)
      .map((ix) => new Uint8Array(getBase58Encoder().encode(ix.data)))
      .filter((data) => EVENT_IX_TAG.every((b, i) => data[i] === b))
      .map((data) => {
        try {
          return getEvtSwap2EventDecoder().decode(data.subarray(8));
        } catch {
          return null;
        }
      })
      .filter((e) => e !== null);
    expect(events).toHaveLength(1);
    const { swapResult } = events[0]!;
    const fee = swapResult.tradingFee + swapResult.protocolFee + swapResult.referralFee;
    console.log(`the creator's buy: ${swapResult.includedFeeInputAmount} lamports in, ${fee} paid in fees, ${swapResult.outputAmount} coin units out`);
    expect(swapResult.includedFeeInputAmount).toBe(BUY_LAMPORTS);
    // The cliff, within DBC's rounding of a lamport; a second later the fee would already be 16,291,666 lower a billion.
    const cliff = (BUY_LAMPORTS * SNIPER_TAX.cliffFeeNumerator) / FEE_DENOMINATOR;
    expect(fee >= cliff && fee <= cliff + 1n, `${fee} against ${cliff}`).toBe(true);
  });
});
