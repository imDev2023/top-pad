// What a launch's block says about it: the coin, its Creator wallet, and every buy of the coin in the creation slot
// after the creation, with its place in the block and its signers. Read from one `getBlock` with account details, so
// positions come from the block itself rather than from any one buyer's history.

type TokenBalance = { accountIndex: number; mint: string; owner?: string; programId?: string; uiTokenAmount: { amount: string } };

/** A transaction as `getBlock` answers with `transactionDetails: "accounts"`. */
export type BlockTransaction = {
  meta: { err: unknown; preTokenBalances?: TokenBalance[] | null; postTokenBalances?: TokenBalance[] | null } | null;
  transaction: { accountKeys: { pubkey: string; signer: boolean }[]; signatures: string[] };
};

export type SlotBuy = {
  signature: string;
  blockIndex: number;
  /** The wallet whose coins went up. */
  trader: string;
  /** The transaction's signers, the fee payer first. */
  signers: string[];
  /** Raw units of the coin it got. */
  baseAmount: string;
};

export type LaunchBlock = {
  mint: string;
  /** The creation's fee payer: the wallet that made and paid for the launch, Bitquery's "dev". */
  creator: string;
  /** The bonding curve: the account that held the coin's unsold supply after the creation. */
  curve: string;
  tokenProgram: string;
  buys: SlotBuy[];
};

/** Each owner's balance of `mint` before and after the transaction, in raw units. */
function balancesOf(tx: BlockTransaction, mint: string): Map<string, { pre: bigint; post: bigint }> {
  const keys = tx.transaction.accountKeys;
  const byAccount = new Map<number, { owner: string; pre: bigint; post: bigint }>();
  for (const [field, list] of [
    ["pre", tx.meta?.preTokenBalances],
    ["post", tx.meta?.postTokenBalances],
  ] as const) {
    for (const b of list ?? []) {
      if (b.mint !== mint) continue;
      const owner = b.owner ?? keys[b.accountIndex]?.pubkey;
      if (!owner) continue;
      const row = byAccount.get(b.accountIndex) ?? { owner, pre: 0n, post: 0n };
      row[field] = BigInt(b.uiTokenAmount.amount);
      byAccount.set(b.accountIndex, row);
    }
  }
  const byOwner = new Map<string, { pre: bigint; post: bigint }>();
  for (const { owner, pre, post } of byAccount.values()) {
    const o = byOwner.get(owner) ?? { pre: 0n, post: 0n };
    byOwner.set(owner, { pre: o.pre + pre, post: o.post + post });
  }
  return byOwner;
}

/**
 * The launch whose creation is `signature` at `blockIndex` in `transactions`, or the reason it is not one: a coin is a
 * signer of its own creation and a mint in its token balances. A buy is a later transaction in which the bonding curve's
 * balance of the coin fell and a wallet's rose.
 */
export function launchFromBlock(transactions: readonly BlockTransaction[], signature: string, blockIndex: number): LaunchBlock | { skipped: string } {
  const creation = transactions[blockIndex];
  if (!creation || creation.transaction.signatures[0] !== signature) return { skipped: `the block holds another transaction at index ${blockIndex}` };
  if (!creation.meta || creation.meta.err) return { skipped: "the creation failed" };
  const keys = creation.transaction.accountKeys;
  const creator = keys[0]!.pubkey;
  const minted = new Map((creation.meta.postTokenBalances ?? []).map((b) => [b.mint, b.programId]));
  const mintKey = keys.find((k, i) => i > 0 && k.signer && minted.has(k.pubkey));
  if (!mintKey) return { skipped: "no coin signed its creation" };
  const mint = mintKey.pubkey;
  const tokenProgram = minted.get(mint);
  if (!tokenProgram) return { skipped: "the coin's token program is not named" };
  const held = [...balancesOf(creation, mint)].sort((a, b) => (b[1].post > a[1].post ? 1 : b[1].post < a[1].post ? -1 : 0));
  const curve = held[0]?.[0];
  if (!curve) return { skipped: "nothing held the coin after its creation" };

  const buys: SlotBuy[] = [];
  transactions.forEach((tx, index) => {
    if (index <= blockIndex || !tx.meta || tx.meta.err) return;
    const balances = balancesOf(tx, mint);
    const fromCurve = balances.get(curve);
    if (!fromCurve || fromCurve.post >= fromCurve.pre) return;
    const signers = tx.transaction.accountKeys.filter((k) => k.signer).map((k) => k.pubkey);
    for (const [owner, { pre, post }] of balances) {
      if (owner === curve || post <= pre) continue;
      buys.push({ signature: tx.transaction.signatures[0]!, blockIndex: index, trader: owner, signers, baseAmount: (post - pre).toString() });
    }
  });
  return { mint, creator, curve, tokenProgram, buys };
}
