import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  compressTransactionMessageUsingAddressLookupTables,
  createTransactionMessage,
  generateKeyPairSigner,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Blockhash,
  type Nonce,
} from "@solana/kit";
import { SYSTEM_PROGRAM_ADDRESS } from "@solana-program/system";
import { ASSOCIATED_TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS } from "@top-pad/clients/dbc";
import { Tier } from "@top-pad/clients/fair-open";
import { describe, expect, it } from "vitest";
import cases from "./fixtures/allocations.json";
import { allocate, DEPOSIT_STEP, rungAtOrBelow } from "./fairOpen";
import { CLUSTERS, FAIR_OPEN_PROGRAM_ADDRESS } from "./index";
import {
  creationInstructions,
  creationMessage,
  fairOpenLookupTableAddresses,
  pushInstructions,
  PUSH_SEATS,
  seatOutcome,
  shareOf,
  signLadder,
  type Creation,
} from "./open";

const devnet = CLUSTERS.devnet!;
const random = async () => (await generateKeyPairSigner()).address;
const SYSVAR_INSTRUCTIONS = "Sysvar1nstructions1111111111111111111111111";
const LIMIT = 1_232;

/** A creation for a launch on devnet's Fair Open config, with the longest coin a creator can enter. */
async function creation(over: Partial<Creation> = {}): Promise<Creation> {
  const [creator, keeper, mint] = await Promise.all([generateKeyPairSigner(), generateKeyPairSigner(), generateKeyPairSigner()]);
  return {
    launch: await random(),
    dbcConfig: devnet.configs!.fairOpen,
    quoteMint: devnet.quote.mint,
    creator,
    keeper,
    mint,
    // Metaplex's longest name and Heat's longest ticker; a Turbo URI is the gateway and a 43-character id.
    coin: { name: "N".repeat(32), ticker: "T".repeat(10), uri: `https://turbo-gateway.com/${"i".repeat(43)}` },
    rung: 1_615_000_000n,
    computeUnitPrice: 0n,
    ...over,
  };
}

const table = async () => ({ address: await random(), addresses: await fairOpenLookupTableAddresses(devnet) });

describe("a seat's part of the open", () => {
  it("matches the program's shares, added up, on every fixture pot that opens", () => {
    let opens = 0;
    for (const c of cases) {
      const counts = new Array<number>(200).fill(0);
      const unverified = new Array<number>(10).fill(0);
      for (const [k, n] of c.counts as [number, number][]) counts[k] = n;
      for (const [k, n] of c.unverifiedCounts as [number, number][]) unverified[k] = n;
      const a = allocate(counts, unverified, DEPOSIT_STEP, BigInt(c.cap));
      const rung = rungAtOrBelow(BigInt(c.cap), a.spend);
      if (!c.open) {
        expect(rung === null || a.spend === 0n, c.name).toBe(true);
        continue;
      }
      opens++;
      const open = { spend: a.spend, spent: BigInt(c.open.rung), coins: BigInt(c.open.coins), othersLevel: a.others.level, unverifiedLevel: a.unverified.level };
      let [spent, bought] = [0n, 0n];
      for (const [list, tier] of [[counts, Tier.Scored], [unverified, Tier.Unverified]] as const) {
        list.forEach((n, k) => {
          const o = seatOutcome(open, tier, BigInt(k + 1) * DEPOSIT_STEP);
          expect(o.spent <= o.fill && o.fill <= BigInt(k + 1) * DEPOSIT_STEP).toBe(true);
          spent += o.spent * BigInt(n);
          bought += o.coins * BigInt(n);
        });
      }
      expect([spent, bought], c.name).toEqual([BigInt(c.open.spent), BigInt(c.open.bought)]);
    }
    expect(opens).toBeGreaterThan(390);
  });

  it("rounds a seat's spend up and its coins down", () => {
    expect(shareOf(1n, 3n, 2n, 2n)).toEqual({ spent: 1n, coins: 0n });
    expect(shareOf(240_000_000n, 15_000_000_000n, 14_250_000_000n, 300_000_000_000_000n)).toEqual({ spent: 228_000_000n, coins: 4_800_000_000_000n });
    expect(shareOf(5n, 0n, 0n, 0n)).toEqual({ spent: 0n, coins: 0n });
  });
});

