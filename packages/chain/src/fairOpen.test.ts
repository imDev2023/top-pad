import {
  generateKeyPair,
  generateKeyPairSigner,
  getAddressDecoder,
  getAddressEncoder,
  getAddressFromPublicKey,
  getProgramDerivedAddress,
  getU32Encoder,
  getUtf8Encoder,
  verifySignature,
  type SignatureBytes,
} from "@solana/kit";
import { SYSTEM_PROGRAM_ADDRESS } from "@solana-program/system";
import { getLaunchDecoder, getLaunchEncoder, LaunchStatus, type LaunchArgs } from "@top-pad/clients/fair-open";
import { describe, expect, it } from "vitest";
import cases from "./fixtures/allocations.json";
import {
  admissionMessage,
  allocate,
  createLaunchInstructions,
  DEPOSIT_STEP,
  depositInstructions,
  ED25519_PROGRAM_ADDRESS,
  ed25519Instruction,
  fairOpenAccounts,
  fairOpenPhase,
  fillOf,
  identityHash,
  lowestRung,
  potCapOf,
  rungAtOrBelow,
  rungs,
  seatAddress,
  signAdmission,
  spentOf,
  Tier,
  tierCap,
} from "./fairOpen";
import { FAIR_OPEN_PROGRAM_ADDRESS } from "./index";

const SOL = 1_000_000_000n;
const random = () => getAddressDecoder().decode(crypto.getRandomValues(new Uint8Array(32)));
const dense = (pairs: number[][], len: number) => {
  const counts = new Array<number>(len).fill(0);
  for (const [k, n] of pairs) counts[k!] = n!;
  return counts;
};

describe("the allocation (spec 2.1 step 11)", () => {
  it("gives every pot in the fixture the allocation the program gives it", () => {
    // `programs/fair_open/tests/allocation.rs` checks the program against the same file.
    for (const c of cases) {
      const a = allocate(dense(c.counts, 200), dense(c.unverifiedCounts, 10), BigInt(c.step), BigInt(c.cap));
      const level = (l: typeof a.others) => ({ level: `${l.level}`, filled: `${l.filled}`, limited: l.limited });
      expect({ spend: `${a.spend}`, others: level(a.others), unverified: level(a.unverified) }, c.name).toEqual({
        spend: c.spend,
        others: c.others,
        unverified: c.unverified,
      });
    }
  });

  it("gives the worked example 0.24 SOL each", () => {
    const counts = new Array<number>(200).fill(0);
    counts[9] = 30;
    for (let i = 0; i < 50; i++) counts[49 + i * 3]! += 1;
    const a = allocate(counts, new Array(10).fill(0), DEPOSIT_STEP, 15n * SOL);
    expect(a.others.level).toBe(240_000_000n);
    expect(fillOf(a, Tier.Scored, SOL / 10n)).toBe(SOL / 10n);
    expect(fillOf(a, Tier.Verified, 2n * SOL)).toBe(240_000_000n);
  });

  it("scales each fill to the rung the pot opens on, rounding up", () => {
    // 4 seats asking 0.5 SOL into a 1.7 SOL pot: 0.425 SOL each, 1.7 SOL in all, so the pot opens on its top rung.
    const counts = new Array<number>(200).fill(0);
    counts[49] = 4;
    const a = allocate(counts, new Array(10).fill(0), DEPOSIT_STEP, 1_700_000_000n);
    expect(rungAtOrBelow(1_700_000_000n, a.spend)).toBe(1_700_000_000n);
    expect(spentOf(a, 1_700_000_000n, Tier.Scored, SOL / 2n)).toBe(425_000_000n);
    // The same seats into a pot that opens a rung lower spend 5% less each, rounded up to the lamport.
    expect(spentOf(a, 1_615_000_000n, Tier.Scored, SOL / 2n)).toBe(403_750_000n);
    // Three seats of 0.03 SOL: a third of a rung a lamport short of 0.09 SOL is a fraction, rounded up; a third of one
    // three lamports short is whole.
    const odd = allocate([0, 0, 3], [], DEPOSIT_STEP, 1_700_000_000n);
    expect(spentOf(odd, 89_999_999n, Tier.Verified, 30_000_000n)).toBe(30_000_000n);
    expect(spentOf(odd, 89_999_997n, Tier.Verified, 30_000_000n)).toBe(29_999_999n);
  });

  it("fills an Unverified seat to its own lower level", () => {
    const counts = new Array<number>(200).fill(0);
    counts[199] = 20;
    const unverified = new Array<number>(10).fill(0);
    unverified[9] = 400;
    const a = allocate(counts, unverified, DEPOSIT_STEP, 17n * SOL);
    expect(fillOf(a, Tier.Unverified, SOL / 10n)).toBe(10_625_000n);
    expect(fillOf(a, Tier.Verified, 2n * SOL)).toBe(637_500_000n);
  });
});

