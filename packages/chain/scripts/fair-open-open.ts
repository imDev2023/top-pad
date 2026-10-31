// `pnpm --filter @top-pad/chain fair-open-open devnet <launch> [--send]`: opens a Fair Open scheduled by `fair-open`, as
// our keeper's Workflow will (#47): it waits for the scheduled time by the chain's clock, sends the rung of the creator's
// ladder the pot covers (spec 2.1 step 10), pushes every seat its coins and refund (step 12), then closes the launch's
// durable nonce, its rent going back to the creator. A launch that can no longer open is marked failed instead, and its
// nonce closed. Our keeper pays and signs (KEEPER_KEYPAIR, or ~/.config/top-pad/<cluster>/keeper.json); the ladder is
// the one `fair-open` wrote to ~/.config/top-pad/<cluster>/ladders/<launch>.json. It simulates the open first and sends
// only with --send; the RPC is DEVNET_RPC_URL, or the public endpoint.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  address,
  appendTransactionMessageInstructions,
  compressTransactionMessageUsingAddressLookupTables,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  fetchEncodedAccount,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Base58EncodedBytes,
  type Base64EncodedWireTransaction,
  type Instruction,
  type Signature,
} from "@solana/kit";
import { fetchAddressLookupTable } from "@solana-program/address-lookup-table";
import { fetchLaunch, getSeatDecoder, getSeatSize, LaunchStatus } from "@top-pad/clients/fair-open";
import {
  allocate,
  closeNonceInstruction,
  CLUSTERS,
  dbcPoolAddress,
  FAIR_OPEN_PROGRAM_ADDRESS,
  fairOpenPhase,
  markFailedInstructions,
  pushInstructions,
  PUSH_SEATS,
  rungAtOrBelow,
  SEAT_LAYOUT,
} from "../src/index";

const [cluster, launchArg, ...flags] = process.argv.slice(2);
const send = flags.includes("--send");
const heat = cluster === "devnet" ? CLUSTERS.devnet : null;
if (!heat?.configs || !heat.lookupTable || !launchArg) {
  console.error("Usage: pnpm --filter @top-pad/chain fair-open-open devnet <launch> [--send]");
  process.exit(1);
}
const launch = address(launchArg);
const keeper = await createKeyPairSignerFromBytes(
  Uint8Array.from(JSON.parse(readFileSync(process.env.KEEPER_KEYPAIR || join(homedir(), ".config/top-pad", cluster!, "keeper.json"), "utf8"))),
);
const rpcUrl = process.env.DEVNET_RPC_URL || "https://api.devnet.solana.com";
const rpc = createSolanaRpc(rpcUrl);
const { data: table } = await fetchAddressLookupTable(rpc, heat.lookupTable, { commitment: "confirmed" });
const lookups = { [heat.lookupTable]: table.addresses };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The chain's clock, from the Clock sysvar: its `unix_timestamp` follows the slot, two epochs and the leader epoch. */
async function chainTime(): Promise<bigint> {
  const clock = await fetchEncodedAccount(rpc, address("SysvarC1ock11111111111111111111111111111111"), { commitment: "confirmed" });
  if (!clock.exists) throw new Error("no Clock sysvar");
  return new DataView(clock.data.buffer, clock.data.byteOffset).getBigInt64(32, true);
}

/** Sends a signed transaction and waits for it to confirm, over HTTP. */
async function sent(wire: Base64EncodedWireTransaction, signature: Signature) {
  await rpc.sendTransaction(wire, { encoding: "base64", skipPreflight: true }).send();
  for (let poll = 0; poll < 90; poll++) {
    await sleep(1_000);
    const { value: [status] } = await rpc.getSignatureStatuses([signature]).send();
    if (status?.err) throw new Error(`${signature} failed: ${JSON.stringify(status.err, (_, v) => (typeof v === "bigint" ? `${v}` : v))}`);
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") return signature;
  }
  throw new Error(`${signature} did not confirm`);
}

/** A transaction of `instructions` from our keeper, through the shared lookup table. */
async function keeperSends(what: string, instructions: Instruction[]) {
  const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const transaction = await signTransactionMessageWithSigners(
    compressTransactionMessageUsingAddressLookupTables(
      pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayerSigner(keeper, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
        (m) => appendTransactionMessageInstructions(instructions, m),
      ),
      lookups,
    ),
  );
  const signature = await sent(getBase64EncodedWireTransaction(transaction), getSignatureFromTransaction(transaction));
  console.log(`${what}: ${signature}`);
}

