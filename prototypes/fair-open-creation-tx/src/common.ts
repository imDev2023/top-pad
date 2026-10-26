// PROTOTYPE, throwaway (ticket #31). Shared helpers for the devnet scripts.
// Keys live outside the repo (KEYS_DIR); only public addresses go into state.json.
import {
  Connection, Keypair, PublicKey, Transaction, VersionedTransaction, TransactionMessage,
  TransactionInstruction, AddressLookupTableAccount, SYSVAR_INSTRUCTIONS_PUBKEY, ComputeBudgetProgram,
} from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";
import { BorshCoder } from "@coral-xyz/anchor";
import {
  DynamicBondingCurveIdl, createDbcProgram, deriveDbcPoolAddress, deriveDbcTokenVaultAddress,
  deriveDbcEventAuthority, DYNAMIC_BONDING_CURVE_PROGRAM_ID,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import BN from "bn.js";
import bs58 from "bs58";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
export const RPC = process.env.RPC_URL ?? "https://api.devnet.solana.com";
export const connection = new Connection(RPC, "confirmed");
export const program = createDbcProgram(connection, "confirmed");
export const DBC = new PublicKey(DYNAMIC_BONDING_CURVE_PROGRAM_ID);
export const POOL_AUTHORITY = new PublicKey("FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM");
export const EVENT_AUTHORITY = deriveDbcEventAuthority();
export const coder = new BorshCoder(DynamicBondingCurveIdl as any);
export const QUOTE = NATIVE_MINT;
export { BN, NATIVE_MINT, SYSVAR_INSTRUCTIONS_PUBKEY, ComputeBudgetProgram };

const KEYS_DIR = process.env.KEYS_DIR ?? path.join(process.env.TMPDIR ?? "/tmp", "top-pad-fair-open-keys");
mkdirSync(KEYS_DIR, { recursive: true });

export function loadDefaultWallet(): Keypair {
  const raw = JSON.parse(readFileSync(path.join(homedir(), ".config/solana/id.json"), "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

/** A named throwaway keypair, created on first use and kept in KEYS_DIR. */
export function key(name: string): Keypair {
  const file = path.join(KEYS_DIR, `${name}.json`);
  if (!existsSync(file)) writeFileSync(file, JSON.stringify(Array.from(Keypair.generate().secretKey)));
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(file, "utf8"))));
}

const STATE = path.join(ROOT, "state.json");
export function readState(): Record<string, any> {
  return existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
}
export function writeState(patch: Record<string, any>) {
  writeFileSync(STATE, JSON.stringify({ ...readState(), ...patch }, null, 2) + "\n");
}

export const explorer = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;

export function poolAccounts(config: PublicKey, baseMint: PublicKey) {
  const pool = deriveDbcPoolAddress(QUOTE, baseMint, config);
  return {
    pool,
    baseVault: deriveDbcTokenVaultAddress(pool, baseMint),
    quoteVault: deriveDbcTokenVaultAddress(pool, QUOTE),
  };
}

/** Build a DBC swap2 buy (quote -> base) with explicit token accounts and authority (`payer`). */
export async function swap2BuyIx(p: {
  config: PublicKey; baseMint: PublicKey; inputTokenAccount: PublicKey; outputTokenAccount: PublicKey;
  authority: PublicKey; amountIn: BN; minOut: BN; mode?: 0 | 1 | 2;
}): Promise<TransactionInstruction> {
  const { pool, baseVault, quoteVault } = poolAccounts(p.config, p.baseMint);
  return program.methods
    .swap2({ amount0: p.amountIn, amount1: p.minOut, swapMode: p.mode ?? 0 })
    .accountsPartial({
      poolAuthority: POOL_AUTHORITY, config: p.config, pool,
      inputTokenAccount: p.inputTokenAccount, outputTokenAccount: p.outputTokenAccount,
      baseVault, quoteVault, baseMint: p.baseMint, quoteMint: QUOTE, payer: p.authority,
      tokenBaseProgram: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
      tokenQuoteProgram: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
      referralTokenAccount: null,
    })
    .remainingAccounts([{ pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false }])
    .instruction();
}

export function v0(payer: PublicKey, ixs: TransactionInstruction[], blockhash: string, alts: AddressLookupTableAccount[] = []) {
  return new VersionedTransaction(
    new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message(alts),
  );
}

/** Serialized size of a transaction, whether or not every signature is present yet. */
export function txSize(tx: VersionedTransaction | Transaction): number {
  if (tx instanceof VersionedTransaction) return tx.serialize().length;
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length;
}

/** Decode DBC event-CPI payloads from inner instructions (simulation or confirmed tx). */
export function decodeDbcEvents(
  accountKeys: PublicKey[],
  inner: { instructions: { programIdIndex?: number; programId?: string; data?: string }[] }[] | null | undefined,
  dataEncoding: "base58" | "base64",
) {
  const out: { name: string; data: any }[] = [];
  for (const group of inner ?? []) {
    for (const ix of group.instructions) {
      // simulation returns parsed instructions ({ programId }); getTransaction returns compiled ones ({ programIdIndex })
      const pid = ix.programId ? new PublicKey(ix.programId) : accountKeys[ix.programIdIndex ?? -1];
      if (!pid?.equals(DBC) || !ix.data) continue;
      const bytes = dataEncoding === "base58"
        ? Buffer.from(bs58.decode(ix.data))
        : Buffer.from(ix.data, "base64");
      if (bytes.length < 16) continue;
      const ev = coder.events.decode(bytes.subarray(8).toString("base64"));
      if (ev) out.push(ev);
    }
  }
  return out;
}

export function lamportsToSol(l: BN | number | bigint): string {
  return (Number(l.toString()) / 1e9).toFixed(9);
}

export function feePct(fee: BN, amountIn: BN): string {
  return ((Number(fee.toString()) / Number(amountIn.toString())) * 100).toFixed(3) + "%";
}

export { ComputeBudgetProgram as CB };
