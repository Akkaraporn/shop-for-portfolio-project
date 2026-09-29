import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import {
  NonCanonicalValueError,
  canonicalHash,
} from '../common/canonical/canonical-json';
import { ProblemException } from '../common/problem/problem.exception';
import { PrismaService } from '../infra/prisma/prisma.service';

/** How long a completed key stays replayable. */
export const IDEMPOTENCY_TTL_HOURS = 24;

export type IdempotencyOutcome =
  /** The caller owns this key and should do the work. */
  | { kind: 'proceed' }
  /** A previous identical request already succeeded; return its stored response. */
  | { kind: 'replay'; status: number; body: unknown };

/**
 * The idempotency key state machine.
 *
 * Why this is worth the complexity: the keys live in the shared database rather than
 * in process memory, so a checkout retried against the **other** backend replays
 * instead of placing a second order. That cross-backend replay is the demo this
 * project exists to show, and it only works because nothing here is local state.
 *
 * The flow is two transactions, not one, and the split is load-bearing:
 *
 *   Phase A (here, `begin`): claim the key by inserting `in_progress`, in its own
 *   transaction so the row is **visible to other requests immediately**. Inside one
 *   big transaction the row would stay invisible until commit, and two concurrent
 *   requests with the same key would both sail past this check.
 *
 *   Phase B (the caller's transaction): do the work and call `complete` within it, so
 *   the stored response and the order it describes commit together or not at all.
 *
 * On failure the key is released, which means only **successful** responses are ever
 * replayed. A checkout that failed for insufficient stock leaves no key, so a retry is
 * a genuine fresh attempt — which is what a client wants, since stock may have changed.
 * Stripe replays errors too; here re-attempting is more useful and no less safe,
 * because a failed attempt committed nothing.
 */
@Injectable()
export class IdempotencyService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Claims the key, or reports what a previous request did with it.
   *
   * Returns the request hash alongside the outcome so the caller does not compute it
   * twice.
   */
  async begin(
    userId: string,
    endpoint: string,
    key: string,
    body: unknown,
  ): Promise<IdempotencyOutcome> {
    const requestHash = hashRequest(body);

    try {
      await this.prisma.idempotency_keys.create({
        data: {
          user_id: userId,
          endpoint,
          idempotency_key: key,
          request_hash: requestHash,
          status: 'in_progress',
          expires_at: new Date(
            Date.now() + IDEMPOTENCY_TTL_HOURS * 60 * 60 * 1000,
          ),
        },
      });

      return { kind: 'proceed' };
    } catch (error) {
      // No pre-flight read, deliberately: two concurrent requests would both pass it.
      // The unique index on (user_id, endpoint, idempotency_key) is the only thing
      // that can decide who owns the key, so the insert is attempted and the loser
      // inspects what the winner is doing.
      if (
        !(error instanceof Prisma.PrismaClientKnownRequestError) ||
        error.code !== 'P2002'
      ) {
        throw error;
      }
    }

    return this.inspectExisting(userId, endpoint, key, requestHash);
  }

  private async inspectExisting(
    userId: string,
    endpoint: string,
    key: string,
    requestHash: string,
  ): Promise<IdempotencyOutcome> {
    const existing = await this.prisma.idempotency_keys.findUnique({
      where: {
        user_id_endpoint_idempotency_key: {
          user_id: userId,
          endpoint,
          idempotency_key: key,
        },
      },
      select: {
        status: true,
        request_hash: true,
        response_status: true,
        response_body: true,
      },
    });

    // Vanished between the failed insert and this read — expired and swept, or
    // released by a concurrent failure. Treating it as ours to retry is right: there
    // is no record of a completed request, so nothing can be replayed.
    if (!existing) {
      return { kind: 'proceed' };
    }

    // The same key presented with a different body. Neither answer is safe: replaying
    // would return someone else's order, and proceeding would let one key stand for
    // two different requests. So it is refused, and the client has a bug to fix.
    if (existing.request_hash !== requestHash) {
      throw new ProblemException('idempotency-key-reused', {
        detail:
          'This Idempotency-Key was already used for a different request body. Use a new key for a new request.',
        errors: [
          {
            field: 'Idempotency-Key',
            message: 'already used with a different request body',
          },
        ],
      });
    }

    if (existing.status === 'completed') {
      return {
        kind: 'replay',
        status: existing.response_status ?? 201,
        body: existing.response_body,
      };
    }

    // Still running. 409 rather than blocking: holding the connection open would tie
    // up a worker for as long as the other request takes, and a client that retried
    // during a slow checkout would queue behind itself.
    throw new ProblemException('checkout-in-progress', {
      detail:
        'A checkout with this Idempotency-Key is already in progress. Retry shortly.',
    });
  }

  /**
   * Records the response, inside the caller's transaction.
   *
   * Takes the transaction client rather than using its own, so the stored response and
   * the order commit atomically. A response recorded outside the transaction could
   * survive a rollback and replay an order that does not exist.
   */
  async complete(
    tx: Prisma.TransactionClient,
    userId: string,
    endpoint: string,
    key: string,
    status: number,
    body: unknown,
  ): Promise<void> {
    await tx.idempotency_keys.update({
      where: {
        user_id_endpoint_idempotency_key: {
          user_id: userId,
          endpoint,
          idempotency_key: key,
        },
      },
      data: {
        status: 'completed',
        response_status: status,
        // Round-tripped through JSON so the stored body is exactly what was sent,
        // with Dates already rendered as the strings the contract requires.
        response_body: JSON.parse(JSON.stringify(body)) as Prisma.InputJsonValue,
        completed_at: new Date(),
      },
    });
  }

  /**
   * Releases a claimed key after a failed attempt, so the client may retry.
   *
   * Deleting rather than marking `failed`: a `failed` row would have to be special
   * cased everywhere a key is inspected, and it records nothing useful — the attempt
   * committed nothing, and the failure is already in the logs under the same traceId.
   */
  async release(userId: string, endpoint: string, key: string): Promise<void> {
    await this.prisma.idempotency_keys.deleteMany({
      where: {
        user_id: userId,
        endpoint,
        idempotency_key: key,
        // Never delete a completed key: a concurrent request may have finished it
        // between the failure and this call, and that response is still replayable.
        status: 'in_progress',
      },
    });
  }
}

/**
 * The request fingerprint: SHA-256 over the canonical JSON of the body.
 *
 * A body this API cannot canonicalise — a fractional number, most likely — becomes a
 * 422 rather than a 500. The request is well-formed JSON; it just contains something
 * that cannot be fingerprinted identically in two languages, and saying so is more
 * useful than an opaque failure.
 */
export function hashRequest(body: unknown): string {
  try {
    return canonicalHash(body);
  } catch (error) {
    if (error instanceof NonCanonicalValueError) {
      throw new ProblemException('validation-failed', {
        detail: `The request body cannot be processed: ${error.reason}`,
        errors: [{ field: 'body', message: error.reason }],
      });
    }
    throw error;
  }
}
