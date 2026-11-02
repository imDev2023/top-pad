// The shape of `fixtures/swaps.json`, which `pnpm --filter @top-pad/meteora swap-fixtures <pool>...` records from
// devnet and `quote.test.ts` replays. Integers are decimal strings, as JSON cannot hold a u64.
import type { QuoteConfig } from "../quote";

type Strings<T> = { [K in keyof T]: T[K] extends bigint ? string : T[K] };

export type SwapFixtures = {
  recordedAt: string;
  pools: {
    pool: string;
    config: Strings<Omit<QuoteConfig, "curve" | "poolFees">> & {
      address: string;
      curve: { sqrtPrice: string; liquidity: string }[];
      baseFee: Strings<QuoteConfig["poolFees"]["baseFee"]>;
      dynamicFee: QuoteConfig["poolFees"]["dynamicFee"];
    };
    activationPoint: string;
    /** Every swap the pool has had, in the order they ran. */
    swaps: {
      signature: string;
      /** Whether it ran in the pool's creation transaction, where a config may grant the first swap its minimum fee. */
      inCreation: boolean;
      side: "buy" | "sell";
      /** DBC's `SwapMode`: 0 exact in, 1 partial fill. */
      swapMode: number;
      /** The swap instruction's own amounts. */
      amountIn: string;
      minimumOut: string;
      hasReferral: boolean;
      /** The chain's clock as it ran, in Unix seconds. */
      timestamp: string;
      /** What DBC's `EvtSwap3` says it did. */
      taken: string;
      amountOut: string;
      tradingFee: string;
      protocolFee: string;
      referralFee: string;
      nextSqrtPrice: string;
      quoteReserve: string;
    }[];
  }[];
};
