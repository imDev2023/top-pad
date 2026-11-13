// A creator's bundle on devnet, as spec 11.1's bundler simulation runs one: the Creator wallet funds wallets directly, then
// it and they buy a coin the moment it launches, so their buys land in its creation slot. Devnet runs no Jito block
// engine, and on Heat no creator could bundle with the creation anyway, since our launch key co-signs and sends it; so
// the buys are signed in advance, as few transactions as fit (each wallet signing its own swap), and sent again and again
// a lamport apart through the window in which the launch goes out. A copy sent before the coin exists fails, paying only
// its fee; the first ones after it land in its slot. Every call spends real devnet SOL.
import { readFileSync } from "node:fs";
import {
  appendTransactionMessageInstructions,
  createKeyPairSignerFromPrivateKeyBytes,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  getUtf8Encoder,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Base64EncodedWireTransaction,
  type KeyPairSigner,
  type Signature,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  findAssociatedTokenPda,
  getCloseAccountInstruction,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getSyncNativeInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { dbcPoolAddress, DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS, swapInstructions } from "@top-pad/chain";
import { bankFile, coinBalance, devnet, rpc, rpcUrl, send, sweep } from "./devnet";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const WSOL = devnet.quote.mint;

/**
 * A run's wallets, derived from Heat's bank key and the run's name, so a run stopped partway can be swept back by name
 * (`pnpm exec tsx tests/devnet/src/bundle-sweep.ts <run> [mint]`): throwaway wallets whose keys die with a run lose
 * what they hold.
 */
export async function runWallets(run: string) {
  const secret = Uint8Array.from(JSON.parse(readFileSync(bankFile, "utf8")) as number[]).slice(0, 32);
  const wallet = async (label: string) =>
    createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array([...secret, ...getUtf8Encoder().encode(`heat devnet bundle ${run} ${label}`)]))));
  return { creator: await wallet("creator"), sniper: await wallet("sniper"), funded: await Promise.all([0, 1, 2, 3].map((i) => wallet(`funded ${i}`))) };
}

/** Sells what a run's wallets hold of each coin, closes their accounts, and sends everything left back to the bank. */
export async function sweepRun(run: string, mints: Address[], config = devnet.configs!.instant) {
  const { creator, sniper, funded } = await runWallets(run);
  const all = [...funded, sniper, creator];
  for (const mint of mints) for (const w of all) await sellAndClose(w, mint, config).catch((e) => console.warn(`selling ${mint} from ${w.address} failed`, e));
  await sweep(...all);
}

/** The Creator wallet sends each wallet `lamports` directly, in one transaction: the direct link Bundle Radar follows. */
export const fundDirectly = (from: KeyPairSigner, wallets: Address[], lamports: bigint) =>
  send(
    from,
    wallets.map((destination) => getTransferSolInstruction({ source: from, destination, amount: lamports })),
  );

/** Wraps `lamports` of a wallet's SOL into its wrapped-SOL account, ready for buys that carry no wrapping of their own. */
export async function wrapSol(wallet: KeyPairSigner, lamports: bigint) {
  const [account] = await findAssociatedTokenPda({ owner: wallet.address, mint: WSOL, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  return send(wallet, [
    await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: wallet, owner: wallet.address, mint: WSOL }),
    getTransferSolInstruction({ source: wallet, destination: account, amount: lamports }),
    getSyncNativeInstruction({ account }),
  ]);
}

/** A buy from wrapped SOL already in the wallet: the coin's account made if need be, then DBC's `swap2`. */
async function bareBuy(trader: KeyPairSigner, mint: Address, config: Address, amountIn: bigint) {
  const pool = await dbcPoolAddress(config, mint, WSOL);
  const ixs = await swapInstructions({ config, pool, mint, quoteMint: WSOL, quoteTokenProgram: TOKEN_PROGRAM_ADDRESS, trader, side: "buy", amountIn, minimumOut: 1n });
  // swapInstructions wraps and unwraps around the swap: keep the coin account's creation and the swap alone.
  const kept = ixs.filter((ix, i) => ix.programAddress === DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS || (i > 0 && ix.accounts?.some((a) => a.address === mint)));
  if (kept.length !== 2 || kept[1]!.programAddress !== DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS) throw new Error("a buy is the coin account's creation and the swap");
  return kept;
}

