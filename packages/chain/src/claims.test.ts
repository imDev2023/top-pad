import {
  createNoopSigner,
  generateKeyPairSigner,
  getAddressDecoder,
  type Address,
  type Blockhash,
  type Instruction,
  isTransactionMessageWithinSizeLimit,
} from "@solana/kit";
import { findCoinRecordPda, findWindowClaimPda, TAX_WINDOW_SECONDS } from "@top-pad/clients/fee";
import { describe, expect, it } from "vitest";
import { claimablePool, creatorClaimInstructions, creatorClaimMessages, creatorShare, quoteAccount, windowClaimInstructions, type ClaimablePool } from "./claims";
import { SNIPER_TAX } from "./coin";
import { DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS } from "./dbc";
import { SOL_QUOTE, type QuoteToken } from "./fairOpen";
import { FEE_CLAIMER_ADDRESS, FEE_PROGRAM_ADDRESS, WSOL_MINT } from "./index";
import { DEVNET_XSTOCK_STAND_IN } from "./quotes";

const XSTOCK: QuoteToken = { mint: DEVNET_XSTOCK_STAND_IN, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS };
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

const random = () => getAddressDecoder().decode(crypto.getRandomValues(new Uint8Array(32)));
const lifetime = { blockhash: "11111111111111111111111111111111" as Blockhash, lastValidBlockHeight: 0n };
const feeProgram = (instructions: Instruction[]) => instructions.filter((ix) => ix.programAddress === FEE_PROGRAM_ADDRESS);
const accounts = (ix: Instruction) => (ix.accounts ?? []).map((a) => a.address);

function pool(creator: Address, partnerQuoteFee = 1_000n, quote: QuoteToken = SOL_QUOTE): ClaimablePool {
  return {
    pool: random(),
    config: random(),
    mint: random(),
    quoteMint: quote.mint,
    quoteTokenProgram: quote.tokenProgram,
    baseVault: random(),
    quoteVault: random(),
    creator,
    partnerQuoteFee,
    windowEndsAt: 1_800_000_060n,
  };
}

describe("the Tax window", () => {
  it("is the sniper tax's whole fall: the fee program's window is the configs' 60 one-second periods", () => {
    expect(TAX_WINDOW_SECONDS).toBe(BigInt(SNIPER_TAX.numberOfPeriod) * SNIPER_TAX.periodFrequency);
  });

  it("ends a window's length after the pool's activation point", () => {
    const state = { config: random(), creator: random(), baseMint: random(), baseVault: random(), quoteVault: random(), partnerQuoteFee: 5n, activationPoint: 1_800_000_000n };
    const p = claimablePool(random(), state as never, SOL_QUOTE);
    expect(p.windowEndsAt).toBe(1_800_000_060n);
    expect(claimablePool(random(), state as never, XSTOCK)).toMatchObject({ quoteMint: XSTOCK.mint, quoteTokenProgram: TOKEN_2022_PROGRAM_ADDRESS });
    expect(p).toMatchObject({ creator: state.creator, mint: state.baseMint, partnerQuoteFee: 5n });
  });
});

describe("a creator's share", () => {
  it("is half the claim rounded down, as the fee program pays it", () => {
    expect([0n, 1n, 2n, 1_001n].map(creatorShare)).toEqual([0n, 0n, 1n, 500n]);
  });
});

describe("the window claim", () => {
  it("pays a Heat coin's window to the treasury's quote account, with the coin's record", async () => {
    const payer = await generateKeyPairSigner();
    const treasury = random();
    const p = pool(random());
    const [claim] = feeProgram(await windowClaimInstructions({ pool: p, heat: true, treasury, payer, computeUnitPrice: 0n }));
    const named = accounts(claim!);
    expect(named).toContain((await findCoinRecordPda({ mint: p.mint }))[0]);
    expect(named).toContain(await quoteAccount(treasury, WSOL_MINT, TOKEN_PROGRAM_ADDRESS));
    expect(named).toContain(await quoteAccount(FEE_CLAIMER_ADDRESS, WSOL_MINT, TOKEN_PROGRAM_ADDRESS));
    expect(named).toEqual(expect.arrayContaining([p.pool, p.config, p.baseVault, p.quoteVault, p.mint]));
  });

  it("gives a pool made around Heat's flow a WindowClaim, paid for by whoever sends it", async () => {
    const payer = await generateKeyPairSigner();
    const p = pool(random());
    const [claim] = feeProgram(await windowClaimInstructions({ pool: p, heat: false, treasury: random(), payer, computeUnitPrice: 0n }));
    expect(accounts(claim!)).toEqual(expect.arrayContaining([(await findWindowClaimPda({ pool: p.pool }))[0], payer.address]));
  });

  it("in an xStock opens and pays the treasury's and the fee claimer's Token-2022 accounts of the quote", async () => {
    const payer = await generateKeyPairSigner();
    const treasury = random();
    const instructions = await windowClaimInstructions({ pool: pool(random(), 1_000n, XSTOCK), heat: true, treasury, payer, computeUnitPrice: 0n });
    const opened = instructions.filter((ix) => ix.programAddress === ATA_PROGRAM);
    const [claim] = feeProgram(instructions);
    for (const [i, owner] of [treasury, FEE_CLAIMER_ADDRESS].entries()) {
      const account = await quoteAccount(owner, XSTOCK.mint, TOKEN_2022_PROGRAM_ADDRESS);
      expect(accounts(opened[i]!)).toEqual(expect.arrayContaining([account, owner, XSTOCK.mint, TOKEN_2022_PROGRAM_ADDRESS]));
      expect(accounts(claim!)).toContain(account);
    }
    expect(accounts(claim!)).toEqual(expect.arrayContaining([TOKEN_2022_PROGRAM_ADDRESS, DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS]));
  });
});

