import { address, getAddressEncoder, getProgramDerivedAddress } from "@solana/kit";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CLUSTERS, FAIR_OPEN_PROGRAM_ADDRESS, FEE_PROGRAM_ADDRESS } from "@top-pad/chain";
import { Enforcement } from "@top-pad/contract";
import { createTestDatabase } from "@top-pad/db/testing";
import { app } from "./index";
import { ORIGINS, testBindings, testContext } from "./test/fakes";

// "How this is enforced" (spec 9, screen 6, #59): `GET /enforcement` answers the counts with the keys each promise names
// as who could still change it, each program's upgrade authority read from its program data account on chain.

let url: string;
let drop: () => Promise<void>;

beforeAll(async () => {
  ({ url, drop } = await createTestDatabase());
});
afterAll(() => drop());
afterEach(() => vi.unstubAllGlobals());

const { ctx, settle } = testContext();
afterAll(() => settle());

const request = (path: string) => app.request(path, {}, testBindings(url), ctx);
const LOADER = address("BPFLoaderUpgradeab1e11111111111111111111111");
const AUTHORITY = "4hsevQ8dGaJeRLgXa2DhsqAshJTpByHpy9ug15oyj6Sk";
const programData = async (program: string) =>
  (await getProgramDerivedAddress({ programAddress: LOADER, seeds: [getAddressEncoder().encode(address(program))] }))[0] as string;

/** The RPC holding each program data account's authority slice, as `getAccountInfo` asks for it; a program missing from `held` has none. */
function chainHolds(held: Map<string, string | null>) {
  const asked: string[] = [];
  vi.stubGlobal("fetch", async (input: string, init: RequestInit) => {
    expect(input).toBe(ORIGINS.rpc);
    const { id, method, params } = JSON.parse(String(init.body));
    expect(method).toBe("getAccountInfo");
    expect(params[1]).toMatchObject({ encoding: "base64", dataSlice: { offset: 12, length: 33 } });
    asked.push(params[0]);
    if (!held.has(params[0])) return Response.json({ jsonrpc: "2.0", id, result: { context: { slot: 1 }, value: null } });
    const authority = held.get(params[0]);
    const data = new Uint8Array(33);
    if (authority) {
      data[0] = 1;
      data.set(getAddressEncoder().encode(address(authority)), 1);
    }
    const value = { data: [btoa(String.fromCharCode(...data)), "base64"], executable: false, lamports: 1, owner: LOADER, rentEpoch: 0, space: 33 };
    return Response.json({ jsonrpc: "2.0", id, result: { context: { slot: 1 }, value } });
  });
  return asked;
}

describe("GET /enforcement", () => {
  it("names each program's upgrade authority as the chain holds it, a frozen program as nobody's, and Heat's other keys", async () => {
    const [fee, fairOpen] = await Promise.all([programData(FEE_PROGRAM_ADDRESS), programData(FAIR_OPEN_PROGRAM_ADDRESS)]);
    const asked = chainHolds(new Map([[fee, AUTHORITY], [fairOpen, null]]));
    const res = await request("/enforcement");
    expect(res.status).toBe(200);
    const body = Enforcement.parse(await res.json());
    expect(body).toMatchObject({ bars: 0, appeals: 0, overturned: 0 });
    expect(asked.sort()).toEqual([fee, fairOpen].sort());
    const chain = body.chain!;
    expect(chain.programs).toEqual([
      {
        name: "fee",
        address: FEE_PROGRAM_ADDRESS,
        explorer: `https://explorer.solana.com/address/${FEE_PROGRAM_ADDRESS}?cluster=devnet`,
        read: true,
        upgradeable: true,
        authority: { address: AUTHORITY, explorer: `https://explorer.solana.com/address/${AUTHORITY}?cluster=devnet` },
      },
      { name: "fair_open", address: FAIR_OPEN_PROGRAM_ADDRESS, explorer: `https://explorer.solana.com/address/${FAIR_OPEN_PROGRAM_ADDRESS}?cluster=devnet`, read: true, upgradeable: false, authority: null },
    ]);
    expect(chain.treasury.address).toBe(CLUSTERS.devnet!.keys!.treasury);
    expect(chain.launchKey.address).toBe(CLUSTERS.devnet!.keys!.keeper);
    expect(chain.jupiterLock.address).toBe("LocpQgucEQHbqNABEYvBvwoxCPsSbG91A1QaQhQQqjn");
  });

  it("says when the chain did not answer, rather than guessing", async () => {
    vi.stubGlobal("fetch", async () => new Response("down", { status: 503 }));
    const body = Enforcement.parse(await (await request("/enforcement")).json());
    expect(body.chain!.programs.map((p) => [p.name, p.read, p.upgradeable, p.authority])).toEqual([
      ["fee", false, null, null],
      ["fair_open", false, null, null],
    ]);
  });
});
