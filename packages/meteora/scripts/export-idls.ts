// `pnpm --filter @top-pad/meteora idls`: writes the IDLs embedded in the pinned SDK packages to packages/clients/idl,
// where Codama generates the Kit clients from them. The IDLs come from the MIT SDKs on npm, never from Meteora's
// program repositories (#16).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CpAmmIdl } from "@meteora-ag/cp-amm-sdk";
import { DynamicBondingCurveIdl } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { createLockProgram } from "@meteora-ag/met-lock-sdk";
import { Connection } from "@solana/web3.js";
import { SDK_VERSIONS } from "../src/index";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "..", "clients", "idl");

/** A package's declared licence, and whether it ships the licence's text (met-lock-sdk declares MIT but ships none). */
function licence(pkg: string) {
  const dir = join(here, "..", "node_modules", pkg);
  const { license } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { license: string };
  return { licence: license, licenceText: existsSync(join(dir, "LICENSE")) || existsSync(join(dir, "LICENSE.md")) };
}

// met-lock-sdk does not export its IDL, only a program built from it; building one makes no network call.
const lock = createLockProgram(new Connection("http://127.0.0.1:1")).rawIdl;

const idls = [
  { file: "dbc.json", idl: DynamicBondingCurveIdl, from: "@meteora-ag/dynamic-bonding-curve-sdk" },
  { file: "damm_v2.json", idl: CpAmmIdl, from: "@meteora-ag/cp-amm-sdk" },
  { file: "jupiter_lock.json", idl: lock, from: "@meteora-ag/met-lock-sdk" },
] as const;

const sources: Record<string, unknown> = {};
for (const { file, idl, from } of idls) {
  writeFileSync(join(out, file), `${JSON.stringify(idl, null, 2)}\n`);
  const { address, metadata } = idl as { address: string; metadata: { name: string; version: string } };
  sources[file] = { program: metadata.name, programVersion: metadata.version, address, package: from, packageVersion: SDK_VERSIONS[from], ...licence(from) };
  console.log(`${file}: ${metadata.name} ${metadata.version} (${address}) from ${from}@${SDK_VERSIONS[from]}`);
}
writeFileSync(join(out, "sources.json"), `${JSON.stringify(sources, null, 2)}\n`);
