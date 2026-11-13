// The board demo's wallets (board.spec.ts), derived from the bank's key and the run's name, and the sweep that brings a
// run's SOL back to the bank: each wallet sells what it holds of the run's coins (Instant coins on the Instant config,
// the Fair Open's coin on the Fair Open config), then sends the rest to the bank.
import { createKeyPairSignerFromPrivateKeyBytes, getUtf8Encoder, type Address } from "@solana/kit";
import { sellAndClose } from "@top-pad/tests-devnet/bundle";
import { bankFile, devnet, fund, rpc, sweep } from "@top-pad/tests-devnet/devnet";
import { sellAll } from "@top-pad/tests-devnet/fair-open";
import { readFileSync } from "node:fs";

export async function boardWallets(run: string) {
  const secret = Uint8Array.from(JSON.parse(readFileSync(bankFile, "utf8")) as number[]).slice(0, 32);
  const wallet = async (label: string) =>
    createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array([...secret, ...getUtf8Encoder().encode(`heat devnet board ${run} ${label}`)]))));
  const many = (label: string, n: number) => Promise.all(Array.from({ length: n }, (_, i) => wallet(`${label} ${i}`)));
  const w = {
    creators: await many("creator", 5),
    openNow: await wallet("fair open now"),
    openLater: await wallet("fair open later"),
    bot: await wallet("bot"),
    buyers: await many("buyer", 7),
    depositor: await wallet("depositor"),
    around: await wallet("around"),
  };
  return { ...w, all: [...w.creators, w.openNow, w.openLater, w.bot, ...w.buyers, w.depositor, w.around] };
}

/** What a wallet needs to pay for its sells: one left emptier is topped up from the bank first, and swept back after. */
const FEES = 3_000_000n;

/** Sells what the run's wallets hold of its Instant coins and its Fair Open's coin, then sweeps every wallet to the bank. */
export async function sweepBoardRun(run: string, instantMints: Address[], fairOpenMint: Address | null) {
  const w = await boardWallets(run);
  if (fairOpenMint || instantMints.length) {
    const low = [];
    for (const wallet of [w.depositor, w.bot, ...w.buyers]) if ((await rpc.getBalance(wallet.address, { commitment: "confirmed" }).send()).value < FEES) low.push(wallet);
    if (low.length) await fund(low, low.map(() => FEES));
  }
  if (fairOpenMint) await sellAll(w.depositor, fairOpenMint).catch((e) => console.warn(`selling ${fairOpenMint} failed`, e));
  for (const mint of instantMints) {
    for (const wallet of [w.bot, ...w.buyers]) await sellAndClose(wallet, mint, devnet.configs!.instant).catch(() => undefined);
  }
  await sweep(...w.all);
}

// `pnpm exec tsx tests/ui/src/boardRun.ts <run> [--fair-open <mint>] [instant mint...]`: sweeps a stopped run.
if (process.argv[1]?.endsWith("boardRun.ts")) {
  const [run, ...rest] = process.argv.slice(2);
  if (!run) throw new Error("usage: boardRun.ts <run> [--fair-open <mint>] [instant mint...]");
  const at = rest.indexOf("--fair-open");
  const fairOpen = at >= 0 ? (rest.splice(at, 2)[1] as Address) : null;
  await sweepBoardRun(run, rest as Address[], fairOpen);
  console.log(`swept the wallets of board run ${run}`);
}
