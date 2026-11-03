import { describe, expect, it } from "vitest";
import { launchFromBlock, type BlockTransaction } from "./block";

const MINT = "Mint111111111111111111111111111111111111111";
const bal = (accountIndex: number, owner: string, amount: string) => ({ accountIndex, mint: MINT, owner, programId: "Token2022", uiTokenAmount: { amount } });
const tx = (signature: string, signers: string[], pre: ReturnType<typeof bal>[], post: ReturnType<typeof bal>[], err: unknown = null): BlockTransaction => ({
  meta: { err, preTokenBalances: pre, postTokenBalances: post },
  transaction: { accountKeys: [...signers.map((pubkey) => ({ pubkey, signer: true })), { pubkey: "Other", signer: false }], signatures: [signature] },
});

const block: BlockTransaction[] = [
  tx("before", ["Early"], [], []),
  // The creation: the creator pays, the coin signs; the curve keeps the unsold supply, the creator its own buy.
  tx("creation", ["Creator", MINT], [], [bal(2, "Curve", "900"), bal(3, "Creator", "100")]),
  tx("buy", ["Buyer"], [bal(2, "Curve", "900")], [bal(2, "Curve", "850"), bal(3, "Buyer", "50")]),
  tx("failed", ["Late"], [bal(2, "Curve", "850")], [bal(2, "Curve", "800"), bal(3, "Late", "50")], { InstructionError: [0, "Custom"] }),
  tx("sell", ["Creator"], [bal(2, "Curve", "850"), bal(3, "Creator", "100")], [bal(2, "Curve", "950"), bal(3, "Creator", "0")]),
  tx("transfer", ["Buyer"], [bal(2, "Buyer", "50")], [bal(2, "Buyer", "0"), bal(3, "Friend", "50")]),
  tx("paid-for", ["Payer", "Second"], [bal(2, "Curve", "950")], [bal(2, "Curve", "940"), bal(3, "Second", "10")]),
];

describe("launchFromBlock", () => {
  it("finds the coin, its creator and curve, and each later buy of it in the slot", () => {
    const found = launchFromBlock(block, "creation", 1);
    expect(found).toEqual({
      mint: MINT,
      creator: "Creator",
      curve: "Curve",
      tokenProgram: "Token2022",
      buys: [
        { signature: "buy", blockIndex: 2, trader: "Buyer", signers: ["Buyer"], baseAmount: "50" },
        { signature: "paid-for", blockIndex: 6, trader: "Second", signers: ["Payer", "Second"], baseAmount: "10" },
      ],
    });
  });

  it("says why a listed transaction is not a launch", () => {
    expect(launchFromBlock(block, "creation", 2)).toEqual({ skipped: "the block holds another transaction at index 2" });
    expect(launchFromBlock(block, "before", 0)).toEqual({ skipped: "no coin signed its creation" });
  });
});
