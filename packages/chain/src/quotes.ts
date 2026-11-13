// Which mints a coin may be priced in (ADR 0007, "Which quotes"; spec 3.2): a quote is offered only if Meteora's DBC
// accepts it, and Heat refuses some DBC accepts. Read from the mint's own account and its DBC TokenBadge, never from a
// list kept by hand. Pure, so the scripts, the API and the tests share one reading.
import { address, isSome, type Address } from "@solana/kit";
import { AccountState, getMintDecoder, TOKEN_2022_PROGRAM_ADDRESS, type Extension, type Mint } from "@solana-program/token-2022";

export const TOKEN_PROGRAM_ADDRESS = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
/** Token-2022's own wrapped SOL, which DBC refuses as a quote; SOL is quoted as the SPL Token wrapped SOL mint. */
export const TOKEN_2022_NATIVE_MINT = address("9pan9bMn5HatX4EJdBwg9VgCa7Uz5HL8N1m5D3NdXejP");
/**
 * Devnet's stand-in xStock (spec 11.2), made on 2026-11-03 by `pnpm --filter @top-pad/chain xstock-stand-in devnet
 * --send` with NVDAx's extensions, Heat's devnet bank holding every issuer authority. DBC takes it as a quote once Meteora
 * creates its devnet TokenBadge (#26).
 */
export const DEVNET_XSTOCK_STAND_IN = address("Wm7nXsHnoHJm3NemWaLbnxd7QkmeHLALucsFC4qTUNK");
/**
 * Devnet's Token-2022 test quote (#91), made on 2026-11-13 by `pnpm --filter @top-pad/chain token-2022-quote devnet
 * --send`: Metadata Pointer and Token Metadata only, which DBC takes with no TokenBadge, 8 decimals, Heat's devnet bank its
 * mint authority. `tests/devnet` prices coins in it to run a Token-2022 quote through Graduation against Meteora's
 * deployed programs; it is never offered, so `CLUSTERS` does not list it.
 */
export const DEVNET_TOKEN_2022_TEST_QUOTE = address("ABuYPpu4XgwPowARd3uwLHPoM1dDGztVUQDFE823L2PV");
/** How Token-2022 stores an unset optional authority: 32 zero bytes. */
const NONE = address("11111111111111111111111111111111");

export { TOKEN_2022_PROGRAM_ADDRESS };

/** A mint account's bytes as a mint, SPL Token's or Token-2022's with its extensions. */
export const decodeQuoteMint = (data: Uint8Array): Mint => getMintDecoder().decode(data);

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
  /** Whether every transfer of the mint is paused now: a pause authority's power in use. */
  paused: boolean;
  /** The Transfer Hook extension: who may set its program, and the program it names, each null when none. */
  transferHook: { authority: Address | null; programId: Address | null } | null;
  /** The state a new account of the mint starts in, when the mint sets one (Default Account State). */
  defaultAccountState: "initialized" | "frozen" | null;
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
  const defaultState = of("DefaultAccountState")?.state;
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
      paused: pausable?.paused ?? false,
      transferHook: hook ? { authority: hook.authority === NONE ? null : hook.authority, programId: hook.programId === NONE ? null : hook.programId } : null,
      defaultAccountState: defaultState === undefined ? null : defaultState === AccountState.Frozen ? "frozen" : "initialized",
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

/**
 * The multiplier a quote's raw amounts are shown through at `unixTime`: its Scaled UI Amount multiplier, or 1 for a
 * mint without one. Heat stores and charts every amount in raw units and shows them all through the multiplier in force
 * now, so a split rescales a chart as a whole and never puts a step in it (ADR 0007 decision 5).
 */
export const displayMultiplier = (powers: QuotePowers, unixTime: bigint): number =>
  powers.scaledUiAmount ? scaledUiMultiplier(powers.scaledUiAmount, unixTime) : 1;

/**
 * The kinds of Quote Risk Label (ADR 0007 decision 5), in the order a page shows them: the powers an issuer holds over
 * the quote and everyone holding it, then how its balances read. Stoker's kinds (Stoker `CONTEXT.md`, "Quote Risk
 * Label"), less the transfer fee Heat never accepts in a quote.
 */
