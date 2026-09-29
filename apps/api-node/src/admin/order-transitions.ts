import { ProblemException } from '../common/problem/problem.exception';
import type { OrderStatus } from '../orders/order.types';

/**
 * The only moves an admin may make, forward-only: paid → fulfilled → completed.
 *
 * Everything before `paid` belongs to the shopper and the payment provider, and
 * cancellation is its own endpoint that is valid only before payment. Keeping this
 * table here and nowhere else — not in the web app, which renders its buttons from
 * the 409 below — is the point: one copy of the state machine per backend, zero in
 * the frontend.
 */
export const ADMIN_TRANSITIONS: Readonly<
  Record<OrderStatus, readonly OrderStatus[]>
> = {
  pending_payment: [],
  paid: ['fulfilled'],
  fulfilled: ['completed'],
  completed: [],
  cancelled: [],
  expired: [],
  payment_failed: [],
};

export function allowedNextStatuses(from: OrderStatus): readonly OrderStatus[] {
  return ADMIN_TRANSITIONS[from] ?? [];
}

/**
 * Throws `invalid-transition` unless `from → to` is in the table.
 *
 * `errors` carries one entry per reachable state, the state itself as the message,
 * so a client can render its next buttons without a copy of this table. Empty when
 * the order can go nowhere. Moving to the status it already has is also a 409: it is
 * not a transition, and a double-click then shows the admin where the order now is.
 */
export function assertTransition(from: OrderStatus, to: OrderStatus): void {
  const allowed = allowedNextStatuses(from);
  if (allowed.includes(to)) return;

  throw new ProblemException('invalid-transition', {
    detail:
      allowed.length > 0
        ? `Cannot move from '${from}' to '${to}'. Allowed next states: ${allowed.join(', ')}.`
        : `Cannot move from '${from}' to '${to}'. An order in '${from}' has no further states.`,
    errors: allowed.map((state) => ({ field: 'status', message: state })),
  });
}
