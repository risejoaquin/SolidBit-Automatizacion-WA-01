/**
 * Web Crypto HMAC-SHA256 signature verification for Kapso webhooks.
 * Uses constant-time comparison to prevent timing attacks.
 */
export async function verifyKapsoSignature(
  rawBody: ArrayBuffer | Uint8Array,
  signatureHex: string | null | undefined,
  secret: string | null | undefined
): Promise<boolean> {
  if (!secret || typeof secret !== "string" || secret.length < 16) {
    return false;
  }
  if (!signatureHex || typeof signatureHex !== "string" || !/^[0-9a-f]{64}$/i.test(signatureHex)) {
    return false;
  }

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const sigBuffer = await crypto.subtle.sign("HMAC", key, rawBody);
  const expectedHex = Array.from(new Uint8Array(sigBuffer))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");

  const suppliedHex = signatureHex.toLowerCase();
  if (expectedHex.length !== suppliedHex.length) {
    return false;
  }

  // Constant-time XOR comparison across all characters
  let mismatch = 0;
  for (let i = 0; i < expectedHex.length; i++) {
    mismatch |= expectedHex.charCodeAt(i) ^ suppliedHex.charCodeAt(i);
  }

  return mismatch === 0;
}
