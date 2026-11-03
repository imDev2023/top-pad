import { address, getBase64Encoder, none, some, type Address } from "@solana/kit";
import { AccountState, TOKEN_2022_PROGRAM_ADDRESS, getMintDecoder, type Extension, type Mint } from "@solana-program/token-2022";
import { describe, expect, it } from "vitest";
import nvdax from "./fixtures/xstock-nvdax.json";
import standIn from "./fixtures/xstock-stand-in.json";
import { DEVNET_XSTOCK_STAND_IN, TOKEN_2022_NATIVE_MINT, TOKEN_PROGRAM_ADDRESS, quoteVerdict, scaledUiMultiplier, type QuoteMint } from "./quotes";

// NVDAx's mint as mainnet held it on 2026-11-03, the xStock every case below starts from.
const NVDAX = getMintDecoder().decode(getBase64Encoder().encode(nvdax.data));
const quote = (mint: Mint, tokenBadge = true): QuoteMint => ({
  address: address(nvdax.address),
  tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
  mint,
  tokenBadge,
});
const extensions = (mint: Mint) => (mint.extensions.__option === "Some" ? mint.extensions.value : []);
const withExtension = (mint: Mint, kind: Extension["__kind"], change: (extension: Extension) => Extension): Mint => ({
  ...mint,
  extensions: some(extensions(mint).map((extension) => (extension.__kind === kind ? change(extension) : extension))),
});
const SOME_PROGRAM = address("HeatPiBAgiwq6VJr8eqyagQiQ2gvaK2y85q26bbBu4bo");

describe("quoteVerdict", () => {
  it("accepts NVDAx with its TokenBadge and reads its issuer's powers", () => {
    const verdict = quoteVerdict(quote(NVDAX));
    expect(verdict).toMatchObject({ dbcAccepts: true, accepted: true, refusals: [] });
    expect(verdict.extensions).toEqual([
      "MetadataPointer",
      "PermanentDelegate",
      "DefaultAccountState",
      "ScaledUiAmountConfig",
      "PausableConfig",
      "ConfidentialTransferMint",
      "TransferHook",
      "TokenMetadata",
    ]);
    expect(NVDAX.decimals).toBe(8);
    expect(verdict.powers.permanentDelegate).toBe("5aMNNLQJwAEeoemTEMkv5NVjqKwvvefRYCQ5Z67HFvEq");
    expect(verdict.powers.pauseAuthority).toBe("JDq14BWvqCRFNu1krb12bcRpbGtJZ1FLEakMw6FdxJNs");
    expect(verdict.powers.scaledUiAmount).not.toBeNull();
  });

  it("refuses an xStock without a TokenBadge, which DBC needs for a Permanent Delegate", () => {
    expect(quoteVerdict(quote(NVDAX, false))).toMatchObject({ dbcAccepts: false, accepted: false, refusals: ["needs-token-badge"] });
  });

  it("refuses a paused quote, a Frozen default state and a transfer hook naming a program", () => {
    const paused = withExtension(NVDAX, "PausableConfig", (e) => ({ ...e, paused: true }) as Extension);
    expect(quoteVerdict(quote(paused)).refusals).toEqual(["paused"]);
    const frozen = withExtension(NVDAX, "DefaultAccountState", (e) => ({ ...e, state: AccountState.Frozen }) as Extension);
    expect(quoteVerdict(quote(frozen)).refusals).toEqual(["default-state-frozen"]);
    const hooked = withExtension(NVDAX, "TransferHook", (e) => ({ ...e, programId: SOME_PROGRAM }) as Extension);
    expect(quoteVerdict(quote(hooked)).refusals).toEqual(["transfer-hook-program"]);
  });

  const fee = (basisPoints: number, authority: Address = address("11111111111111111111111111111111"), maximumFee = 1_000n): Mint => ({
    ...NVDAX,
    mintAuthority: none(),
    freezeAuthority: none(),
    extensions: some([
      {
        __kind: "TransferFeeConfig",
        transferFeeConfigAuthority: authority,
        withdrawWithheldAuthority: authority,
        withheldAmount: 0n,
        olderTransferFee: { epoch: 0n, maximumFee, transferFeeBasisPoints: 0 },
        newerTransferFee: { epoch: 900n, maximumFee, transferFeeBasisPoints: basisPoints },
      },
    ]),
  });

  it("takes a Token-2022 quote with only a zero, frozen transfer fee as DBC does, with no badge", () => {
    expect(quoteVerdict(quote(fee(0), false))).toMatchObject({ dbcAccepts: true, accepted: true });
    expect(quoteVerdict(quote(fee(25, undefined, 0n), false))).toMatchObject({ dbcAccepts: true, accepted: true });
  });

  it("refuses a transfer fee, even one scheduled, and a live fee authority, even with a badge", () => {
    expect(quoteVerdict(quote(fee(25))).refusals).toEqual(["transfer-fee"]);
    expect(quoteVerdict(quote(fee(25), false)).refusals).toEqual(["needs-token-badge", "transfer-fee"]);
    expect(quoteVerdict(quote(fee(0, SOME_PROGRAM))).refusals).toEqual(["transfer-fee-authority"]);
  });

  it("accepts any SPL Token mint, wrapped SOL included, and refuses Token-2022's native mint", () => {
    const spl: Mint = { ...NVDAX, extensions: none() };
    expect(quoteVerdict({ ...quote(spl, false), tokenProgram: TOKEN_PROGRAM_ADDRESS }).accepted).toBe(true);
    expect(quoteVerdict({ ...quote(spl, false), address: TOKEN_2022_NATIVE_MINT }).refusals).toEqual(["token-2022-native-mint"]);
    expect(quoteVerdict({ ...quote(spl), tokenProgram: SOME_PROGRAM }).refusals).toEqual(["unknown-token-program"]);
  });
});