let { data: account } = await fetchLaunch(rpc, launch, { commitment: "confirmed" });
console.log(`Fair Open ${launch}: ${LaunchStatus[account.status]}, opens at ${new Date(Number(account.opensAt) * 1000).toISOString()}.`);

if (account.status === LaunchStatus.Scheduled) {
  for (let now = await chainTime(); now < account.opensAt; now = await chainTime()) {
    console.log(`  ${account.opensAt - now} s to the open by the chain's clock`);
    await sleep(Math.min(Number(account.opensAt - now) * 1_000, 20_000) + 500);
  }
  ({ data: account } = await fetchLaunch(rpc, launch, { commitment: "confirmed" }));
  const phase = fairOpenPhase(account, await chainTime());
  if (phase.phase === "failing") {
    console.log(`It cannot open (${phase.failure}): marking it failed.`);
    if (send) await keeperSends("mark_failed", await markFailedInstructions({ launch, computeUnitPrice: 0n }));
  } else {
    const { spend } = allocate(account.counts, account.unverifiedCounts, account.step, account.potCap);
    const rung = rungAtOrBelow(account.potCap, spend)!;
    const ladder = JSON.parse(readFileSync(join(homedir(), ".config/top-pad", cluster!, "ladders", `${launch}.json`), "utf8")) as {
      rungs: { rung: string; transaction: string }[];
    };
    const signed = ladder.rungs.find((r) => BigInt(r.rung) === rung);
    if (!signed) throw new Error(`the ladder has no rung of ${rung}`);
    const wire = signed.transaction as Base64EncodedWireTransaction;
    const bytes = getBase64Encoder().encode(wire);
    // The first signature in a wire transaction follows its one-byte count.
    const signature = getBase58Decoder().decode(bytes.slice(1, 65)) as Signature;
    console.log(`The pot would spend ${spend} lamports: the rung of ${rung}, ${bytes.length} bytes.`);
    const { value: simulation } = await rpc.simulateTransaction(wire, { encoding: "base64", sigVerify: true, commitment: "confirmed" }).send();
    console.log(`Simulation ${simulation.err ? "failed" : "passed"} (${simulation.unitsConsumed} CU).`);
    if (simulation.err) {
      console.error(JSON.stringify(simulation.err, (_, v) => (typeof v === "bigint" ? `${v}` : v)));
      for (const line of simulation.logs ?? []) console.error(`  ${line}`);
      process.exit(1);
    }
    if (!send) {
      console.log("Nothing was sent. Run again with --send to open it.");
      process.exit(0);
    }
    console.log(`Opened: ${await sent(wire, signature)}`);
  }
  ({ data: account } = await fetchLaunch(rpc, launch, { commitment: "confirmed" }));
}

if (account.status === LaunchStatus.Opened) {
  const seats = await rpc
    .getProgramAccounts(FAIR_OPEN_PROGRAM_ADDRESS, {
      encoding: "base64",
      commitment: "confirmed",
      filters: [
        { dataSize: BigInt(getSeatSize()) },
        { memcmp: { offset: BigInt(SEAT_LAYOUT.launchOffset), bytes: launch as string as Base58EncodedBytes, encoding: "base58" } },
      ],
    })
    .send();
  const waiting = seats
    .map((s) => ({ seat: s.pubkey, ...getSeatDecoder().decode(getBase64Encoder().encode(s.account.data[0])) }))
    .filter((s) => !s.delivered && s.wallet !== account.creator);
  console.log(`${waiting.length} seats to push.`);
  for (let i = 0; i < waiting.length && send; i += PUSH_SEATS) {
    const batch = waiting.slice(i, i + PUSH_SEATS).map((s) => ({ seat: s.seat, wallet: s.wallet }));
    await keeperSends(`push of ${batch.length}`, await pushInstructions({ launch, mint: account.mint, payer: keeper, seats: batch, computeUnitPrice: 0n }));
  }
  const pool = await dbcPoolAddress(account.dbcConfig, account.mint, account.quoteMint);
  console.log(`The coin ${account.mint}, pool ${pool}: https://top-pad-web-devnet.imdev2023.workers.dev/coin/${account.mint}`);
}

// The nonce's rent goes back to the creator once the launch has opened or failed.
const opened = account.status === LaunchStatus.Opened || account.status === LaunchStatus.Failed;
const { value: nonceLamports } = await rpc.getBalance(account.nonce as Address, { commitment: "confirmed" }).send();
if (send && opened && nonceLamports > 0n) {
  await keeperSends(
    "nonce closed",
    [closeNonceInstruction({ nonce: account.nonce, keeper, creator: account.creator, lamports: nonceLamports })],
  );
}
