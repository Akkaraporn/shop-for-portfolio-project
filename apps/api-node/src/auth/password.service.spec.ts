import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ARGON2_PARAMS, PasswordService } from './password.service';

/**
 * The hashing parameters are a cross-implementation contract in two directions.
 *
 * Forwards: Spring Security's `Argon2PasswordEncoder` must be configured with the
 * same numbers, or a password set on one backend cannot be verified by the other.
 *
 * Backwards: the demo accounts in `V2__seed.sql` were hashed with these values, so
 * lowering them is not merely a security regression — it stops three seeded users
 * being able to log in, and `make up-node` opens onto a shop nobody can sign into.
 *
 * The seed hashes are read from the migration itself rather than copied here, so
 * this test fails if someone regenerates them with different parameters.
 */
describe('PasswordService', () => {
  let service: PasswordService;

  beforeAll(async () => {
    service = new PasswordService();
    await service.onModuleInit();
  }, 30_000);

  const SEED_PASSWORD = 'DemoPass123!';

  describe('parameters', () => {
    it('are OWASP argon2id, and pinned', () => {
      expect(ARGON2_PARAMS.memoryCost).toBe(19456);
      expect(ARGON2_PARAMS.timeCost).toBe(2);
      expect(ARGON2_PARAMS.parallelism).toBe(1);
    });

    it('are carried in the hash itself, so they can be raised without a migration', async () => {
      const phc = await service.hash('a-long-enough-password');

      // A PHC string is self-describing: the verifier reads the parameters from it
      // rather than from configuration, which is what lets these numbers go up
      // later without invalidating a single stored hash.
      expect(phc).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
      expect(phc.split('$')).toHaveLength(6);
    });
  });

  describe('hashing', () => {
    it('round-trips', async () => {
      const phc = await service.hash(SEED_PASSWORD);
      expect(await service.verify(phc, SEED_PASSWORD)).toBe(true);
    });

    it('rejects a wrong password', async () => {
      const phc = await service.hash(SEED_PASSWORD);
      expect(await service.verify(phc, 'WrongPass123!')).toBe(false);
    });

    it('salts, so the same password hashes differently every time', async () => {
      const first = await service.hash(SEED_PASSWORD);
      const second = await service.hash(SEED_PASSWORD);

      expect(first).not.toBe(second);
      // Both still verify: the salt lives in the string.
      expect(await service.verify(first, SEED_PASSWORD)).toBe(true);
      expect(await service.verify(second, SEED_PASSWORD)).toBe(true);
    });

    it('treats an unparseable stored hash as a failed login, not a crash', async () => {
      // A row written by hand, or predating a format change. A 500 here would turn
      // one bad row into an outage for that user with no way to diagnose it.
      expect(await service.verify('not-a-phc-string', SEED_PASSWORD)).toBe(false);
      expect(await service.verify('', SEED_PASSWORD)).toBe(false);
    });
  });

  describe('the seeded demo accounts', () => {
    const seedSql = readFileSync(
      join(__dirname, '../../../../migrations/V2__seed.sql'),
      'utf8',
    );

    const seedHashes = [...seedSql.matchAll(/'(\$argon2id\$[^']+)'/g)].map(
      (match) => match[1],
    );

    it('has three hashes in the migration', () => {
      expect(seedHashes).toHaveLength(3);
    });

    it.each([0, 1, 2])('seed hash %i accepts the documented demo password', async (index) => {
      expect(await service.verify(seedHashes[index], SEED_PASSWORD)).toBe(true);
    });

    it.each([0, 1, 2])('seed hash %i rejects a wrong password', async (index) => {
      expect(await service.verify(seedHashes[index], 'NotThePassword1!')).toBe(
        false,
      );
    });

    it('uses exactly the parameters this service is configured with', () => {
      for (const phc of seedHashes) {
        expect(phc).toContain(
          `m=${ARGON2_PARAMS.memoryCost},t=${ARGON2_PARAMS.timeCost},p=${ARGON2_PARAMS.parallelism}`,
        );
      }
    });
  });

  describe('verifyWithDummy', () => {
    it('always reports failure', async () => {
      expect(await service.verifyWithDummy('anything')).toBe(false);
    });

    it('costs roughly what a real verification costs', async () => {
      const phc = await service.hash(SEED_PASSWORD);

      const time = async (run: () => Promise<unknown>): Promise<number> => {
        const started = process.hrtime.bigint();
        await run();
        return Number(process.hrtime.bigint() - started) / 1_000_000;
      };

      const real = await time(() => service.verify(phc, 'WrongPass123!'));
      const dummy = await time(() => service.verifyWithDummy('WrongPass123!'));

      // The point is that the dummy path is not free. An early return would take
      // microseconds while argon2 with these parameters takes tens of
      // milliseconds, so a generous ratio still catches the regression that
      // matters without being flaky on a loaded machine.
      expect(dummy).toBeGreaterThan(real / 4);
      expect(dummy).toBeLessThan(real * 4);
    }, 30_000);
  });
});
