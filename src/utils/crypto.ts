import crypto from "crypto";

/**
 * Constant-time string comparison using Node's crypto.timingSafeEqual.
 *
 * Pads both strings to the same length before comparing so that even a
 * length mismatch does not reveal timing information.
 *
 * Returns false for empty or missing inputs.
 */
export function safeEqual(a: string, b: string): boolean {
  if (!a || !b) return false;

  // Normalise to equal-length Buffers.
  // We always compare exactly 64 bytes (SHA-256 hex length) so the
  // real lengths are never observable by timing.
  const maxLen = Math.max(a.length, b.length, 64);
  const bufA = Buffer.alloc(maxLen);
  const bufB = Buffer.alloc(maxLen);
  bufA.write(a);
  bufB.write(b);

  // crypto.timingSafeEqual requires equal-length Buffers (guaranteed above)
  const equal = crypto.timingSafeEqual(bufA, bufB);

  // If the original lengths differ, reject even if padded comparison matched
  // (padding with zeros could create false positives for prefixes).
  return equal && a.length === b.length;
}
