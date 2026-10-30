// Meteora's Dynamic Bonding Curve as Heat uses it (spec 3): the addresses a pool's creation needs, derived as DBC
// derives them (`deriveDbcPoolAddress` and `deriveMintMetadata` in the SDK, `pool` and `metadata` seeds in the program),
// and the byte offsets the fee program's `register_coin` reads from a pool and a config.
import { getAddressEncoder, getProgramDerivedAddress, getUtf8Encoder, type Address } from "@solana/kit";
import { DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS } from "@top-pad/clients/dbc";

export { DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS };

/** Metaplex's token metadata program, which DBC calls to write a coin's name, ticker and URI. */
export const TOKEN_METADATA_PROGRAM_ADDRESS = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s" as Address;
export const TOKEN_PROGRAM_ADDRESS = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;

/**
 * Where our programs read DBC 0.2.2's zero-copy accounts: the fee program a pool's config, creator, base mint, accrued
 * partner fee and activation point, and a config's fee claimer (`fee::dbc` in `programs/fee`); the Fair Open program a
 * config's quote and Graduation Target (`fair_open::dbc`). Checked against the generated decoders here.
 */
export const DBC_LAYOUT = {
  poolConfigOffset: 72,
  poolCreatorOffset: 104,
  poolBaseMintOffset: 136,
  poolPartnerQuoteFeeOffset: 272,
  poolActivationPointOffset: 296,
  configQuoteMintOffset: 8,
  configFeeClaimerOffset: 40,
  configMigrationQuoteThresholdOffset: 264,
} as const;

const utf8 = getUtf8Encoder();
const addressBytes = getAddressEncoder();

/** The larger and the smaller of two addresses by their bytes, the order DBC's pool seeds put two mints in. */
function ordered(a: Address, b: Address): [Uint8Array, Uint8Array] {
  const x = addressBytes.encode(a) as Uint8Array;
  const y = addressBytes.encode(b) as Uint8Array;
  for (let i = 0; i < 32; i++) {
    if (x[i] !== y[i]) return x[i]! > y[i]! ? [x, y] : [y, x];
  }
  return [x, y];
}

/** A coin's pool: one per config and pair of mints. */
export async function dbcPoolAddress(config: Address, baseMint: Address, quoteMint: Address): Promise<Address> {
  const [larger, smaller] = ordered(baseMint, quoteMint);
  const [pool] = await getProgramDerivedAddress({
    programAddress: DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS,
    seeds: [utf8.encode("pool"), addressBytes.encode(config), larger, smaller],
  });
  return pool;
}

/** The Metaplex metadata account DBC creates for a coin. */
export async function mintMetadataAddress(mint: Address): Promise<Address> {
  const [metadata] = await getProgramDerivedAddress({
    programAddress: TOKEN_METADATA_PROGRAM_ADDRESS,
    seeds: [utf8.encode("metadata"), addressBytes.encode(TOKEN_METADATA_PROGRAM_ADDRESS), addressBytes.encode(mint)],
  });
  return metadata;
}

/** An Anchor program's event authority, the PDA its `emit_cpi!` events are signed by. */
export async function eventAuthorityAddress(program: Address): Promise<Address> {
  const [authority] = await getProgramDerivedAddress({ programAddress: program, seeds: [utf8.encode("__event_authority")] });
  return authority;
}