describe("the creation transaction", () => {
  it("is in the order the open checks, the pot's buy passing the instructions sysvar", async () => {
    const c = await creation();
    const ixs = await creationInstructions(c);
    const programs = ixs.map((ix) => ix.programAddress);
    expect(programs.slice(1)).toEqual([
      FAIR_OPEN_PROGRAM_ADDRESS,
      DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS,
      ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
      DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS,
      FAIR_OPEN_PROGRAM_ADDRESS,
    ]);
    const swap = ixs[4]!;
    expect(swap.accounts!).toHaveLength(16);
    expect(swap.accounts!.at(-1)!.address).toBe(SYSVAR_INSTRUCTIONS);
    // The pot's buy, exact in, of exactly the rung.
    expect(Buffer.from(swap.data!).readBigUInt64LE(8)).toBe(c.rung);
    expect(swap.data![24]).toBe(0);
    // DBC's pool creation names the creator as a signer and our keeper as the payer of its accounts.
    const init = ixs[2]!.accounts!;
    expect([init[2]!.address, init[10]!.address]).toEqual([c.creator.address, c.keeper.address]);
  });

  it("fits a transaction with the shared lookup table, its longest coin included, and not without it", async () => {
    const c = await creation();
    const lifetime = { nonce: await random(), value: "11111111111111111111111111111111" as Nonce, authority: c.keeper.address };
    const message = await creationMessage(c, lifetime, await table());
    const ixs = await creationInstructions(c);
    const size = getTransactionEncoder().encode(compileTransaction(message)).length;
    console.log(`the creation transaction: ${size} bytes with the lookup table`);
    expect(size).toBeLessThanOrEqual(LIMIT);
    // The durable nonce's advance comes first, as a nonce transaction requires.
    expect(message.instructions[0]!.programAddress).toBe(SYSTEM_PROGRAM_ADDRESS);

    // The same transaction with every address in full would not fit.
    const plain = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(c.keeper, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: "11111111111111111111111111111111" as Blockhash, lastValidBlockHeight: 0n }, m),
      (m) => appendTransactionMessageInstructions(ixs, m),
    );
    expect(getTransactionEncoder().encode(compileTransaction(plain)).length).toBeGreaterThan(LIMIT);
  });

  it("signs a 64-rung ladder on one nonce, each rung complete", async () => {
    const c = await creation();
    const ladder = await signLadder({ ...c, potCap: 1_700_000_000n, nonce: await random(), nonceValue: "11111111111111111111111111111111" as Nonce, table: await table() });
    expect(ladder).toHaveLength(64);
    expect(ladder[0]!.rung).toBe(1_700_000_000n);
    expect(new Set(ladder.map((r) => r.transaction)).size).toBe(64);
    expect(Math.max(...ladder.map((r) => r.bytes))).toBeLessThanOrEqual(LIMIT);
  });
});

describe("a push", () => {
  it("fits its seats in a transaction with the shared lookup table", async () => {
    const [payer, launch, mint] = await Promise.all([generateKeyPairSigner(), random(), random()]);
    const seats = await Promise.all(Array.from({ length: PUSH_SEATS }, async () => ({ seat: await random(), wallet: await random() })));
    const ixs = await pushInstructions({ launch, mint, payer, seats, computeUnitPrice: 1n });
    const { address: tableAddress, addresses } = await table();
    const message = compressTransactionMessageUsingAddressLookupTables(
      pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayerSigner(payer, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: "11111111111111111111111111111111" as Blockhash, lastValidBlockHeight: 0n }, m),
        (m) => appendTransactionMessageInstructions(ixs, m),
      ),
      { [tableAddress]: addresses },
    );
    const size = getTransactionEncoder().encode(compileTransaction(message)).length;
    console.log(`a push of ${PUSH_SEATS} seats: ${size} bytes`);
    expect(size).toBeLessThanOrEqual(LIMIT);
    // Each seat brings its seat, its wallet and the wallet's coin account.
    expect(ixs.at(-1)!.accounts!.length).toBe(10 + 3 * PUSH_SEATS);
  });
});

describe("the shared lookup table", () => {
  it("holds every common address once", async () => {
    const addresses = await fairOpenLookupTableAddresses(devnet);
    expect(new Set(addresses).size).toBe(addresses.length);
    expect(addresses).toContain(devnet.configs!.fairOpen as Address);
    expect(addresses).toContain(address(SYSVAR_INSTRUCTIONS));
  });
});
