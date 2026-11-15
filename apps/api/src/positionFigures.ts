// A position's figures from its events (spec 9, the P&L share card): pure arithmetic in raw units, by average cost.
import type { Position } from "@top-pad/contract";

/** One event a position counts, in the order the chain ran them. */
export type PositionEvent =
  | { kind: "buy"; key: bigint; at: Date; coins: bigint; quote: bigint; fee: bigint }
  | { kind: "sell"; key: bigint; at: Date; coins: bigint; quote: bigint; fee: bigint }
  | { kind: "fill"; key: bigint; at: Date; coins: bigint; quote: bigint }
  | { kind: "tax_share"; key: bigint; at: Date; quote: bigint };

export type PositionFigures = Pick<
  Position,
  "bought" | "spent" | "sold" | "received" | "taxShare" | "fees" | "held" | "value" | "costHeld" | "realized" | "unrealized" | "pnl" | "pnlPercent" | "swaps" | "fills"
>;

/** A decimal price string as an integer and the power of ten it is scaled by. */
function scaled(decimal: string): { units: bigint; scale: number } {
  const [whole, fraction = ""] = decimal.split(".");
  return { units: BigInt(`${whole}${fraction}`), scale: fraction.length };
}

/** Coins in raw units at a price in whole quote units per whole coin, as raw quote units, rounded down. */
export function valueAt(coinsRaw: bigint, price: string, coinDecimals: number, quoteDecimals: number): bigint {
  const { units, scale } = scaled(price);
  return (coinsRaw * units * 10n ** BigInt(quoteDecimals)) / (10n ** BigInt(scale) * 10n ** BigInt(coinDecimals));
}

/**
 * The figures of a position from its events, oldest first, by average cost: a buy or a fill adds its coins and its
 * cost; a sell takes its coins off at the average cost of the coins held, and its quote, after fees, is received; a
 * Tax Share is received. Coins sold beyond what the counted events hold (coins the wallet was sent) cost nothing.
 */
export function positionFigures(events: PositionEvent[], price: string, coinDecimals: number, quoteDecimals: number): PositionFigures {
  let bought = 0n;
  let spent = 0n;
  let sold = 0n;
  let received = 0n;
  let taxShare = 0n;
  let fees = 0n;
  let held = 0n;
  let costHeld = 0n;
  let costSold = 0n;
  let swaps = 0;
  let fills = 0;
  for (const e of events) {
    if (e.kind === "buy" || e.kind === "fill") {
      bought += e.coins;
      spent += e.quote;
      held += e.coins;
      costHeld += e.quote;
      if (e.kind === "buy") {
        fees += e.fee;
        swaps++;
      } else fills++;
    } else if (e.kind === "sell") {
      sold += e.coins;
      received += e.quote - e.fee;
      fees += e.fee;
      swaps++;
      const fromHeld = e.coins < held ? e.coins : held;
      const cost = held === 0n ? 0n : (costHeld * fromHeld) / held;
      costSold += cost;
      costHeld -= cost;
      held -= fromHeld;
    } else {
      taxShare += e.quote;
    }
  }
  const value = valueAt(held, price, coinDecimals, quoteDecimals);
  const realized = received + taxShare - costSold;
  const unrealized = value - costHeld;
  const pnl = realized + unrealized;
  // Basis points first, so the percentage keeps two decimals however large the amounts.
  const pnlPercent = spent === 0n ? null : Number((pnl * 10_000n) / spent) / 100;
  const s = (n: bigint) => n.toString();
  return {
    bought: s(bought),
    spent: s(spent),
    sold: s(sold),
    received: s(received),
    taxShare: s(taxShare),
    fees: s(fees),
    held: s(held),
    value: s(value),
    costHeld: s(costHeld),
    realized: s(realized),
    unrealized: s(unrealized),
    pnl: s(pnl),
    pnlPercent,
    swaps,
    fills,
  };
}
