// Which mints a coin may be priced in (ADR 0007, "Which quotes"; spec 3.2): a quote is offered only if Meteora's DBC
// accepts it, and Heat refuses some DBC accepts. Read from the mint's own account and its DBC TokenBadge, never from a
// list kept by hand. Pure, so the scripts, the API and the tests share one reading.
import { address, isSome, type Address } from "@solana/kit";
import { AccountState, TOKEN_2022_PROGRAM_ADDRESS, type Extension, type Mint } from "@solana-program/token-2022";

export const TOKEN_PROGRAM_ADDRESS = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
/** Token-2022's own wrapped SOL, which DBC refuses as a quote; SOL is quoted as the SPL Token wrapped SOL mint. */
export const TOKEN_2022_NATIVE_MINT = address("9pan9bMn5HatX4EJdBwg9VgCa7Uz5HL8N1m5D3NdXejP");
/**
 * Devnet's stand-in xStock (spec 11.2), made on 2026-11-03 by `pnpm --filter @top-pad/chain xstock-stand-in devnet
 * --send` with NVDAx's extensions, Heat's devnet bank holding every issuer authority. DBC takes it as a quote once Meteora
 * creates its devnet TokenBadge (#26).
 */
export const DEVNET_XSTOCK_STAND_IN = address("Wm7nXsHnoHJm3NemWaLbnxd7QkmeHLALucsFC4qTUNK");
/** How Token-2022 stores an unset optional authority: 32 zero bytes. */
const NONE = address("11111111111111111111111111111111");

/** A mint as the chain holds it: the program that owns it, its decoded account, and whether DBC has badged it. */
export type QuoteMint = { address: Address; tokenProgram: Address; mint: Mint; tokenBadge: boolean };

/** Why Heat refuses a quote DBC would accept, or why DBC refuses it (spec 3.2, ADR 0007). */
export type QuoteRefusal =
  | "unknown-token-program"
  | "token-2022-native-mint"
  | "needs-token-badge"
  | "transfer-fee"
  | "transfer-fee-authority"
  | "transfer-hook-program"
  | "default-state-frozen"
  | "paused";

/** The issuer powers a Quote Risk Label shows (ADR 0007 decision 5), each with the key that holds it. */
export type QuotePowers = {
  permanentDelegate: Address | null;
  pauseAuthority: Address | null;
  freezeAuthority: Address | null;
  mintAuthority: Address | null;
  /** The Scaled UI Amount multiplier now in force, and the one scheduled after it, if any. */
  scaledUiAmount: { authority: Address; multiplier: number; newMultiplier: number; newMultiplierAt: bigint } | null;
};

export type QuoteVerdict = {
  /** DBC takes the mint as a config's quote: SPL Token, a permissionless Token-2022 mint, or one with a TokenBadge. */
  dbcAccepts: boolean;
  /** Heat offers it: DBC accepts it and none of Heat's own refusals apply. */
  accepted: boolean;
  refusals: QuoteRefusal[];
  /** Every extension on the mint, by name, for the record. */
  extensions: Extension["__kind"][];
  powers: QuotePowers;
};

/** The Token-2022 extensions DBC treats as permissionless on a quote (Meteora, "DBC Token 2022 Support"). */
const PERMISSIONLESS = new Set<Extension["__kind"]>(["MetadataPointer", "TokenMetadata", "TransferFeeConfig"]);

type TransferFeeConfig = Extract<Extension, { __kind: "TransferFeeConfig" }>;

function hasFee(config: TransferFeeConfig) {
  const fees = [config.olderTransferFee, config.newerTransferFee];
  return fees.some((fee) => fee.transferFeeBasisPoints !== 0 && fee.maximumFee !== 0n);
}

function optional(value: Mint["mintAuthority"]): Address | null {
  return isSome(value) ? value.value : null;
}

/**
 * Reads a mint against DBC's quote rules and Heat's own (ADR 0007, "Which quotes"): no transfer fee or live fee
 * authority, now or later; no transfer hook naming a program; no Frozen default state; not paused. A paused quote is
 * refused at scheduling here, and the open checks it again on chain.
 */
export function quoteVerdict({ address: mintAddress, tokenProgram, mint, tokenBadge }: QuoteMint): QuoteVerdict {
  const extensions = isSome(mint.extensions) ? mint.extensions.value : [];
  const of = <K extends Extension["__kind"]>(kind: K) =>
    extensions.find((extension): extension is Extract<Extension, { __kind: K }> => extension.__kind === kind);
  const refusals: QuoteRefusal[] = [];

  let dbcAccepts: boolean;
  if (tokenProgram === TOKEN_PROGRAM_ADDRESS) dbcAccepts = true;
  else if (tokenProgram !== TOKEN_2022_PROGRAM_ADDRESS) {
    dbcAccepts = false;
    refusals.push("unknown-token-program");
  } else if (mintAddress === TOKEN_2022_NATIVE_MINT) {
    dbcAccepts = false;
    refusals.push("token-2022-native-mint");
  } else {
    const fee = of("TransferFeeConfig");
    const permissionless =
      extensions.every((extension) => PERMISSIONLESS.has(extension.__kind)) &&
      (!fee || (!hasFee(fee) && fee.transferFeeConfigAuthority === NONE));
    dbcAccepts = permissionless || tokenBadge;
    if (!dbcAccepts) refusals.push("needs-token-badge");
  }

  const fee = of("TransferFeeConfig");
  if (fee && hasFee(fee)) refusals.push("transfer-fee");
  if (fee && fee.transferFeeConfigAuthority !== NONE) refusals.push("transfer-fee-authority");
  const hook = of("TransferHook");
  if (hook && hook.programId !== NONE) refusals.push("transfer-hook-program");
  if (of("DefaultAccountState")?.state === AccountState.Frozen) refusals.push("default-state-frozen");
  const pausable = of("PausableConfig");
  if (pausable?.paused) refusals.push("paused");

  const scaled = of("ScaledUiAmountConfig");
  const delegate = of("PermanentDelegate")?.delegate;
  return {
    dbcAccepts,
    accepted: refusals.length === 0,
    refusals,
    extensions: extensions.map((extension) => extension.__kind),
    powers: {
      permanentDelegate: delegate && delegate !== NONE ? delegate : null,
      pauseAuthority: pausable ? optional(pausable.authority) : null,
      freezeAuthority: optional(mint.freezeAuthority),
      mintAuthority: optional(mint.mintAuthority),
      scaledUiAmount: scaled
        ? {
            authority: scaled.authority,
            multiplier: scaled.multiplier,
            newMultiplier: scaled.newMultiplier,
            newMultiplierAt: scaled.newMultiplierEffectiveTimestamp,
          }
        : null,
    },
  };
}

/**
 * The Scaled UI Amount multiplier in force at `unixTime` (Token-2022: the new one from its timestamp on), by which a
 * quote's raw amounts are shown, so a split or a dividend moves no chart (ADR 0007 decision 5).
 */
export function scaledUiMultiplier(scaled: NonNullable<QuotePowers["scaledUiAmount"]>, unixTime: bigint): number {
  return unixTime >= scaled.newMultiplierAt ? scaled.newMultiplier : scaled.multiplier;
}
