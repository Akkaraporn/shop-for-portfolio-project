import { Injectable, OnModuleInit } from '@nestjs/common';
import { Algorithm, hash, verify } from '@node-rs/argon2';

/**
 * Password hashing, and the timing defence around it.
 *
 * Parameters are OWASP's argon2id recommendation and are part of the
 * cross-implementation contract: Spring Security's `Argon2PasswordEncoder` must be
 * configured with the same numbers, or hashes written by one backend cannot be
 * verified by the other. They are also what the seed data in `V2__seed.sql` was
 * generated with — change them and the demo accounts stop being able to log in.
 *
 * The output is a standard PHC string (`$argon2id$v=19$m=...,t=...,p=...$salt$tag`),
 * which carries its own parameters. That is what makes the two implementations
 * interoperable without agreeing on anything at read time, and what allows these
 * numbers to be raised later without invalidating existing hashes.
 */
export const ARGON2_PARAMS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19456, // KiB
  timeCost: 2,
  parallelism: 1,
} as const;

@Injectable()
export class PasswordService implements OnModuleInit {
  /**
   * A hash of a value nobody knows, verified against when the email does not
   * exist. See `verifyWithDummy`.
   */
  private dummyHash!: string;

  async onModuleInit(): Promise<void> {
    // Computed once at startup rather than per request, and from random input so
    // there is no hardcoded hash in the source for anyone to recognise.
    this.dummyHash = await hash(
      Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex'),
      ARGON2_PARAMS,
    );
  }

  async hash(plaintext: string): Promise<string> {
    return hash(plaintext, ARGON2_PARAMS);
  }

  async verify(phc: string, plaintext: string): Promise<boolean> {
    try {
      return await verify(phc, plaintext, ARGON2_PARAMS);
    } catch {
      // A stored hash that cannot be parsed is a failed login, not a 500. It
      // means the row predates a format change or was written by hand.
      return false;
    }
  }

  /**
   * Burns the same work as a real verification, for the case where no user was
   * found.
   *
   * Without this, a missing email returns 401 in under a millisecond while a
   * wrong password takes the ~50ms argon2 costs. That difference is trivially
   * measurable over a handful of requests, and it turns the login endpoint into an
   * oracle for which addresses are registered — which is a disclosure on its own
   * and also tells an attacker exactly which accounts are worth a password list.
   *
   * The caller must return an identical response afterwards: same status, same
   * body, same problem type. Equal timing with distinguishable bodies defends
   * nothing.
   */
  async verifyWithDummy(plaintext: string): Promise<false> {
    await this.verify(this.dummyHash, plaintext);
    return false;
  }
}
