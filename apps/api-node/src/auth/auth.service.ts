import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ProblemException } from '../common/problem/problem.exception';
import { PrismaService } from '../infra/prisma/prisma.service';
import type { AuthSession, TokenPair, UserView } from './auth.types';
import type { LoginDto } from './dto/login.dto';
import type { RegisterDto } from './dto/register.dto';
import { GuestCartService } from './guest-cart.service';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly guestCarts: GuestCartService,
  ) {}

  async register(dto: RegisterDto, cartToken?: string): Promise<AuthSession> {
    const email = normaliseEmail(dto.email);
    const passwordHash = await this.passwords.hash(dto.password);

    let user: UserRow;

    try {
      user = await this.prisma.users.create({
        data: {
          email,
          password_hash: passwordHash,
          full_name: dto.fullName,
          role: 'customer',
        },
        select: USER_SELECT,
      });
    } catch (error) {
      // No pre-flight "is this email taken" query, on purpose: it is a race, and
      // two simultaneous registrations would both pass it. The unique index on
      // lower(email) is the only thing that can actually decide, so the insert is
      // attempted and its rejection is translated.
      //
      // Prisma cannot see that index — it is on an expression — so it is not in
      // schema.prisma and this is the only place the constraint surfaces.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ProblemException('email-already-registered', {
          detail: 'An account with this email address already exists.',
          errors: [{ field: 'email', message: 'already registered' }],
        });
      }
      throw error;
    }

    await this.guestCarts.claimForUser(user.id, cartToken);

    return {
      user: toUserView(user),
      tokens: await this.tokens.issuePair(user.id, user.role),
    };
  }

  /**
   * Signs in, in constant time with respect to whether the email exists.
   *
   * Both branches run one argon2 verification and then produce the *same* problem.
   * Returning early for an unknown email would make this endpoint an oracle: a
   * missing address answers in under a millisecond while a wrong password takes the
   * ~50ms argon2 costs, and that gap is measurable over a handful of requests.
   *
   * The response must be identical too — same status, same type, same detail.
   * Equal timing with distinguishable bodies defends nothing.
   */
  async login(dto: LoginDto, cartToken?: string): Promise<AuthSession> {
    const email = normaliseEmail(dto.email);

    const user = await this.prisma.users.findFirst({
      where: { email },
      select: { ...USER_SELECT, password_hash: true },
    });

    const valid = user
      ? await this.passwords.verify(user.password_hash, dto.password)
      : await this.passwords.verifyWithDummy(dto.password);

    if (!user || !valid) {
      throw invalidCredentials();
    }

    await this.guestCarts.claimForUser(user.id, cartToken);

    return {
      user: toUserView(user),
      tokens: await this.tokens.issuePair(user.id, user.role),
    };
  }

  async refresh(refreshToken: string): Promise<TokenPair> {
    const { pair } = await this.tokens.rotate(refreshToken);
    return pair;
  }

  /**
   * Always succeeds. A client retrying after a dropped connection must not be told
   * off for successfully having no session.
   */
  async logout(options: {
    refreshToken?: string;
    userId?: string;
  }): Promise<void> {
    if (options.refreshToken) {
      await this.tokens.revokeFamilyByToken(options.refreshToken);
      return;
    }

    if (options.userId) {
      await this.tokens.revokeAllForUser(options.userId);
    }
  }

  /**
   * Reads the user from the database rather than trusting the token's claims.
   *
   * This is the one endpoint where that matters: a client calls it on boot to decide
   * whether a stored token is still good, so it has to reflect a role change or a
   * deletion immediately rather than at the end of the access token's 15 minutes.
   */
  async currentUser(userId: string): Promise<UserView> {
    const user = await this.prisma.users.findUnique({
      where: { id: userId },
      select: USER_SELECT,
    });

    if (!user) {
      throw new ProblemException('unauthorized', {
        detail: 'This account no longer exists.',
      });
    }

    return toUserView(user);
  }
}

const USER_SELECT = {
  id: true,
  email: true,
  full_name: true,
  role: true,
  created_at: true,
} as const;

type UserRow = {
  id: string;
  email: string;
  full_name: string;
  role: string;
  created_at: Date;
};

function toUserView(row: UserRow): UserView {
  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    role: row.role,
    // Serialised by JSON.stringify as RFC 3339 with exactly three fractional
    // digits, which is what the contract requires. The column is timestamptz(3),
    // so nothing is rounded on the way out.
    createdAt: row.created_at,
  };
}

/**
 * The single response for every failed sign-in.
 *
 * One function so the two branches in `login` cannot drift apart. If a future edit
 * gave the unknown-email case its own message, the timing work above would be
 * pointless.
 */
function invalidCredentials(): ProblemException {
  return new ProblemException('invalid-credentials', {
    detail: 'The email address or password is incorrect.',
  });
}

/**
 * The contract says email is compared case-insensitively, and the database enforces
 * that with a unique index on `lower(email)`. Normalising on the way in keeps the
 * stored value and the index in agreement, so a plain equality lookup is correct.
 */
function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}