describe("the ladder's rungs", () => {
  it("fall from the pot's cap in 5% steps, 64 of them", () => {
    const all = rungs(17n * SOL);
    expect(all).toHaveLength(64);
    expect(all[1]).toBe(16_150_000_000n);
    // The same lowest rungs as the program's (`allocation::lowest_rung`).
    expect(lowestRung(17n * SOL)).toBe(671_484_587n);
    expect(lowestRung(1_700_000_000n)).toBe(67_148_451n);
    expect(rungAtOrBelow(17n * SOL, 16_200_000_000n)).toBe(16_150_000_000n);
    expect(rungAtOrBelow(17n * SOL, 671_484_586n)).toBeNull();
  });

  it("start from a cap of 20% of the Graduation Target", () => {
    expect(potCapOf(8_500_000_000n)).toBe(1_700_000_000n);
    expect(potCapOf(85n * SOL)).toBe(17n * SOL);
  });
});

describe("the Depositor tiers", () => {
  it("cap a Fair Open at 0.1, 0.5 and 2 SOL", () => {
    expect([tierCap(Tier.Unverified), tierCap(Tier.Scored), tierCap(Tier.Verified)]).toEqual([SOL / 10n, SOL / 2n, 2n * SOL]);
  });
});

describe("an admission", () => {
  it("is the program's message: the domain, launch, wallet, person, tier, cap and expiry", () => {
    const [launch, wallet] = [random(), random()];
    const person = new Uint8Array(32).fill(7);
    const message = admissionMessage(launch, wallet, { person, tier: Tier.Scored, cap: SOL / 2n, expiresAt: 1_800_000_060n });
    const domain = getUtf8Encoder().encode("heat fair open admission v1");
    expect(message).toHaveLength(domain.length + 32 * 3 + 1 + 8 + 8);
    expect(message.slice(0, domain.length)).toEqual(domain);
    expect(getAddressDecoder().decode(message.slice(domain.length, domain.length + 32))).toBe(launch);
    expect(getAddressDecoder().decode(message.slice(domain.length + 32, domain.length + 64))).toBe(wallet);
    expect(message.slice(domain.length + 64, domain.length + 96)).toEqual(person);
    const tail = new DataView(message.buffer, domain.length + 96);
    expect([tail.getUint8(0), tail.getBigUint64(1, true), tail.getBigInt64(9, true)]).toEqual([1, SOL / 2n, 1_800_000_060n]);
  });

  it("travels as an Ed25519 precompile instruction whose signature verifies", async () => {
    const key = await generateKeyPair();
    const signer = await getAddressFromPublicKey(key.publicKey);
    const message = admissionMessage(random(), random(), { person: new Uint8Array(32), tier: Tier.Unverified, cap: SOL / 10n, expiresAt: 1n });
    const signature = await signAdmission(key.privateKey, message);
    expect(await verifySignature(key.publicKey, signature as SignatureBytes, message)).toBe(true);
    const ix = ed25519Instruction(signer, signature, message);
    const data = ix.data!;
    expect(ix.programAddress).toBe(ED25519_PROGRAM_ADDRESS);
    const u16 = (i: number) => data[2 + 2 * i]! | (data[3 + 2 * i]! << 8);
    // One signature, every offset inside the instruction itself (u16::MAX), as the program requires.
    expect([data[0], u16(0), u16(1), u16(2), u16(3), u16(4), u16(5), u16(6)]).toEqual([1, 48, 0xffff, 16, 0xffff, 112, message.length, 0xffff]);
    expect(getAddressDecoder().decode(data.slice(16, 48))).toBe(signer);
    expect(data.slice(48, 112)).toEqual(signature);
    expect(data.slice(112)).toEqual(message);
  });

  it("goes right before the deposit, which names the person's seat", async () => {
    const wallet = await generateKeyPairSigner();
    const launch = random();
    const person = crypto.getRandomValues(new Uint8Array(32));
    const admission = { person, tier: Tier.Scored, cap: SOL / 2n, expiresAt: 1_800_000_060n };
    const ixs = await depositInstructions({ launch, wallet, amount: SOL / 4n, admission, admissionSigner: random(), signature: new Uint8Array(64), computeUnitPrice: 0n });
    const at = ixs.findIndex((ix) => ix.programAddress === FAIR_OPEN_PROGRAM_ADDRESS);
    expect(ixs[at - 1]!.programAddress).toBe(ED25519_PROGRAM_ADDRESS);
    expect(at).toBe(ixs.length - 1);
    expect(ixs[at]!.accounts!.map((a) => a.address)).toContain(await seatAddress(launch, person));
  });
});

describe("a person's seat", () => {
  it("sits at the PDA of the launch and the person's pseudonym", async () => {
    const launch = random();
    const person = crypto.getRandomValues(new Uint8Array(32));
    const [expected] = await getProgramDerivedAddress({
      programAddress: FAIR_OPEN_PROGRAM_ADDRESS,
      seeds: ["seat", getAddressEncoder().encode(launch), person],
    });
    expect(await seatAddress(launch, person)).toBe(expected);
  });
});

