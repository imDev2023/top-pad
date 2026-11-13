// Graduation's instructions in a Token-2022 quote (ADR 0007, #91): every account of the quote they name is the quote's
// under its own token program, and each instruction names that program where Meteora and the fee program take the
// quote's, while the coin's accounts stay SPL Token's. The devnet run is `tests/devnet/src/graduation.test.ts`.
import { generateKeyPairSigner, getAddressDecoder, type Address, type Instruction } from "@solana/kit";
import { findAssociatedTokenPda } from "@solana-program/token";
import { describe, expect, it } from "vitest";
import { DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS, quoteTokenProgramOf } from "./dbc";
import { SOL_QUOTE, type QuoteToken } from "./fairOpen";
import {
  creatorLpFeeClaimInstructions,
  DAMM_V2_PROGRAM_ADDRESS,
  dammV2VaultAddress,
  graduating,
  lpFeeClaimInstructions,
  migrationInstructions,
  surplusClaimInstructions,
  type GraduatedPosition,
} from "./graduation";
import { FEE_CLAIMER_ADDRESS, FEE_PROGRAM_ADDRESS } from "./index";
import { DEVNET_XSTOCK_STAND_IN } from "./quotes";

const XSTOCK: QuoteToken = { mint: DEVNET_XSTOCK_STAND_IN, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS };
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL" as Address;
const random = () => getAddressDecoder().decode(crypto.getRandomValues(new Uint8Array(32)));
const accounts = (ix: Instruction) => (ix.accounts ?? []).map((a) => a.address);
const of = (instructions: Instruction[], program: Address) => instructions.filter((ix) => ix.programAddress === program);
const ata = async (owner: Address, mint: Address, tokenProgram: Address) => (await findAssociatedTokenPda({ owner, mint, tokenProgram }))[0];

const state = { config: random(), creator: random(), baseMint: random(), baseVault: random(), quoteVault: random(), partnerQuoteFee: 0n, activationPoint: 0n };

describe("the quote's token program", () => {
  it("is read from DBC's quote token flag, and no other flag names one", () => {
    expect([0, 1].map(quoteTokenProgramOf)).toEqual([TOKEN_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS]);
    expect(() => quoteTokenProgramOf(2)).toThrow(/names no token program/);
  });

  it("rides on a graduating pool with its quote", () => {
    expect(graduating(random(), state as never, XSTOCK)).toMatchObject({ quoteMint: XSTOCK.mint, quoteTokenProgram: TOKEN_2022_PROGRAM_ADDRESS, mint: state.baseMint });
    expect(graduating(random(), state as never, SOL_QUOTE).quoteTokenProgram).toBe(TOKEN_PROGRAM_ADDRESS);
  });
});

describe("Graduation in an xStock", () => {
  const pool = () => graduating(random(), state as never, XSTOCK);

  it("migrates with DBC's quote program Token-2022's, and its base program SPL Token's", async () => {
    const p = pool();
    const [migrate] = of(
      await migrationInstructions({
        pool: p,
        payer: await generateKeyPairSigner(),
        firstPositionNft: await generateKeyPairSigner(),
        secondPositionNft: await generateKeyPairSigner(),
        computeUnitPrice: 0n,
      }),
      DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS,
    );
    const named = accounts(migrate!);
    // `migration_damm_v2`'s base, quote and Token-2022 programs, in that order, after the payer.
    const at = named.indexOf(TOKEN_PROGRAM_ADDRESS);
    expect(named.slice(at, at + 3)).toEqual([TOKEN_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS]);
    expect(named).toContain(XSTOCK.mint);
  });

  it("splits the surplus into Token-2022 accounts of the quote, each opened under Token-2022", async () => {
    const p = pool();
    const creator = random();
    const treasury = random();
    const payer = await generateKeyPairSigner();
    const instructions = await surplusClaimInstructions({ pool: p, creator, treasury, surplus: { creator: 1n, treasury: 1n }, payer, computeUnitPrice: 0n });
    const opened = of(instructions, ATA_PROGRAM);
    expect(opened).toHaveLength(3);
    const [claim] = of(instructions, FEE_PROGRAM_ADDRESS);
    for (const [i, owner] of [FEE_CLAIMER_ADDRESS, creator, treasury].entries()) {
      const account = await ata(owner, XSTOCK.mint, TOKEN_2022_PROGRAM_ADDRESS);
      expect(accounts(opened[i]!)).toEqual(expect.arrayContaining([account, owner, XSTOCK.mint, TOKEN_2022_PROGRAM_ADDRESS]));
      expect(accounts(claim!)).toContain(account);
    }
    expect(accounts(claim!)).toContain(TOKEN_2022_PROGRAM_ADDRESS);
    expect(accounts(claim!)).not.toContain(TOKEN_PROGRAM_ADDRESS);
  });

  async function position(): Promise<GraduatedPosition> {
    return { pool: random(), mint: random(), quoteMint: XSTOCK.mint, quoteTokenProgram: XSTOCK.tokenProgram, position: random(), nftAccount: random() };
  }

  it("claims Heat's LP fees into the treasury's Token-2022 account of the quote, and the coin's into the fee claimer's SPL Token one", async () => {
    const heat = await position();
    const treasury = random();
    const instructions = await lpFeeClaimInstructions({ heat, treasury, payer: await generateKeyPairSigner(), computeUnitPrice: 0n });
    const [treasuryOpened, coinOpened] = of(instructions, ATA_PROGRAM);
    const treasuryQuote = await ata(treasury, XSTOCK.mint, TOKEN_2022_PROGRAM_ADDRESS);
    const feeClaimerCoins = await ata(FEE_CLAIMER_ADDRESS, heat.mint, TOKEN_PROGRAM_ADDRESS);
    expect(accounts(treasuryOpened!)).toEqual(expect.arrayContaining([treasuryQuote, TOKEN_2022_PROGRAM_ADDRESS]));
    expect(accounts(coinOpened!)).toEqual(expect.arrayContaining([feeClaimerCoins, TOKEN_PROGRAM_ADDRESS]));
    const named = accounts(of(instructions, FEE_PROGRAM_ADDRESS)[0]!);
    expect(named).toEqual(expect.arrayContaining([treasuryQuote, feeClaimerCoins, await dammV2VaultAddress(heat.pool, XSTOCK.mint)]));
    const at = named.indexOf(TOKEN_PROGRAM_ADDRESS);
    expect(named.slice(at, at + 2)).toEqual([TOKEN_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS]);
  });

  it("claims the creator's LP fees from Meteora with token B's program Token-2022's", async () => {
    const p = await position();
    const creator = await generateKeyPairSigner();
    const instructions = await creatorLpFeeClaimInstructions({ position: p, creator });
    const named = accounts(of(instructions, DAMM_V2_PROGRAM_ADDRESS)[0]!);
    expect(named).toEqual(expect.arrayContaining([await ata(creator.address, XSTOCK.mint, TOKEN_2022_PROGRAM_ADDRESS), await ata(creator.address, p.mint, TOKEN_PROGRAM_ADDRESS)]));
    const at = named.indexOf(TOKEN_PROGRAM_ADDRESS);
    expect(named.slice(at, at + 2)).toEqual([TOKEN_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS]);
  });
});
