import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import jwt from 'jsonwebtoken';
import type { Logger } from 'pino';

import { LOGGER } from '../common/logging/logger.module';
import { ProblemException } from '../common/problem/problem.exception';
import { ENV, type Env } from '../config/config.module';
import { PrismaService } from '../infra/prisma/prisma.service';
import type { JwtClaims, TokenPair } from './auth.types';

/** One row of the locking query in `rotate`. */
interface LockedToken {
  id: string;
  user_id: string;
  family_id: string;
  revoked_at: Date | null;
  expires_at: Date;
}

/**
 * Access and refresh tokens.
 *
 * Refresh tokens are 32 random bytes rendered base64url, and only their SHA-256
 * hash is stored. A database leak therefore yields nothing usable — the tokens in
 * it cannot be replayed, because the column holds a hash and the API only ever
 * looks up by hash.
 *
 * Rotation with reuse detection is the part worth reading. Every refresh consumes
 * the token presented and issues a new one in the same family. Presenting a token
 * that has already been consumed means a copy of it exists somewhere it should not,
 * so the entire family is revoked and everybody holding any token in it is signed
 * out — the legitimate user included. That is the correct outcome: the alternative
 * is leaving an attacker with a working session because signing out the victim felt
 * impolite.
 */
@Injectable()
export class TokenService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Signs an access token.
   *
   * The claim set is deliberately minimal and is a parity surface: Spring Security
   * must emit and accept exactly `sub`, `role`, `iat`, `exp`, signed HS256. See
   * docs/auth-tokens.md.
   */
  signAccessToken(userId: string, role: string): string {
    return jwt.sign({ sub: userId, role }, this.env.JWT_SECRET, {
      // Pinned explicitly, not left to the library default. Two reasons: a future
      // version changing its default would make every token unreadable to the
      // Java side, and an explicit allow-list on verify is what stops a token
      // claiming `alg: none` from being accepted.
      algorithm: 'HS256',
      expiresIn: this.env.ACCESS_TOKEN_TTL_SECONDS,
    });
  }

  /** Returns the claims, or null for any token that is not currently valid. */
  verifyAccessToken(token: string): JwtClaims | null {
    try {
      const claims = jwt.verify(token, this.env.JWT_SECRET, {
        algorithms: ['HS256'],
      }) as JwtClaims;
      // A token with no subject is structurally valid and semantically useless.
      return typeof claims.sub === 'string' && claims.sub.length > 0
        ? claims
        : null;
    } catch {
      // Expired, wrong signature, malformed — all the same to a caller, and
      // distinguishing them in the response would leak whether a secret is right.
      return null;
    }
  }

  /**
   * Issues a fresh pair, starting a new token family.
   *
   * Called on register and login. A family per sign-in means revoking one
   * compromised session does not sign the user out of their other devices.
   */
  async issuePair(userId: string, role: string): Promise<TokenPair> {
    const refreshToken = await this.mintRefreshToken(userId, randomUUID());

    return {
      accessToken: this.signAccessToken(userId, role),
      refreshToken,
      tokenType: 'Bearer',
      // Seconds. Not milliseconds, and not an absolute timestamp — the Java side
      // must send the same unit or every client's refresh timer is wrong by 1000x.
      expiresIn: this.env.ACCESS_TOKEN_TTL_SECONDS,
    };
  }

  /**
   * Consumes a refresh token and issues its replacement.
   *
   * The whole operation is one transaction with the presented row locked
   * `FOR UPDATE`. Without the lock, two concurrent refreshes with the same token
   * both read it as valid and both mint a replacement, leaving two live tokens in
   * one family — which is exactly the state reuse detection exists to make
   * impossible.
   *
   * A consequence worth knowing: a client that fires two refreshes at once (two
   * tabs waking together) has the second one classified as reuse, and the family is
   * revoked. That is a real cost, and it is the intended trade — a client must
   * serialise its own refreshes, which the frontend does with a single in-flight
   * promise (task 3.2).
   */
  async rotate(presentedToken: string): Promise<{ userId: string; pair: TokenPair }> {
    const presentedHash = hashToken(presentedToken);

    const outcome = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<LockedToken[]>`
        SELECT id, user_id, family_id, revoked_at, expires_at
        FROM refresh_tokens
        WHERE token_hash = ${presentedHash}
        FOR UPDATE
      `;

      const token = rows[0];

      // No such token. Forged, or from a family already cleaned up. Nothing to
      // revoke and nothing to tell the client beyond "log in again".
      if (!token) {
        throw new ProblemException('unauthorized', {
          detail: 'The refresh token is not valid.',
        });
      }

      if (token.revoked_at !== null) {
        // Already consumed. Someone has a copy. Revoke everything in the family,
        // including tokens issued after this one.
        const revoked = await tx.refresh_tokens.updateMany({
          where: { family_id: token.family_id, revoked_at: null },
          data: { revoked_at: new Date() },
        });

        return {
          kind: 'reuse' as const,
          userId: token.user_id,
          familyId: token.family_id,
          revokedCount: revoked.count,
        };
      }

      if (token.expires_at.getTime() <= Date.now()) {
        await tx.refresh_tokens.update({
          where: { id: token.id },
          data: { revoked_at: new Date() },
        });
        throw new ProblemException('unauthorized', {
          detail: 'The refresh token has expired. Sign in again.',
        });
      }

      const user = await tx.users.findUnique({
        where: { id: token.user_id },
        select: { id: true, role: true },
      });

      // The token outlived its user. Cascade delete should make this unreachable;
      // treating it as invalid rather than crashing costs nothing.
      if (!user) {
        throw new ProblemException('unauthorized', {
          detail: 'The refresh token is not valid.',
        });
      }

      const replacement = randomBytes(32).toString('base64url');
      const created = await tx.refresh_tokens.create({
        data: {
          user_id: user.id,
          family_id: token.family_id,
          token_hash: hashToken(replacement),
          expires_at: this.refreshExpiry(),
        },
        select: { id: true },
      });

      // Consume the presented token and record what replaced it, so the chain can
      // be walked when investigating an incident.
      await tx.refresh_tokens.update({
        where: { id: token.id },
        data: { revoked_at: new Date(), replaced_by: created.id },
      });

      return {
        kind: 'rotated' as const,
        userId: user.id,
        role: user.role,
        refreshToken: replacement,
      };
    });

    if (outcome.kind === 'reuse') {
      // Worth a log line at warn: this is either a stolen token or a client that
      // does not serialise its refreshes, and both need looking at.
      this.logger.warn(
        {
          userId: outcome.userId,
          familyId: outcome.familyId,
          revokedCount: outcome.revokedCount,
        },
        'refresh token reuse detected, family revoked',
      );
      throw new ProblemException('token-reuse-detected', {
        detail:
          'This refresh token was already used. Every session in its family has been revoked. Sign in again.',
      });
    }

    return {
      userId: outcome.userId,
      pair: {
        accessToken: this.signAccessToken(outcome.userId, outcome.role),
        refreshToken: outcome.refreshToken,
        tokenType: 'Bearer',
        expiresIn: this.env.ACCESS_TOKEN_TTL_SECONDS,
      },
    };
  }

  /**
   * Revokes the family a token belongs to. Used by logout.
   *
   * Silent about a token it does not recognise: logout is idempotent, and telling
   * a caller whether a token existed would make it an oracle.
   */
  async revokeFamilyByToken(presentedToken: string): Promise<void> {
    const token = await this.prisma.refresh_tokens.findUnique({
      where: { token_hash: hashToken(presentedToken) },
      select: { family_id: true },
    });

    if (!token) {
      return;
    }

    await this.prisma.refresh_tokens.updateMany({
      where: { family_id: token.family_id, revoked_at: null },
      data: { revoked_at: new Date() },
    });
  }

  /** Revokes every live token for a user. Used by logout when only a bearer is sent. */
  async revokeAllForUser(userId: string): Promise<void> {
    await this.prisma.refresh_tokens.updateMany({
      where: { user_id: userId, revoked_at: null },
      data: { revoked_at: new Date() },
    });
  }

  private async mintRefreshToken(userId: string, familyId: string): Promise<string> {
    const token = randomBytes(32).toString('base64url');

    await this.prisma.refresh_tokens.create({
      data: {
        user_id: userId,
        family_id: familyId,
        token_hash: hashToken(token),
        expires_at: this.refreshExpiry(),
      },
    });

    return token;
  }

  private refreshExpiry(): Date {
    return new Date(
      Date.now() + this.env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
    );
  }
}

/**
 * SHA-256 hex, matching the `char(64)` column.
 *
 * Not a password hash, and deliberately not argon2: the input is 32 bytes of
 * cryptographic randomness, so there is no low-entropy guess to slow down, and a
 * deliberately slow hash here would add ~50ms to every refresh for nothing.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