describe("the devnet stand-in xStock", () => {
  // Its account as devnet held it on 2026-11-03, just after `xstock-stand-in` made it.
  const STAND_IN = getMintDecoder().decode(getBase64Encoder().encode(standIn.data));
  const BANK = address("Ew6E318g8SYCSjCUdRqcpSywRUzuFUPoxLAQWYfZD933");

  it("carries NVDAx's extensions in NVDAx's order, and its decimals", () => {
    expect(standIn.address).toBe(DEVNET_XSTOCK_STAND_IN);
    const verdict = quoteVerdict({ ...quote(STAND_IN), address: DEVNET_XSTOCK_STAND_IN });
    expect(verdict.extensions).toEqual(quoteVerdict(quote(NVDAX)).extensions);
    expect(STAND_IN.decimals).toBe(NVDAX.decimals);
    expect(verdict).toMatchObject({ dbcAccepts: true, accepted: true });
  });

  it("gives Heat's devnet bank every power the xStocks issuer holds", () => {
    const { powers } = quoteVerdict({ ...quote(STAND_IN), address: DEVNET_XSTOCK_STAND_IN });
    expect(powers).toMatchObject({ permanentDelegate: BANK, pauseAuthority: BANK, freezeAuthority: BANK, mintAuthority: BANK });
    expect(powers.scaledUiAmount).toMatchObject({ authority: BANK, multiplier: 1 });
  });

  it("needs a TokenBadge before DBC takes it", () => {
    expect(quoteVerdict({ ...quote(STAND_IN, false), address: DEVNET_XSTOCK_STAND_IN }).refusals).toEqual(["needs-token-badge"]);
  });
});

describe("scaledUiMultiplier", () => {
  it("switches to the new multiplier at its timestamp", () => {
    const scaled = { authority: SOME_PROGRAM, multiplier: 1, newMultiplier: 0.1, newMultiplierAt: 1_800_000_000n };
    expect(scaledUiMultiplier(scaled, 1_799_999_999n)).toBe(1);
    expect(scaledUiMultiplier(scaled, 1_800_000_000n)).toBe(0.1);
  });
});
