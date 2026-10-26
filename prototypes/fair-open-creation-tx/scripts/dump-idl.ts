// PROTOTYPE: print the accounts and args of the DBC instructions this prototype uses,
// from the IDL shipped inside the MIT SDK package (@meteora-ag/dynamic-bonding-curve-sdk@2.0.0).
import { DynamicBondingCurveIdl as idl } from "@meteora-ag/dynamic-bonding-curve-sdk";

const want = process.argv.slice(2);
for (const ix of (idl as any).instructions) {
  if (want.length && !want.includes(ix.name)) continue;
  console.log(`\n## ${ix.name}  disc=${JSON.stringify(ix.discriminator)}`);
  ix.accounts.forEach((a: any, i: number) =>
    console.log(`  ${i}. ${a.name}${a.writable ? " [w]" : ""}${a.signer ? " [s]" : ""}${a.address ? " = " + a.address : ""}${a.optional ? " (optional)" : ""}`));
  console.log(`  args: ${JSON.stringify(ix.args)}`);
}