export const QUOTE_LABEL_KINDS = ["freeze", "permanent_delegate", "pausable", "transfer_hook", "default_frozen", "scaled_balance"] as const;
export type QuoteLabelKind = (typeof QUOTE_LABEL_KINDS)[number];

/**
 * A Quote Risk Label: one fact about a quote a creator or trader should know before using it, read from its mint, in
 * Stoker's words. Labels inform: they never refuse a launch or a trade (Heat's refusals are `QuoteRefusal`s).
 */
export type QuoteLabel = {
  kind: QuoteLabelKind;
  /** `caution` for a power someone holds over the quote or its holders, `info` for a fact about how it reads. */
  severity: "caution" | "info";
  /** Short enough for a chip: "Can pause transfers". */
  title: string;
  /** A sentence or two on what it means for a creator or trader. */
  detail: string;
  /** The key that holds the power, for a link to it; null for a fact no key holds. */
  holder: Address | null;
};

const short = (key: Address) => `${key.slice(0, 4)}\u{2026}${key.slice(-4)}`;
const multiplierText = (m: number) => m.toLocaleString("en-US", { maximumFractionDigits: 4 });

/**
 * What a quote's mint says about it, in the words Heat's pages show (Stoker's `mintLabels`, ADR 0007 decision 5), for
 * the quote named `symbol`, at `unixTime` for the multiplier in force. Cautions first, then facts, each kind once.
 */
export function quoteLabels(powers: QuotePowers, symbol: string, unixTime: bigint): QuoteLabel[] {
  const out: QuoteLabel[] = [];
  const add = (kind: QuoteLabelKind, severity: QuoteLabel["severity"], title: string, detail: string, holder: Address | null) =>
    out.push({ kind, severity, title, detail, holder });
  if (powers.freezeAuthority) {
    add("freeze", "caution", "Can freeze wallets",
      `The issuer (${short(powers.freezeAuthority)}) can freeze any wallet's ${symbol}, which would stop that wallet buying, selling or claiming.`, powers.freezeAuthority);
  }
  if (powers.permanentDelegate) {
    add("permanent_delegate", "caution", "Issuer can move tokens",
      `The issuer (${short(powers.permanentDelegate)}) can move or burn ${symbol} from any wallet without its owner's signature.`, powers.permanentDelegate);
  }
  if (powers.paused) {
    add("pausable", "caution", "Transfers paused",
      `The issuer has paused every transfer of ${symbol}: nothing can be bought, sold or claimed until it resumes them.`, powers.pauseAuthority);
  } else if (powers.pauseAuthority) {
    add("pausable", "caution", "Can pause transfers",
      `The issuer (${short(powers.pauseAuthority)}) can stop every transfer of ${symbol} at any time; buys, sells and claims fail while it is paused.`, powers.pauseAuthority);
  }
  const hook = powers.transferHook;
  if (hook?.programId) {
    add("transfer_hook", "caution", "Transfer hook",
      `A program (${short(hook.programId)}) runs on every transfer of ${symbol}${hook.authority ? `, set by the issuer (${short(hook.authority)})` : ""}; it can refuse or change any transfer.`, hook.authority);
  } else if (hook?.authority) {
    add("transfer_hook", "caution", "Can add a transfer hook",
      `The issuer (${short(hook.authority)}) can attach a program that runs on every transfer of ${symbol}; trades and claims could then need extra accounts or fail.`, hook.authority);
  }
  if (powers.defaultAccountState === "frozen") {
    add("default_frozen", "caution", "New wallets start frozen",
      `Every new ${symbol} account starts frozen until the issuer thaws it, so a first buy into a new wallet can be stuck.`, powers.freezeAuthority);
  } else if (powers.defaultAccountState === "initialized" && powers.freezeAuthority) {
    add("default_frozen", "caution", "Can freeze new wallets by default",
      `New ${symbol} accounts open unfrozen today, but the issuer can make every new one start frozen until it approves it.`, powers.freezeAuthority);
  }
  if (powers.scaledUiAmount) {
    const now = scaledUiMultiplier(powers.scaledUiAmount, unixTime);
    add("scaled_balance", "info", "Scaled balances",
      `${symbol} balances are shown through a multiplier (${multiplierText(now)} today) its issuer changes on dividends and splits; Heat shows every price, balance and market cap through today's, so a change rescales a chart without breaking it.`,
      powers.scaledUiAmount.authority);
  }
  return out;
}
