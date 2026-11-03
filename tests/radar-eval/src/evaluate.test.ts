import { describe, expect, it } from "vitest";
import type { LaunchRecord } from "./collect";
import { PASS, score, scoreFleet, tradedOnly, walletsOf, wilsonLower } from "./evaluate";
import type { FleetSet } from "./fleet";

describe("wilsonLower", () => {
  it("matches spec 11.5's bar: 400 flagged with none wrong, or 1,000 with at most 3", () => {
    expect(wilsonLower(400, 400)).toBeGreaterThanOrEqual(PASS);
    expect(wilsonLower(997, 1000)).toBeGreaterThanOrEqual(PASS);
    expect(wilsonLower(996, 1000)).toBeLessThan(PASS);
    expect(wilsonLower(380, 380)).toBeLessThan(PASS);
    expect(wilsonLower(9, 10)).toBeCloseTo(0.59585, 4);
    expect(wilsonLower(0, 0)).toBe(0);
  });
});

const CREATOR = "Creator1111111111111111111111111111111111111";
const BUNDLED = "Bund1e11111111111111111111111111111111111111";
const FUNDED = "Funded1111111111111111111111111111111111111";
const SNIPER = "Sniper1111111111111111111111111111111111111";
const AT = 1_793_000_000;

const launch = (over: Partial<LaunchRecord> = {}): LaunchRecord => ({
  signature: "creation",
  slot: 100,
  blockIndex: 10,
  at: AT,
  mint: "Mint",
  creator: CREATOR,
  curve: "Curve",
  tokenProgram: "Token",
  jitoBundle: "bundle-1",
  bundleTransactions: ["creation", "buy-1"],
  buys: [
    { signature: "buy-1", blockIndex: 11, trader: BUNDLED, signers: [BUNDLED], baseAmount: "10", jitoBundle: "bundle-1" },
    // A wallet the creator paid 9 days before the open: outside the window, so no link.
    { signature: "buy-2", blockIndex: 12, trader: FUNDED, signers: [FUNDED], baseAmount: "10", jitoBundle: null },
    { signature: "buy-3", blockIndex: 13, trader: SNIPER, signers: [SNIPER, CREATOR], baseAmount: "10", jitoBundle: "bundle-2" },
    { signature: "buy-4", blockIndex: 40, trader: CREATOR, signers: [CREATOR], baseAmount: "10", jitoBundle: null },
  ],
  funding: [
    { wallet: BUNDLED, complete: true, method: "shared", read: 1, transfers: [{ signature: "f1", ordinal: 0, slot: 90, at: AT - 3600, source: CREATOR, destination: BUNDLED, asset: "SOL", amount: "1" }] },
    { wallet: FUNDED, complete: true, method: "shared", read: 1, transfers: [{ signature: "f2", ordinal: 0, slot: 1, at: AT - 9 * 86_400, source: CREATOR, destination: FUNDED, asset: "SOL", amount: "1" }] },
    { wallet: SNIPER, complete: false, method: "unread", read: 0, transfers: [] },
  ],
  ...over,
});

describe("walletsOf", () => {
  it("labels each creation-slot buyer with production's rules, leaves the Creator wallet out, and reads Jito's record", () => {
    const wallets = walletsOf(launch());
    expect(wallets.map((w) => w.wallet)).toEqual([BUNDLED, FUNDED, SNIPER]);
    const [bundled, funded, sniper] = wallets;
    expect(bundled).toMatchObject({ position: 1, inBundle: true, labels: ["same_slot", "after_creation", "jito_bundle", "creator_funded"] });
    expect(bundled!.signals).toContain("direct_link");
    expect(funded).toMatchObject({ position: 2, inBundle: false, labels: ["same_slot", "after_creation"], transfers: [] });
    expect(sniper).toMatchObject({ position: 3, inBundle: false, fundingRead: false, labels: ["same_slot", "after_creation", "creator_signed"] });
  });

  it("has no ground truth where Jito bundled no creation", () => {
    expect(walletsOf(launch({ jitoBundle: null, bundleTransactions: null })).every((w) => w.inBundle === null && !w.labels.includes("jito_bundle"))).toBe(true);
  });
});

describe("score", () => {
  it("counts a flag right when the wallet sat in the creation's bundle", () => {
    const wallets = walletsOf(launch());
    expect(score(wallets, "after_creation")).toMatchObject({ flagged: 3, correct: 1, wrong: 2, recall: 1, passes: false });
    expect(score(wallets, "creator_funded")).toMatchObject({ flagged: 1, correct: 1, wrong: 0, precision: 1 });
    expect(score(wallets, "jito_bundle")).toMatchObject({ flagged: 1, correct: 1 });
    expect(score(wallets, "creator_signed")).toMatchObject({ flagged: 1, correct: 0, precision: 0, recall: 0 });
  });
});

describe("tradedOnly", () => {
  it("is a trade only when every linking transaction moved value both ways", () => {
    const trade = [
      { signature: "a", source: CREATOR },
      { signature: "a", source: SNIPER },
    ];
    expect(tradedOnly(CREATOR, trade)).toBe(true);
    expect(tradedOnly(CREATOR, [...trade, { signature: "b", source: CREATOR }])).toBe(false);
    expect(tradedOnly(CREATOR, [{ signature: "c", source: SNIPER }])).toBe(false);
  });
});

describe("scoreFleet", () => {
  it("counts what each signal flags of the fleet and of everyone else, the launchpad's own creator fee no link", () => {
    const set: FleetSet = {
      fleet: ["F1", "F2"],
      sweeps: [],
      launches: [
        {
          coin: "X",
          program: "P",
          creation: { signature: "c", slot: 5, blockIndex: 0, at: AT, jitoBundle: null },
          openedAt: AT + 3600,
          creator: CREATOR,
          participants: [
            { wallet: "F1", signature: "j1", slot: 6, blockIndex: 0, at: AT + 60, signers: ["F1"], jitoBundle: null },
            { wallet: "F2", signature: "j2", slot: 7, blockIndex: 0, at: AT + 60, signers: ["F2"], jitoBundle: null },
            { wallet: "O1", signature: "j3", slot: 5, blockIndex: 1, at: AT, signers: ["O1"], jitoBundle: null },
          ],
          transfers: [
            { signature: "t", ordinal: 0, slot: 8, at: AT + 86_400, source: "F1", destination: CREATOR, asset: "SOL", amount: "5" },
            { signature: "j2", ordinal: 0, slot: 7, at: AT + 60, source: "F2", destination: CREATOR, asset: "SOL", amount: "1" },
          ],
          launchpadTransactions: ["j2"],
          windowRead: 2,
        },
      ],
    };
    const [x] = scoreFleet(set);
    expect(x).toMatchObject({ participants: 3, fleet: 2 });
    expect(x!.flagged.creator_funded).toEqual({ fleet: 1, other: 0 });
    expect(x!.flagged.after_creation).toEqual({ fleet: 0, other: 1 });
    expect(x!.flagged.direct_link).toEqual({ fleet: 1, other: 1 });
  });
});
