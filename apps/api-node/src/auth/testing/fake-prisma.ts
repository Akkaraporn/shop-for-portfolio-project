import { Prisma } from '@prisma/client';

/**
 * An in-memory stand-in for the handful of Prisma operations the auth module uses.
 *
 * This exists because the real flow — register, sign in, rotate, detect reuse —
 * cannot be exercised without persistence, and it is the most important thing in
 * task 2.2. A double models it faithfully enough to test the decisions.
 *
 * What it does model, because the code depends on it:
 *
 * - The unique index on `lower(email)`, rejecting a duplicate with a genuine
 *   `PrismaClientKnownRequestError` carrying `P2002`. Prisma cannot see that index
 *   (it is on an expression), so the constraint only ever surfaces as this error,
 *   and the register path is built around catching it.
 * - `$queryRaw` for the locking read in `rotate`, matching by token hash.
 * - `updateMany` filtered by family, which is how a family is revoked.
 *
 * What it does NOT model, and what therefore stays unverified until a database is
 * available: `FOR UPDATE` row locking, and transaction rollback. `$transaction`
 * here simply runs the callback. So the concurrent-refresh case — two requests
 * presenting the same token at once, where the lock is what forces one of them to
 * be classified as reuse — is not covered by these tests. It needs Postgres.
 */

interface UserRecord {
  id: string;
  email: string;
  password_hash: string;
  full_name: string;
  role: string;
  created_at: Date;
  updated_at: Date;
}

interface RefreshTokenRecord {
  id: string;
  user_id: string;
  family_id: string;
  token_hash: string;
  replaced_by: string | null;
  issued_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
}

interface CartRecord {
  id: string;
  user_id: string | null;
  token_hash: string | null;
  currency: string;
  created_at: Date;
  updated_at: Date;
  expires_at: Date | null;
}

let sequence = 0;
const nextId = (): string => {
  sequence += 1;
  return `01930099-0000-7000-8000-${String(sequence).padStart(12, '0')}`;
};

const uniqueViolation = (target: string[]): Prisma.PrismaClientKnownRequestError =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'fake',
    meta: { target },
  });

/** Applies a `select` map to a record, the way Prisma narrows a result. */
function project<T extends object>(
  record: T,
  select: Record<string, boolean> | undefined,
): Partial<T> {
  if (!select) {
    return { ...record };
  }
  const out: Record<string, unknown> = {};
  for (const [key, wanted] of Object.entries(select)) {
    if (wanted) {
      out[key] = (record as Record<string, unknown>)[key];
    }
  }
  return out as Partial<T>;
}

export class FakePrisma {
  readonly userRows: UserRecord[] = [];
  readonly tokenRows: RefreshTokenRecord[] = [];
  readonly cartRows: CartRecord[] = [];

  reset(): void {
    this.userRows.length = 0;
    this.tokenRows.length = 0;
    this.cartRows.length = 0;
  }

  // --- users ---------------------------------------------------------------
  readonly users = {
    create: async ({
      data,
      select,
    }: {
      data: Omit<UserRecord, 'id' | 'created_at' | 'updated_at'>;
      select?: Record<string, boolean>;
    }) => {
      // The real constraint is on lower(email); the application normalises before
      // writing, so comparing lowercased here is the same test.
      if (
        this.userRows.some(
          (u) => u.email.toLowerCase() === data.email.toLowerCase(),
        )
      ) {
        throw uniqueViolation(['email']);
      }

      const now = new Date();
      const record: UserRecord = {
        id: nextId(),
        created_at: now,
        updated_at: now,
        ...data,
      };
      this.userRows.push(record);
      return project(record, select);
    },

    findFirst: async ({
      where,
      select,
    }: {
      where: { email?: string; user_id?: string };
      select?: Record<string, boolean>;
    }) => {
      const found = this.userRows.find((u) => u.email === where.email);
      return found ? project(found, select) : null;
    },

    findUnique: async ({
      where,
      select,
    }: {
      where: { id: string };
      select?: Record<string, boolean>;
    }) => {
      const found = this.userRows.find((u) => u.id === where.id);
      return found ? project(found, select) : null;
    },
  };

