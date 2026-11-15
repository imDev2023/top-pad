// Both programs run on devnet from verified builds (spec 5.1, 11.2): for each, the verification its upgrade authority
// recorded on chain (otter-verify's PDA: the repository, the commit and the build's arguments) is rebuilt from GitHub by
// `solana-verify verify-from-repo` in its Docker image, and the rebuilt executable's hash must equal the deployed one's.
// Nothing is written: the prompt to record the verification again is declined. Then the commit's program source must be
// what this checkout holds, so the code the suite reads is the code devnet runs. Docker and solana-verify 0.5.2 (in
// ~/.local/share/solana-verify-0.5.2/bin, CLAUDE.md) are needed; about 10 minutes a program with the image cached.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { FAIR_OPEN_PROGRAM_ADDRESS, FEE_PROGRAM_ADDRESS } from "@top-pad/chain";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const bin = join(homedir(), ".local/share/solana-verify-0.5.2/bin");
const solanaVerify = existsSync(join(bin, "solana-verify")) ? join(bin, "solana-verify") : "solana-verify";
const upgradeAuthority = await createKeyPairSignerFromBytes(
  Uint8Array.from(JSON.parse(readFileSync(join(homedir(), ".config/top-pad/devnet/upgrade-authority.json"), "utf8")) as number[]),
);
// The rebuild's RPC only reads the program; the public endpoint serves it, and keeps the Helius key out of the logs.
const url = "https://api.devnet.solana.com";

const PROGRAMS = [
  { name: "fee", id: FEE_PROGRAM_ADDRESS },
  { name: "fair_open", id: FAIR_OPEN_PROGRAM_ADDRESS },
];

const verify = (args: string[]) => execFileSync(solanaVerify, ["-u", url, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** Runs `verify-from-repo`, answering no to its prompt to write the PDA again; its whole output. */
function rebuild(args: string[]): Promise<{ code: number; output: string }> {
  return new Promise((done) => {
    const child = spawn(solanaVerify, ["-u", url, "verify-from-repo", ...args], { stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        process.stdout.write(chunk);
        // The prompt to upload the verification data: decline, since it is on chain already.
        if (/\(y\/n\)|\[y\/N\]|upload|write.*on chain/i.test(chunk.toString())) child.stdin.write("n\n");
      });
    }
    child.on("close", (code) => done({ code: code ?? 1, output }));
  });
}

let failed = false;
for (const program of PROGRAMS) {
  console.log(`\n${program.name} (${program.id})`);
  const onChain = verify(["get-program-hash", program.id]).trim().split("\n").at(-1)!.trim();
  const pda = verify(["get-program-pda", "--program-id", program.id, "--signer", upgradeAuthority.address]);
  const field = (name: string) => new RegExp(`^${name}: (.+)$`, "m").exec(pda)?.[1]?.trim();
  const repo = field("Git Url");
  const commit = field("Commit");
  const args = JSON.parse(field("Args") ?? "[]") as string[];
  if (!repo || !commit) throw new Error(`no verification of ${program.id} by ${upgradeAuthority.address} is recorded on chain:\n${pda}`);
  console.log(`deployed executable hash ${onChain}; verification on chain: ${repo} at ${commit}, ${args.join(" ")}`);

  // The arguments as recorded, the inner quotes of `--cargo-build-sbf-args="..."` taken off for a direct exec.
  const buildArgs = args.map((a) => a.replace(/="(.*)"$/, "=$1"));
  const { code, output } = await rebuild(["--program-id", program.id, "--commit-hash", commit, ...buildArgs, repo]);
  const rebuilt = /Executable Program Hash from repo: ([0-9a-f]{64})/.exec(output)?.[1];
  const deployed = /On-chain Program Hash: ([0-9a-f]{64})/.exec(output)?.[1];
  if (!rebuilt || rebuilt !== onChain || (deployed && deployed !== onChain)) {
    console.log(`FAIL: ${program.name}'s rebuild from ${commit} gave ${rebuilt ?? "no hash"} (exit ${code}), the deployed program ${onChain}`);
    failed = true;
    continue;
  }
  console.log(`PASS: ${program.name} rebuilt from ${commit} is the deployed executable, ${onChain}`);

  // The program's own source at that commit against this checkout: anything but its tests would mean devnet runs code
  // the suite does not read.
  const changed = execFileSync("git", ["diff", "--name-only", commit, "HEAD", "--", `programs/${program.name}`, "Anchor.toml", "Cargo.toml"], { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((f) => f && !f.startsWith(`programs/${program.name}/tests/`) && !(f === `programs/${program.name}/Cargo.toml` && onlyDevDependencies(commit, f)));
  if (changed.length) {
    console.log(`FAIL: ${program.name}'s source changed since ${commit}: ${changed.join(", ")}`);
    failed = true;
  } else {
    console.log(`PASS: ${program.name}'s source in this checkout is the verified commit's, its tests aside`);
  }
}

/** Whether a manifest changed since `commit` only in its dev-dependencies, which the on-chain build never compiles. */
function onlyDevDependencies(commit: string, file: string): boolean {
  const show = (rev: string) => execFileSync("git", ["show", `${rev}:${file}`], { cwd: root, encoding: "utf8" });
  const strip = (toml: string) => toml.replace(/\[dev-dependencies\][\s\S]*?(?=\n\[|$)/, "");
  return strip(show(commit)) === strip(show("HEAD"));
}

process.exit(failed ? 1 : 0);
