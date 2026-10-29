// The Meteora adapter (spec 10.1): the only place `@solana/web3.js` v1 and Meteora's TypeScript SDKs live, behind a
// narrow interface, because no Meteora SDK has a Kit version. Everything else uses Kit and the clients Codama generates
// from the SDKs' IDLs (`@top-pad/clients`). What crosses the interface is plain data (addresses as strings, amounts as
// bigints), never a web3.js type. The DBC and DAMM v2 curve and quote maths come with "Quick buy and sell through
// server-built swaps", with parity tests against real devnet swaps.

export * from "./configs";

/** The SDK releases the pinned IDLs and the maths come from, so a refresh is a deliberate change (spec 5.1). */
export const SDK_VERSIONS = {
  "@meteora-ag/dynamic-bonding-curve-sdk": "2.0.0",
  "@meteora-ag/cp-amm-sdk": "1.5.1",
  "@meteora-ag/met-lock-sdk": "1.0.1",
} as const;