  // --- refresh_tokens ------------------------------------------------------
  readonly refresh_tokens = {
    create: async ({
      data,
      select,
    }: {
      data: {
        user_id: string;
        family_id: string;
        token_hash: string;
        expires_at: Date;
      };
      select?: Record<string, boolean>;
    }) => {
      if (this.tokenRows.some((t) => t.token_hash === data.token_hash)) {
        throw uniqueViolation(['token_hash']);
      }

      const record: RefreshTokenRecord = {
        id: nextId(),
        replaced_by: null,
        issued_at: new Date(),
        revoked_at: null,
        ...data,
      };
      this.tokenRows.push(record);
      return project(record, select);
    },

    findUnique: async ({
      where,
      select,
    }: {
      where: { token_hash: string };
      select?: Record<string, boolean>;
    }) => {
      const found = this.tokenRows.find((t) => t.token_hash === where.token_hash);
      return found ? project(found, select) : null;
    },

    update: async ({
      where,
      data,
    }: {
      where: { id: string };
      data: Partial<RefreshTokenRecord>;
    }) => {
      const found = this.tokenRows.find((t) => t.id === where.id);
      if (!found) {
        throw new Prisma.PrismaClientKnownRequestError('Not found', {
          code: 'P2025',
          clientVersion: 'fake',
        });
      }
      Object.assign(found, data);
      return { ...found };
    },

    updateMany: async ({
      where,
      data,
    }: {
      where: { family_id?: string; user_id?: string; revoked_at?: null };
      data: Partial<RefreshTokenRecord>;
    }) => {
      const matches = this.tokenRows.filter((t) => {
        if (where.family_id !== undefined && t.family_id !== where.family_id) {
          return false;
        }
        if (where.user_id !== undefined && t.user_id !== where.user_id) {
          return false;
        }
        if (where.revoked_at === null && t.revoked_at !== null) {
          return false;
        }
        return true;
      });

      for (const match of matches) {
        Object.assign(match, data);
      }

      return { count: matches.length };
    },
  };

  // --- carts ---------------------------------------------------------------
  readonly carts = {
    findFirst: async ({
      where,
      select,
    }: {
      where: { token_hash?: string; user_id?: string | null };
      select?: Record<string, boolean>;
    }) => {
      const found = this.cartRows.find((c) => {
        if (where.token_hash !== undefined && c.token_hash !== where.token_hash) {
          return false;
        }
        if (where.user_id !== undefined && c.user_id !== where.user_id) {
          return false;
        }
        return true;
      });
      return found ? project(found, select) : null;
    },

    update: async ({
      where,
      data,
    }: {
      where: { id: string };
      data: Partial<CartRecord>;
    }) => {
      const found = this.cartRows.find((c) => c.id === where.id);
      if (!found) {
        throw new Prisma.PrismaClientKnownRequestError('Not found', {
          code: 'P2025',
          clientVersion: 'fake',
        });
      }
      // The partial unique index on carts(user_id).
      if (
        data.user_id &&
        this.cartRows.some((c) => c.id !== found.id && c.user_id === data.user_id)
      ) {
        throw uniqueViolation(['user_id']);
      }
      Object.assign(found, data);
      return { ...found };
    },
  };

  /** Runs the callback directly. No isolation, no rollback, no row locks. */
  async $transaction<T>(callback: (tx: FakePrisma) => Promise<T>): Promise<T> {
    return callback(this);
  }

  /**
   * Handles only the locking read in `TokenService.rotate`:
   * `SELECT ... FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE`.
   *
   * Throws on anything else so a new raw query cannot silently return nothing and
   * make a test pass for the wrong reason.
   */
  async $queryRaw<T = unknown>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T> {
    const sql = strings.join('?');

    if (!/FROM\s+refresh_tokens/i.test(sql) || !/token_hash/i.test(sql)) {
      throw new Error(`FakePrisma.$queryRaw does not model: ${sql.trim()}`);
    }

    const hash = values[0] as string;
    const found = this.tokenRows.filter((t) => t.token_hash === hash);

    return found.map((t) => ({
      id: t.id,
      user_id: t.user_id,
      family_id: t.family_id,
      revoked_at: t.revoked_at,
      expires_at: t.expires_at,
    })) as T;
  }

  /** Present so the health probe can be exercised alongside auth. */
  async isReachable(): Promise<boolean> {
    return true;
  }

  seedCart(cart: Partial<CartRecord> & { token_hash?: string | null }): CartRecord {
    const now = new Date();
    const record: CartRecord = {
      id: nextId(),
      user_id: null,
      token_hash: null,
      currency: 'THB',
      created_at: now,
      updated_at: now,
      expires_at: new Date(now.getTime() + 7 * 24 * 3600 * 1000),
      ...cart,
    };
    this.cartRows.push(record);
    return record;
  }
}
