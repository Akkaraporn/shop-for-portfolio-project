import { createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_HEADER = 'x-payment-signature';

/**
 * HMAC-SHA256 of the **raw** request body, lowercase hex.
 *
 * Shared by the mock provider that signs and the webhook handler that verifies, so
 * there is exactly one definition of what is signed. A second copy is how a signing
 * bug becomes a verification bug that cancels it out, and nobody notices until a real
 * provider is plugged in.
 */
export function signWebhookBody(secret: string, rawBody: Buffer | string): string {
  return createHmac('sha256', secret)
    .update(typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody)
    .digest('hex');
}

/**
 * Constant-time comparison of a presented signature against the expected one.
 *
 * `timingSafeEqual` rather than `===`, because a short-circuiting comparison leaks how
 * many leading bytes were right — enough, over many attempts, to forge a signature one
 * byte at a time. It also throws on a length mismatch, so that is checked first.
 */
export function verifyWebbookSignature(
  secret: string,
  rawBody: Buffer | string,
  presented: string | undefined,
): boolean {
  if (!presented) {
    return false;
  }

  const expected = Buffer.from(signWebhookBody(secret, rawBody), 'utf8');
  const actual = Buffer.from(presented, 'utf8');

  if (expected.length !== actual.length) {
    return false;
  }

  return timingSafeEqual(expected, actual);
}
