/**
 * The arithmetic every stock movement shares, kept pure so it can be tested on its
 * own and ported to Java line for line.
 *
 *   on hand   — physical units in the warehouse
 *   reserved  — units promised to orders that have not settled
 *   available — on hand minus reserved: what a new checkout may take
 *
 * Invariant, enforced by a CHECK in the schema as well: 0 <= reserved <= on hand.
 */
export interface StockLevels {
  onHand: number;
  reserved: number;
}

export type StockOutcome =
  { ok: true; levels: StockLevels } | { ok: false; reason: string };

function checked(levels: StockLevels, reason: string): StockOutcome {
  return levels.reserved >= 0 && levels.reserved <= levels.onHand
    ? { ok: true, levels }
    : { ok: false, reason };
}

export function available(levels: StockLevels): number {
  return levels.onHand - levels.reserved;
}

/** Checkout: promise units without moving them. */
export function reserve(levels: StockLevels, quantity: number): StockOutcome {
  return checked(
    { onHand: levels.onHand, reserved: levels.reserved + quantity },
    `only ${available(levels)} available`,
  );
}

/** Payment settled: the promised units leave the warehouse. Both columns move. */
export function commit(levels: StockLevels, quantity: number): StockOutcome {
  return checked(
    { onHand: levels.onHand - quantity, reserved: levels.reserved - quantity },
    `cannot commit ${quantity}: only ${levels.reserved} reserved`,
  );
}

/** Cancelled or expired: the promise is withdrawn. On hand is untouched. */
export function release(levels: StockLevels, quantity: number): StockOutcome {
  return checked(
    { onHand: levels.onHand, reserved: levels.reserved - quantity },
    `cannot release ${quantity}: only ${levels.reserved} reserved`,
  );
}

/**
 * An admin's signed adjustment. Refused when it would leave fewer units on hand than
 * are already promised — that would be the database selling goods it does not have.
 */
export function adjust(levels: StockLevels, delta: number): StockOutcome {
  return checked(
    { onHand: levels.onHand + delta, reserved: levels.reserved },
    `would leave ${levels.onHand + delta} on hand with ${levels.reserved} reserved`,
  );
}