describe("a creator's claim", () => {
  it("claims each pool up to what was shown, pays the creator's quote account and unwraps SOL at the end", async () => {
    const creator = await generateKeyPairSigner();
    const heat = pool(creator.address);
    const around = pool(creator.address);
    const instructions = await creatorClaimInstructions({
      creator,
      treasury: random(),
      computeUnitPrice: 0n,
      claims: [
        { pool: heat, heat: true, maxAmount: 1_000n },
        { pool: around, heat: false, maxAmount: 2_000n },
      ],
    });
    const claims = feeProgram(instructions);
    expect(claims).toHaveLength(2);
    expect(accounts(claims[0]!)).toContain((await findCoinRecordPda({ mint: heat.mint }))[0]);
    expect(accounts(claims[1]!)).toContain((await findWindowClaimPda({ pool: around.pool }))[0]);
    expect(accounts(claims[0]!)).toContain(await quoteAccount(creator.address, WSOL_MINT, TOKEN_PROGRAM_ADDRESS));
    // `claim_fees`'s data: its discriminator, then the most it may claim.
    const amount = (ix: Instruction) => new DataView(ix.data!.buffer, ix.data!.byteOffset).getBigUint64(8, true);
    expect(claims.map(amount)).toEqual([1_000n, 2_000n]);
    // The last instruction closes the wrapped SOL account, so the earnings land as SOL.
    expect(accounts(instructions.at(-1)!)).toEqual([await quoteAccount(creator.address, WSOL_MINT, TOKEN_PROGRAM_ADDRESS), creator.address, creator.address]);
  });

  it("in an xStock pays Token-2022 accounts of the quote through DBC's Token-2022 quote program, and unwraps nothing", async () => {
    const creator = await generateKeyPairSigner();
    const treasury = random();
    const instructions = await creatorClaimInstructions({ creator, treasury, computeUnitPrice: 0n, claims: [{ pool: pool(creator.address, 1_000n, XSTOCK), heat: true, maxAmount: 1_000n }] });
    const [claim] = feeProgram(instructions);
    const named = accounts(claim!);
    for (const owner of [creator.address, treasury, FEE_CLAIMER_ADDRESS]) {
      expect(named).toContain(await quoteAccount(owner, XSTOCK.mint, TOKEN_2022_PROGRAM_ADDRESS));
      expect(named).not.toContain(await quoteAccount(owner, XSTOCK.mint, TOKEN_PROGRAM_ADDRESS));
    }
    // `claim_fees` names the coin's token program, then the quote's.
    expect(named).toEqual(expect.arrayContaining([TOKEN_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS]));
    expect(named.indexOf(TOKEN_2022_PROGRAM_ADDRESS)).toBe(named.indexOf(TOKEN_PROGRAM_ADDRESS) + 1);
    // The creator's account of the quote opened under Token-2022, and none closed after.
    const opened = instructions.find((ix) => ix.programAddress === ATA_PROGRAM)!;
    expect(accounts(opened)).toEqual(expect.arrayContaining([await quoteAccount(creator.address, XSTOCK.mint, TOKEN_2022_PROGRAM_ADDRESS), TOKEN_2022_PROGRAM_ADDRESS]));
    expect(instructions.at(-1)).toBe(claim);
  });

  it("pays one quote: an xStock and SOL, or one mint under two programs, never share a claim", async () => {
    const creator = createNoopSigner(random());
    const sol = { pool: pool(creator.address), heat: true, maxAmount: 1n };
    const xstock = { pool: pool(creator.address, 1n, XSTOCK), heat: true, maxAmount: 1n };
    const misread = { pool: pool(creator.address, 1n, { mint: XSTOCK.mint, tokenProgram: TOKEN_PROGRAM_ADDRESS }), heat: true, maxAmount: 1n };
    for (const claims of [[sol, xstock], [xstock, misread]]) {
      await expect(creatorClaimInstructions({ creator, treasury: random(), computeUnitPrice: 0n, claims })).rejects.toThrow(/one quote/);
    }
  });

  it("claims only pools whose creator role the signer holds", async () => {
    const creator = createNoopSigner(random());
    const claims = [{ pool: pool(random()), heat: true, maxAmount: 1n }];
    await expect(creatorClaimInstructions({ creator, treasury: random(), computeUnitPrice: 0n, claims })).rejects.toThrow(/creator role/);
  });

  it("fits as many pools as a transaction holds, and splits the rest into more transactions", async () => {
    const creator = createNoopSigner(random());
    const claims = Array.from({ length: 9 }, () => ({ pool: pool(creator.address), heat: true, maxAmount: 1_000n }));
    const messages = await creatorClaimMessages({ creator, treasury: random(), computeUnitPrice: 1n, claims }, lifetime);
    const perTransaction = messages.map((m) => m.instructions.filter((ix) => ix.programAddress === FEE_PROGRAM_ADDRESS).length);
    console.log(`a creator's claim holds ${perTransaction[0]} pools a transaction: ${perTransaction.join(" + ")} for 9`);
    expect(perTransaction.reduce((a, b) => a + b)).toBe(9);
    expect(perTransaction[0]).toBeGreaterThanOrEqual(2);
    expect(messages.every((m) => isTransactionMessageWithinSizeLimit(m))).toBe(true);
  });
});
