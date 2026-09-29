# Auth tokens

The contract describes the shape of a token pair. It cannot describe what is
*inside* an access token, how a refresh token is generated, or what happens when
one is replayed — and all three have to match across the two implementations,
because a token issued by either backend must be accepted by the other.

Written during task 2.2 so task 5.4 has a specification rather than TypeScript to
read.

## Access token

A JWT, signed **HS256** with `JWT_SECRET`. The claim set is exactly:

| claim | value |
| --- | --- |
| `sub` | the user's id, a lowercase hyphenated UUID string |
| `role` | `customer` or `admin` |
| `iat` | issued-at, seconds since the epoch |
| `exp` | expiry, seconds since the epoch — `iat + ACCESS_TOKEN_TTL_SECONDS` |

Nothing else. No `jti`, no issuer, no audience: they would be fields both sides
must agree on for no benefit in a single-issuer system, and each one is another
way for the ports to diverge.

**The algorithm is pinned on both sign and verify.** Not left to a library
default, for two reasons: a library changing its default makes every token
unreadable to the other backend, and an explicit allow-list on verify is what
rejects a token claiming `alg: none`. In Java that is
`JWTVerifier` with `Algorithm.HMAC256` and no other algorithm registered.

**Lifetime is 15 minutes** (`ACCESS_TOKEN_TTL_SECONDS=900`).

`expiresIn` in the response body is **seconds**. Not milliseconds, and not an
absolute timestamp. A Java port sending milliseconds makes every client's refresh
timer wrong by a factor of a thousand, and the symptom — sessions that seem to last
forever until they abruptly do not — is very hard to trace back.

Authorisation reads `role` from the token rather than querying the user. The cost
is that a demotion or deletion takes effect only when the access token expires, so
at most 15 minutes. `GET /auth/me` reads the row instead, because a client calls it
on boot to decide whether a stored token is still good and needs the truth.

## Refresh token

**32 bytes from a CSPRNG, rendered base64url** — 43 characters, no padding. Not a
JWT: there is nothing to carry, it is never read by a client, and a random opaque
string cannot be forged even if the signing key leaks.

**Only `sha256(token)` in hex is stored**, in `refresh_tokens.token_hash char(64)`.
The API only ever looks up by hash, so a database leak yields nothing replayable.
SHA-256 rather than argon2 deliberately: the input is 32 bytes of cryptographic
randomness, so there is no low-entropy guess to slow down, and a deliberately slow
hash would add ~50ms to every refresh for nothing.

**Lifetime is 30 days** (`REFRESH_TOKEN_TTL_DAYS=30`).

## Rotation and families

Every refresh **consumes** the token presented and issues a new one. Tokens issued
from the same sign-in share a `family_id`, and each consumed row records
`replaced_by`, so the chain can be walked after an incident.

```
login          -> A                       family F, A live
refresh(A)     -> B    A revoked, A.replaced_by = B,   family F
refresh(B)     -> C    B revoked, B.replaced_by = C,   family F
refresh(A)             A is already revoked
                       => every live token in family F is revoked
                       => 401 token-reuse-detected
                       => C stops working too; the user must sign in again
```

A family per sign-in, not per user: revoking one compromised session must not sign
someone out of their other devices. Logout revokes one family when given a refresh
token, and every family for the user when given only a bearer token.

### Why the victim gets signed out too

Presenting a consumed token means a copy of it exists somewhere it should not. The
holder of that copy might be the attacker or the legitimate user, and there is no
way to tell them apart — so the only safe move is to end every session in the
family. Leaving the newest token working because signing out the real user felt
impolite would leave an attacker with a working session.

### The lock, and the cost of it

The whole rotation is one transaction, and the presented row is read
`SELECT ... FOR UPDATE`. Without that lock two concurrent refreshes with the same
token both read it as live and both mint a replacement, leaving two live tokens in
one family — exactly the state reuse detection exists to make impossible.

**The consequence is real**: a client that fires two refreshes at once — two tabs
waking from sleep together — has the second classified as reuse and loses the
session. That is the intended trade, and it makes serialising refreshes a client
requirement: the frontend keeps a single in-flight refresh promise and every
waiting request awaits it (task 3.2).

Both implementations must lock. A Java port using an optimistic `@Version` column
instead would produce a different outcome under concurrency and fail the
cross-backend test in 4.3.

## Password hashing

**argon2id**, with OWASP's recommended parameters:

| parameter | value |
| --- | --- |
| memory | 19456 KiB |
| iterations | 2 |
| parallelism | 1 |
| salt | 16 random bytes |
| output | 32 bytes |

Stored as a standard PHC string:
`$argon2id$v=19$m=19456,t=2,p=1$<salt-b64>$<tag-b64>`, base64 without padding.

Because PHC carries its own parameters, the two implementations interoperate
without agreeing on anything at *read* time — verified: hashes produced by Node's
`crypto.argon2` are accepted by `@node-rs/argon2`, and Spring Security's
`Argon2PasswordEncoder` reads the same format. It also means these numbers can be
raised later without invalidating a single stored hash.

They must match on *write*, though, and there is a second reason beyond parity: the
three demo accounts in `V2__seed.sql` were hashed with exactly these values. Change
them and `make up-node` opens onto a shop nobody can sign into. `password.service.spec.ts`
reads those hashes out of the migration and verifies them, so that regression fails
a test rather than a demo.

## Login must not leak which emails exist

An unknown email and a wrong password return **the same status, the same problem
type, the same detail** — identical but for `traceId` — and take **the same time**.

The timing half is the part that is easy to get wrong. Returning early when no user
is found answers in microseconds, while a real verification costs the tens of
milliseconds argon2 is designed to cost. That difference is measurable over a
handful of requests and turns login into an oracle for which addresses are
registered. So when no user is found, the submitted password is verified against a
dummy hash computed at startup, and only then does the request fail.

Both halves are required. Equal timing with distinguishable bodies defends nothing,
and identical bodies with a 50ms tell defend nothing either.

## Implementation

- Node: [`apps/api-node/src/auth/`](../apps/api-node/src/auth/)
- Node tests: `auth.e2e-spec.ts` (the flow and the guards),
  `password.service.spec.ts` (parameters and the seed hashes)
- Java: task 5.4

### Not yet verified

The `FOR UPDATE` behaviour under genuine concurrency. The Node suite substitutes
persistence with an in-memory double, which cannot model row locking, so the
concurrent-refresh case is untested. It needs a real Postgres and belongs with the
concurrency tests in task 4.3.
