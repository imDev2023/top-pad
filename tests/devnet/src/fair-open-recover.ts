// Brings back what a stopped Fair Open run left on devnet. `pnpm exec tsx tests/devnet/src/fair-open-recover.ts` lists
// every launch of the Fair Open program still on chain, and those Heat's bank created with their depositors' holdings;
// `fair-open-recover.ts <launch> [depositors]` recovers one, the depositors being those its run derived from the bank and
// the launch (`depositorsOf`, 3 by default): once the launch may fail it is marked failed, each depositor's seat refunded,
// the launch and its nonce closed, every rent back to its creator, and each depositor's quote and SOL swept back to Heat's
// bank. A launch that opened is left to `settleOpened`.
import { address, getBase58Decoder, type Base58EncodedBytes } from "@solana/kit";
import { FAIR_OPEN_PROGRAM_ADDRESS, fetchQuoteToken, inSol } from "@top-pad/chain";
import { fetchMaybeLaunch, getLaunchDecoder, LAUNCH_DISCRIMINATOR } from "@top-pad/clients/fair-open";
import { bank, rpc } from "./devnet";
import { depositorsOf, quoteHeld, recoverDeposits, seatsOf, sweepDepositors } from "./fairOpen";

const [given, count = "3"] = process.argv.slice(2);
const payer = await bank();

if (!given) {
  const launches = await rpc
    .getProgramAccounts(FAIR_OPEN_PROGRAM_ADDRESS, {
      encoding: "base64",
      commitment: "confirmed",
      filters: [{ memcmp: { offset: 0n, bytes: getBase58Decoder().decode(LAUNCH_DISCRIMINATOR) as Base58EncodedBytes, encoding: "base58" } }],
    })
    .send();
  console.log(`${launches.length} launches of the Fair Open program on devnet`);
  for (const { pubkey, account } of launches) {
    const launch = getLaunchDecoder().decode(Buffer.from(account.data[0], "base64"));
    const byBank = launch.creator === payer.address;
    console.log(pubkey, { byBank, quote: launch.quoteMint, status: launch.status, opensAt: launch.opensAt, seats: (await seatsOf(pubkey)).length, lamports: account.lamports });
    if (!byBank) continue;
    const quote = await fetchQuoteToken(rpc, launch.quoteMint);
    for (const d of await depositorsOf(pubkey, Number(count))) {
      const { value: sol } = await rpc.getBalance(d.address, { commitment: "confirmed" }).send();
      console.log(`  depositor ${d.address}: ${sol} lamports${inSol(quote) ? "" : `, ${await quoteHeld(d.address, quote)} raw units of the quote`}`);
    }
  }
} else {
  const launch = address(given);
  const found = await fetchMaybeLaunch(rpc, launch, { commitment: "confirmed" });
  const quote = found.exists ? await fetchQuoteToken(rpc, found.data.quoteMint) : undefined;
  const depositors = await depositorsOf(launch, Number(count));
  await recoverDeposits(launch, payer, depositors);
  await sweepDepositors(depositors, quote);
  console.log(`launch ${launch} ${(await fetchMaybeLaunch(rpc, launch)).exists ? "is still on devnet" : "is closed"}; its depositors swept to the bank`);
  if (quote && !inSol(quote)) console.log(`the bank holds ${await quoteHeld(payer.address, quote)} raw units of ${quote.mint}`);
}