export type BundleCopy = { wire: Base64EncodedWireTransaction; signature: Signature; buyers: Address[] };

/**
 * The bundle's buys, signed in advance: `copies` copies of each group's transaction, each copy's buys a lamport larger
 * than the last so each is its own transaction, copy by copy, each copy's groups together. Each group's first wallet
 * pays the fee.
 */
export async function signedBundle(groups: KeyPairSigner[][], mint: Address, config: Address, amountIn: bigint, copies: number): Promise<BundleCopy[]> {
  const { value: lifetime } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const signed: BundleCopy[] = [];
  for (let copy = 0; copy < copies; copy++) {
    for (const group of groups) {
      const buys = (await Promise.all(group.map((buyer) => bareBuy(buyer, mint, config, amountIn + BigInt(copy))))).flat();
      const transaction = await signTransactionMessageWithSigners(
        pipe(
          createTransactionMessage({ version: 0 }),
          (m) => setTransactionMessageFeePayerSigner(group[0]!, m),
          (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
          (m) => appendTransactionMessageInstructions(buys, m),
        ),
      );
      signed.push({ wire: getBase64EncodedWireTransaction(transaction), signature: getSignatureFromTransaction(transaction), buyers: group.map((b) => b.address) });
    }
  }
  return signed;
}

/**
 * Sends each round's copies at once, rounds `everyMs` apart, without preflight: a copy sent before the coin exists would
 * fail its simulation, and must reach the leader all the same. A send the endpoint refuses (429) is passed over.
 */
export async function spray(rounds: BundleCopy[][], everyMs: number) {
  const sent: Promise<unknown>[] = [];
  for (const round of rounds) {
    // Straight to the endpoint, never waiting out a 429 as the shared RPC client does: a late copy is a wasted one.
    for (const copy of round) {
      sent.push(
        fetch(rpcUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sendTransaction", params: [copy.wire, { encoding: "base64", skipPreflight: true, maxRetries: 0 }] }),
        }).catch(() => undefined),
      );
    }
    await sleep(everyMs);
  }
  await Promise.all(sent);
}

/** Each signature's landing, once every one has landed, failed or was never seen in 40 s: its slot and error. */
export async function landings(signatures: Signature[]) {
  const found = new Map<Signature, { slot: bigint; err: unknown }>();
  for (let poll = 0; poll < 40 && found.size < signatures.length; poll++) {
    await sleep(1_000);
    const open = signatures.filter((s) => !found.has(s));
    for (let i = 0; i < open.length; i += 200) {
      const batch = open.slice(i, i + 200);
      const { value } = await rpc.getSignatureStatuses(batch, { searchTransactionHistory: true }).send();
      batch.forEach((s, j) => {
        const status = value[j];
        if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") found.set(s, { slot: status.slot, err: status.err });
      });
    }
  }
  return found;
}

/** Sells every coin a wallet holds on the coin's curve, then closes its coin and wrapped-SOL accounts for their rent. */
export async function sellAndClose(wallet: KeyPairSigner, mint: Address, config: Address) {
  const coins = await coinBalance(wallet.address, mint);
  const pool = await dbcPoolAddress(config, mint, WSOL);
  const [coinAccount] = await findAssociatedTokenPda({ owner: wallet.address, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  const [wsolAccount] = await findAssociatedTokenPda({ owner: wallet.address, mint: WSOL, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  const sell = coins > 0n ? await swapInstructions({ config, pool, mint, quoteMint: WSOL, quoteTokenProgram: TOKEN_PROGRAM_ADDRESS, trader: wallet, side: "sell", amountIn: coins, minimumOut: 1n }) : [];
  const { value: coinInfo } = await rpc.getAccountInfo(coinAccount, { commitment: "confirmed", encoding: "base64" }).send();
  const { value: wsolInfo } = await rpc.getAccountInfo(wsolAccount, { commitment: "confirmed", encoding: "base64" }).send();
  // A sell unwraps and closes the wrapped-SOL account itself; without one, close what is left open.
  const closes = [
    ...(coinInfo ? [getCloseAccountInstruction({ account: coinAccount, destination: wallet.address, owner: wallet })] : []),
    ...(!sell.length && wsolInfo ? [getCloseAccountInstruction({ account: wsolAccount, destination: wallet.address, owner: wallet })] : []),
  ];
  if (sell.length || closes.length) await send(wallet, [...sell, ...closes]);
}
