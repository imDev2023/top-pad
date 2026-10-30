import { address, getAddressEncoder, getBase58Decoder } from "@solana/kit";
import { POOL_CONFIG_DISCRIMINATOR, VIRTUAL_POOL_DISCRIMINATOR, getPoolConfigDecoder, getPoolConfigSize, getVirtualPoolDecoder, getVirtualPoolSize } from "@top-pad/clients/dbc";
import { describe, expect, it } from "vitest";
import { DBC_LAYOUT, dbcPoolAddress } from "./dbc";
import { WSOL_MINT } from "./index";

const addressBytes = getAddressEncoder();
const some = (n: number) => getBase58Decoder().decode(new Uint8Array(32).fill(n)) as ReturnType<typeof address>;

describe("DBC's account layout", () => {
  // The fee program's `register_coin` reads these offsets from raw bytes (programs/fee, `fee::dbc`); the generated
  // decoders come from DBC's IDL, so they settle where each field really sits.
  it("puts a pool's config, creator and base mint where the fee program reads them", () => {
    const data = new Uint8Array(getVirtualPoolSize());
    data.set(VIRTUAL_POOL_DISCRIMINATOR, 0);
    data.set(addressBytes.encode(some(1)), DBC_LAYOUT.poolConfigOffset);
    data.set(addressBytes.encode(some(2)), DBC_LAYOUT.poolCreatorOffset);
    data.set(addressBytes.encode(some(3)), DBC_LAYOUT.poolBaseMintOffset);
    const pool = getVirtualPoolDecoder().decode(data);
    expect(pool.poolState).toMatchObject({ config: some(1), creator: some(2), baseMint: some(3) });
  });

  it("puts a pool's accrued partner fee and activation point where the fee program's claims read them", () => {
    const data = new Uint8Array(getVirtualPoolSize());
    data.set(VIRTUAL_POOL_DISCRIMINATOR, 0);
    const view = new DataView(data.buffer);
    view.setBigUint64(DBC_LAYOUT.poolPartnerQuoteFeeOffset, 123_456_789n, true);
    view.setBigUint64(DBC_LAYOUT.poolActivationPointOffset, 1_800_000_000n, true);
    const pool = getVirtualPoolDecoder().decode(data);
    expect(pool.poolState).toMatchObject({ partnerQuoteFee: 123_456_789n, activationPoint: 1_800_000_000n, partnerBaseFee: 0n });
  });

  it("puts a config's fee claimer where the fee program reads it", () => {
    const data = new Uint8Array(getPoolConfigSize());
    data.set(POOL_CONFIG_DISCRIMINATOR, 0);
    data.set(addressBytes.encode(some(4)), DBC_LAYOUT.configFeeClaimerOffset);
    expect(getPoolConfigDecoder().decode(data).feeClaimer).toBe(some(4));
  });

  it("puts a config's quote and Graduation Target where the Fair Open program reads them", () => {
    const data = new Uint8Array(getPoolConfigSize());
    data.set(POOL_CONFIG_DISCRIMINATOR, 0);
    data.set(addressBytes.encode(some(5)), DBC_LAYOUT.configQuoteMintOffset);
    new DataView(data.buffer).setBigUint64(DBC_LAYOUT.configMigrationQuoteThresholdOffset, 8_500_000_000n, true);
    expect(getPoolConfigDecoder().decode(data)).toMatchObject({ quoteMint: some(5), migrationQuoteThreshold: 8_500_000_000n });
  });
});

describe("a coin's pool address", () => {
  it("is the one DBC gave a real devnet pool", async () => {
    // Read from devnet on 2026-10-29: the pool's config and base mint, and the config's quote mint.
    const pool = await dbcPoolAddress(
      address("TrdhCoiinGpcKKU8DBBwVp6oqdXYCEBswkUsqGEDfn7"),
      address("6dzeanNVDipih7qBJTUjzQNUjJ5Nuk9yUpjgoigFcz8U"),
      WSOL_MINT,
    );
    expect(pool).toBe("JEG6Q88MqK3k6UMdLQsiJX9JiGotH5jt9ZDuZECqNZ9m");
  });
});
