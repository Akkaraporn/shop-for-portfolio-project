import { ProblemException } from '../common/problem/problem.exception';
import type { OrderStatus } from '../orders/order.types';
import { ADMIN_TRANSITIONS, assertTransition } from './order-transitions';

const ALL: OrderStatus[] = [
  'pending_payment',
  'paid',
  'fulfilled',
  'completed',
  'cancelled',
  'expired',
  'payment_failed',
];

const LEGAL = new Set(['paid>fulfilled', 'fulfilled>completed']);

function attempt(
  from: OrderStatus,
  to: OrderStatus,
): ProblemException | undefined {
  try {
    assertTransition(from, to);
    return undefined;
  } catch (error) {
    return error as ProblemException;
  }
}

describe('admin order transitions', () => {
  // Every pair, legal and illegal: 49 cases. Java ports this table as it stands.
  for (const from of ALL) {
    for (const to of ALL) {
      const legal = LEGAL.has(`${from}>${to}`);
      it(`${from} → ${to} is ${legal ? 'allowed' : 'a 409'}`, () => {
        const error = attempt(from, to);
        if (legal) {
          expect(error).toBeUndefined();
        } else {
          expect(error).toBeInstanceOf(ProblemException);
          expect(error?.slug).toBe('invalid-transition');
        }
      });
    }
  }

  it('names the reachable states in errors, one per entry', () => {
    const error = attempt('paid', 'completed');
    expect(error?.errors).toEqual([{ field: 'status', message: 'fulfilled' }]);
  });

  it('returns an empty errors array when the order can go nowhere', () => {
    expect(attempt('completed', 'fulfilled')?.errors).toEqual([]);
    expect(attempt('cancelled', 'paid')?.errors).toEqual([]);
  });

  it('never moves backwards', () => {
    for (const [from, targets] of Object.entries(ADMIN_TRANSITIONS)) {
      for (const to of targets) {
        expect(ALL.indexOf(to)).toBeGreaterThan(
          ALL.indexOf(from as OrderStatus),
        );
      }
    }
  });
});
