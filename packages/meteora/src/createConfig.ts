// One of Heat's DBC configs as a `create_config2` instruction (spec 3.2): the generator's parameters for a launch mode,
// a quote and a Graduation Target, with the fee program's `fee_claimer` PDA as fee claimer and leftover receiver. The
// config is a fresh account, so its key signs once and is never needed again: a config can never be changed.
import { getProgramDerivedAddress, getUtf8Encoder, type Address, type Instruction, type TransactionSigner } from "@solana/kit";
import { FEE_CLAIMER_ADDRESS } from "@top-pad/chain";
import { DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS, getCreateConfig2Instruction, getPoolConfigSize } from "@top-pad/clients/dbc";
import { heatConfigParameters, type LaunchMode } from "./configs";

/** The bytes a DBC config account holds, whose rent the payer prepays: asked of the cluster, never hard-coded. */
export const POOL_CONFIG_SIZE = getPoolConfigSize();

export async function heatConfigInstruction(p: {
  mode: LaunchMode;
  quoteMint: Address;
  graduationTarget: bigint;
  config: TransactionSigner;
  payer: TransactionSigner;
}): Promise<Instruction> {
  const [eventAuthority] = await getProgramDerivedAddress({
    programAddress: DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS,
    seeds: [getUtf8Encoder().encode("__event_authority")],
  });
  return getCreateConfig2Instruction({
    config: p.config,
    feeClaimer: FEE_CLAIMER_ADDRESS,
    leftoverReceiver: FEE_CLAIMER_ADDRESS,
    quoteMint: p.quoteMint,
    payer: p.payer,
    eventAuthority,
    program: DYNAMIC_BONDING_CURVE_PROGRAM_ADDRESS,
    configParameters: heatConfigParameters(p.mode, p.graduationTarget),
    transferFeeParameters: null,
  });
}
