// "How this is enforced" (spec 9, screen 6): the counts of bars, appeals and overturned findings, and the keys each
// promise names as who could still change it, Heat's programs' upgrade authorities read from the chain itself.
import { address, createSolanaRpc, getAddressEncoder, getBase58Decoder, getProgramDerivedAddress, type Address as KitAddress } from "@solana/kit";
import type { Context } from "hono";
import { CP_AMM_PROGRAM_ADDRESS } from "@top-pad/clients/damm-v2";
import { DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS } from "@top-pad/clients/dbc";
import { FAIR_OPEN_PROGRAM_ADDRESS } from "@top-pad/clients/fair-open";
import { FEE_PROGRAM_ADDRESS } from "@top-pad/clients/fee";
import { LOCKER_PROGRAM_ADDRESS } from "@top-pad/clients/jupiter-lock";
import type { Enforcement, EnforcedProgram } from "@top-pad/contract";
import { enforcementCounts } from "./bars";
import { cached } from "./board";
import { explorerUrl, type Config } from "./env";
import type { AppEnv } from "./http";

const BPF_UPGRADEABLE_LOADER = address("BPFLoaderUpgradeab1e11111111111111111111111");
/** A program data account: its tag (4 bytes) and slot (8), then the upgrade authority as an `Option<Pubkey>` (1 + 32). */
const AUTHORITY_OFFSET = 12;
/** Upgrade authorities change rarely, and only through a transaction anyone can see: read at most every five minutes. */
const KEYS_CACHE_MS = 5 * 60_000;

/** Who can upgrade a program now: null when it is frozen, undefined when the chain did not answer. */
export async function upgradeAuthorityOf(rpcUrl: string, program: KitAddress, signal: AbortSignal): Promise<string | null | undefined> {
  try {
    const [programData] = await getProgramDerivedAddress({ programAddress: BPF_UPGRADEABLE_LOADER, seeds: [getAddressEncoder().encode(program)] });
    const { value } = await createSolanaRpc(rpcUrl)
      .getAccountInfo(programData, { encoding: "base64", dataSlice: { offset: AUTHORITY_OFFSET, length: 33 } })
      .send({ abortSignal: signal });
    if (!value) return undefined;
    const data = Uint8Array.from(atob(value.data[0]), (c) => c.charCodeAt(0));
    if (data.length < 33) return undefined;
    return data[0] === 0 ? null : getBase58Decoder().decode(data.subarray(1, 33));
  } catch (e) {
    console.warn("reading an upgrade authority failed", program, e);
    return undefined;
  }
}

/** The keys behind the promises, read from the chain where they live there. */
async function chainKeys(cfg: Config): Promise<Enforcement["chain"]> {
  const heat = cfg.heat;
  if (!heat?.keys) return null;
  const at = (a: string) => ({ address: a, explorer: explorerUrl(cfg, "address", a) });
  const signal = AbortSignal.timeout(5_000);
  const programs = await Promise.all(
    (
      [
        ["fee", FEE_PROGRAM_ADDRESS],
        ["fair_open", FAIR_OPEN_PROGRAM_ADDRESS],
      ] as const
    ).map(async ([name, program]): Promise<EnforcedProgram> => {
      const authority = await upgradeAuthorityOf(cfg.rpcUrl, program, signal);
      return {
        name,
        ...at(program),
        read: authority !== undefined,
        upgradeable: authority === undefined ? null : authority !== null,
        authority: authority ? at(authority) : null,
      };
    }),
  );
  return {
    cluster: cfg.cluster,
    programs,
    treasury: at(heat.keys.treasury),
    launchKey: at(heat.keys.keeper),
    dbc: at(DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS),
    dammV2: at(CP_AMM_PROGRAM_ADDRESS),
    jupiterLock: at(LOCKER_PROGRAM_ADDRESS),
  };
}

/** Keys read while the chain failed to answer for some of them. */
class Unread extends Error {
  constructor(readonly keys: Enforcement["chain"]) {
    super("an upgrade authority could not be read");
  }
}

/** `GET /enforcement`. */
export async function getEnforcement(c: Context<AppEnv>) {
  const { cfg, db } = c.var;
  const [counts, chain] = await Promise.all([
    enforcementCounts(db),
    // Keys the chain did not answer for are answered but not kept, so the next visitor reads them again.
    cached(c, `enforcement-keys:v1:${cfg.cluster}`, KEYS_CACHE_MS, async () => {
      const keys = await chainKeys(cfg);
      if (keys?.programs.some((p) => !p.read)) throw new Unread(keys);
      return keys;
    }).catch((e: unknown) => {
      if (e instanceof Unread) return e.keys;
      throw e;
    }),
  ]);
  const body: Enforcement = { ...counts, chain };
  c.header("cache-control", "public, max-age=60");
  return c.json(body);
}