describe("a coin's sealed identity", () => {
  it("is the SHA-256 of DBC's pool parameters, each string a u32 length and its bytes", async () => {
    const coin = { name: "Heat Test", ticker: "HEATT", uri: "https://turbo-gateway.com/abc" };
    const parts = [coin.name, coin.ticker, coin.uri].flatMap((s) => {
      const bytes = getUtf8Encoder().encode(s);
      return [...getU32Encoder().encode(bytes.length), ...bytes];
    });
    const expected = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(parts)));
    expect(await identityHash(coin)).toEqual(expected);
    expect(await identityHash({ ...coin, ticker: "HEAT" })).not.toEqual(expected);
  });
});

describe("scheduling", () => {
  it("creates the nonce for the keeper, then the launch at the nonce's PDA", async () => {
    const [creator, keeper, nonce] = await Promise.all([generateKeyPairSigner(), generateKeyPairSigner(), generateKeyPairSigner()]);
    const ixs = await createLaunchInstructions({
      creator,
      keeper,
      nonce,
      nonceRent: 1_447_680n,
      dbcConfig: random(),
      depositsOpenAt: 1_800_000_000n,
      minRaise: 0n,
      identityHash: new Uint8Array(32).fill(1),
      computeUnitPrice: 0n,
    });
    const system = ixs.filter((ix) => ix.programAddress === SYSTEM_PROGRAM_ADDRESS);
    expect(system).toHaveLength(2);
    const create = ixs.at(-1)!;
    expect(create.programAddress).toBe(FAIR_OPEN_PROGRAM_ADDRESS);
    const { launch, vault } = await fairOpenAccounts(nonce.address);
    expect(create.accounts!.map((a) => a.address)).toEqual(expect.arrayContaining([launch, vault, nonce.address, keeper.address, creator.address]));
  });
});

describe("a launch's phase", () => {
  const launch = (over: Partial<LaunchArgs> = {}) =>
    getLaunchDecoder().decode(
      getLaunchEncoder().encode({
        creator: random(),
        dbcConfig: random(),
        quoteMint: random(),
        nonce: random(),
        identityHash: new Uint8Array(32),
        depositsOpenAt: 1_000n,
        opensAt: 1_600n,
        minRaise: 0n,
        potCap: 1_700_000_000n,
        lowestRung: 67_148_451n,
        step: DEPOSIT_STEP,
        status: LaunchStatus.Scheduled,
        failure: null,
        failedAt: 0n,
        seats: 0,
        unverifiedDeposits: 0n,
        scoredDeposits: 0n,
        verifiedDeposits: 0n,
        coinRent: 0n,
        counts: new Array(200).fill(0),
        unverifiedCounts: new Array(10).fill(0),
        openRent: 23_517_880n,
        mint: random(),
        keeperLamports: 0n,
        spend: 0n,
        othersLevel: 0n,
        unverifiedLevel: 0n,
        spent: 0n,
        coins: 0n,
        refunded: 0n,
        delivered: 0,
        reserved: new Uint8Array(28),
        bump: 255,
        vaultBump: 255,
        ...over,
      }),
    );
  const withAsks = (asks: [number, number][], over: Partial<LaunchArgs> = {}) => {
    const counts = new Array<number>(200).fill(0);
    for (const [k, n] of asks) counts[k] = n;
    return launch({ counts, ...over });
  };

  it("runs from scheduled to the window to the open being due, then late", () => {
    const pot = withAsks([[49, 4]]);
    expect(fairOpenPhase(pot, 999n)).toEqual({ phase: "scheduled" });
    expect(fairOpenPhase(pot, 1_000n)).toEqual({ phase: "window" });
    expect(fairOpenPhase(pot, 1_599n)).toEqual({ phase: "window" });
    expect(fairOpenPhase(pot, 1_600n)).toEqual({ phase: "due", lateAt: 2_500n });
    expect(fairOpenPhase(pot, 2_500n)).toEqual({ phase: "failing", failure: "late" });
  });

  it("can fail at once when the pot misses its minimum raise or the lowest rung", () => {
    expect(fairOpenPhase(withAsks([[49, 4]], { minRaise: 3n * SOL }), 1_600n)).toEqual({ phase: "failing", failure: "min_raise_missed" });
    expect(fairOpenPhase(withAsks([[4, 1]]), 1_600n)).toEqual({ phase: "failing", failure: "below_lowest_rung" });
  });

  it("is opened once the pot has bought, whatever the clock says", () => {
    expect(fairOpenPhase(withAsks([[49, 4]], { status: LaunchStatus.Opened }), 2_500n)).toEqual({ phase: "opened" });
  });

  it("stays failed once marked", () => {
    expect(fairOpenPhase(launch({ status: LaunchStatus.Failed, failure: 2 }), 1_000n)).toEqual({ phase: "failed", failure: "late" });
  });
});
