import { getProgramDerivedAddress, getUtf8Encoder } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { FEE_CLAIMER_ADDRESS, FEE_CLAIMER_SEED, FEE_PROGRAM_ADDRESS } from "./index";

describe("the fee claimer", () => {
  it("is the fee program's PDA of its seed, which every config names forever", async () => {
    const [pda] = await getProgramDerivedAddress({
      programAddress: FEE_PROGRAM_ADDRESS,
      seeds: [getUtf8Encoder().encode(FEE_CLAIMER_SEED)],
    });
    expect(pda).toBe(FEE_CLAIMER_ADDRESS);
  });
});
