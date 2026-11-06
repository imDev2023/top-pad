// The quotes the launch form offers (ADR 0007), as `GET /quotes` lists them from what the chain holds: no database, so
// these run anywhere. The stand-in xStock is read from its mint as devnet held it on 2026-11-03.
import { address, getBase64Encoder } from "@solana/kit";
import { CLUSTERS, DEVNET_USDC } from "@top-pad/chain";
import { decodeQuoteMint, TOKEN_2022_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS } from "@top-pad/chain/quotes";
import { describe, expect, it } from "vitest";
import standIn from "../../../packages/chain/src/fixtures/xstock-stand-in.json" with { type: "json" };
import { config } from "./env";
import { amountText, listedQuote } from "./quotes";
import { testBindings } from "./test/fakes";

const devnet = CLUSTERS.devnet!;
const cfg = config(testBindings("postgres://unused"));
const quoteOf = (symbol: string) => devnet.quotes.find((q) => q.symbol === symbol)!;
const STAND_IN_MINT = decodeQuoteMint(new Uint8Array(getBase64Encoder().encode(standIn.data)));
const FAIR_OPEN = address("2tD6tB8HTbrhgaRbFfWXDDCZiZbyoHiniYhmCUGNmDSA");
const INSTANT = address("9aibHAP7PyCc5LKgEznkED7BteFbd7hrLiJehMWeFav6");
const settings = { fairOpenConfig: FAIR_OPEN, instantConfig: INSTANT, step: 99_980n, fairOpenTarget: 84_983_000n, instantTarget: 84_983_000n };

describe("the quotes a coin can be priced in", () => {
  it("offers SOL with its settings, its pot's cap and its ladder, and no labels", () => {
    const sol = listedQuote(cfg, quoteOf("SOL"), { mint: null, settings: { ...settings, fairOpenConfig: devnet.configs!.fairOpen, instantConfig: devnet.configs!.instant, step: 10_000_000n, fairOpenTarget: devnet.graduationTarget, instantTarget: devnet.graduationTarget } });
    expect(sol).toMatchObject({ symbol: "SOL", offered: true, waiting: null, multiplier: 1, labels: [] });
    expect(sol.settings).toMatchObject({ potCap: "1700000000", graduationTarget: "8500000000" });
    expect(sol.settings!.rungs).toHaveLength(64);
  });

  it("offers devnet USDC once its settings name a pair on chain, and waits without them", () => {
    const usdc = quoteOf("USDC");
    const mint = { address: DEVNET_USDC, tokenProgram: TOKEN_PROGRAM_ADDRESS, mint: { ...STAND_IN_MINT, decimals: 6, extensions: { __option: "None" } as const }, tokenBadge: false };
    const offered = listedQuote(cfg, usdc, { mint, settings });
    expect(offered).toMatchObject({ offered: true, settings: { step: "99980", graduationTarget: "84983000", potCap: "16996600" } });
    // Circle's devnet USDC keeps a freeze authority, which is its one label.
    expect(offered.labels.map((l) => l.kind)).toEqual(["freeze"]);
    expect(listedQuote(cfg, usdc, { mint, settings: null })).toMatchObject({ offered: false, settings: null });
    expect(listedQuote(cfg, usdc, { mint, settings: { ...settings, instantTarget: null } }).waiting).toBe("Its config pair is not on chain as named.");
  });

  it("lists the stand-in xStock with its labels read from its mint, waiting for Meteora's TokenBadge", () => {
    const listed = listedQuote(cfg, quoteOf("NVDAx"), { mint: { address: address(standIn.address), tokenProgram: TOKEN_2022_PROGRAM_ADDRESS, mint: STAND_IN_MINT, tokenBadge: false }, settings: null });
    expect(listed.offered).toBe(false);
    expect(listed.waiting).toBe("It waits for Meteora's TokenBadge, without which Meteora's curves do not take it.");
    expect(listed.labels.map((l) => l.kind)).toEqual(["freeze", "permanent_delegate", "pausable", "transfer_hook", "default_frozen", "scaled_balance"]);
    expect(listed.multiplier).toBe(1);
  });

  it("words an amount in the quote, through its multiplier", () => {
    expect(amountText(99_980n, { symbol: "USDC", decimals: 6, multiplier: 1 })).toBe("0.09998 USDC");
    expect(amountText(100_000_000n, { symbol: "NVDAx", decimals: 8, multiplier: 2.5 })).toBe("2.5 NVDAx");
  });
});
