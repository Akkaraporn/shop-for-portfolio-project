# Problem type registry

Every error this API emits is `application/problem+json` (RFC 9457). `type` is the
field clients switch on, so its value is part of the contract as surely as any
schema — and so is `title`, because a parity test comparing two responses compares
it too.

A Java port that says "Not found" where Node says "Resource not found" fails the
parity suite for a reason that has nothing to do with behaviour. Hence this table.

**Base URI: `https://errors.example.com`** — a constant in both implementations,
never configuration. Made an environment variable, the two backends could be
deployed with different values and every client's error handling would break
against one of them.

Source of truth for the Node side:
[`apps/api-node/src/common/problem/problem-types.ts`](../apps/api-node/src/common/problem/problem-types.ts).

## The registry

| slug | status | title | raised when |
| --- | --- | --- | --- |
| `bad-request` | 400 | Bad request | The request could not be parsed at all — a malformed JSON body. |
| `unauthorized` | 401 | Unauthorized | No credentials, or credentials that are not valid. |
| `invalid-credentials` | 401 | Invalid credentials | Login failed. Identical response and timing whether or not the email exists. |
| `token-reuse-detected` | 401 | Refresh token reuse detected | An already-rotated refresh token was presented, so the whole family is revoked. |
| `forbidden` | 403 | Forbidden | Authenticated, but not allowed. Used where the resource exists and is someone else's. |
| `not-found` | 404 | Resource not found | No such resource, including an unmatched route. |
| `conflict` | 409 | Conflict | Generic state conflict. Also where a Prisma `P2002` unique violation lands. |
| `email-already-registered` | 409 | Email already registered | Registration against an address already in use. |
| `insufficient-stock` | 409 | Insufficient stock | Checkout could not reserve. `errors[]` carries **every** short line. |
| `checkout-in-progress` | 409 | Checkout already in progress | A checkout with this idempotency key is still running. |
| `order-not-cancellable` | 409 | Order cannot be cancelled | Cancelling an order that is already paid. |
| `payment-not-confirmable` | 409 | Payment cannot be confirmed | Confirming against a cancelled or expired order. |
| `invalid-transition` | 409 | Invalid status transition | `errors[]` names the states reachable from the current one. |
| `validation-failed` | 422 | Validation failed | Well-formed request, invalid contents. `errors[]` lists every bad field. |
| `invalid-cursor` | 422 | Invalid cursor | A pagination cursor this API did not issue, or cannot read. |
| `idempotency-key-reused` | 422 | Idempotency key reused with a different request | Same key, different canonical body hash. |
| `internal-error` | 500 | Internal server error | Anything unexpected. Carries `traceId` and nothing diagnostic. |
| `service-unavailable` | 503 | Service unavailable | A required dependency is unreachable. Readiness uses this. |
| `backend-unavailable` | 503 | Backend unavailable | **Emitted by the nginx gateway, not by a backend**, when no backend answers. |

## Rules both implementations follow

**`traceId` is always present**, and always equals the `X-Request-Id` response
header. When the caller supplies that header the value is reused, so one id spans
the gateway, the backend, and the logs.

**`instance` is the request path** as received, including the `/api/v1` prefix.

**A 5xx carries nothing diagnostic.** No stack trace, no exception message, no
Prisma error text, no connection string. Those go to the log, correlated by
`traceId`. An unexpected error's message very often contains a query or a
credential; a fixed `detail` string is the only safe choice. This is asserted in
[`problem.e2e-spec.ts`](../apps/api-node/src/common/problem/problem.e2e-spec.ts).

**`errors[]` is present only when the failure is per-field**, and then it lists
every offending field rather than the first. Field paths use the contract's own
notation: `items[0].quantity`, not `items.0.quantity`.

**An unmapped error becomes `internal-error`.** Guessing a status from an
unfamiliar exception is worse than admitting the case is unhandled: a wrong 4xx
tells a client the request was at fault when it was not.

## Mapping library errors

Both implementations must agree on these, since a duplicate email has to be a 409
on either backend.

| Prisma | Hibernate / JDBC equivalent | becomes |
| --- | --- | --- |
| `P2002` unique violation | `ConstraintViolationException`, SQLState `23505` | 409 `conflict` |
| `P2003` FK violation | SQLState `23503` | 409 `conflict` |
| `P2025` record required but missing | `EmptyResultDataAccessException` | 404 `not-found` |
| `P2000` value too long | SQLState `22001` | 422 `validation-failed` |
| `P2006` invalid value for field | — | 422 `validation-failed` |
| initialisation / connection failure | `CannotCreateTransactionException` | 503 `service-unavailable` |
| anything else | anything else | 500 `internal-error` |

A `CHECK` constraint violation (SQLState `23514`) reaches the application only
when the application has already failed to validate something — the database is
the last line of defence, not the first. It maps to 409, and the occurrence is
worth investigating rather than just handling.

## Adding a type

Add it to `problem-types.ts` and to the table above together, and give the
contract's affected operation an example. Slugs are lowercase kebab-case, and a
slug never changes once a client could be switching on it — add a new one and
leave the old one in place instead.
