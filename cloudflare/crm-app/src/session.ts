import type {} from "./types.ts";

const COOKIE_NAME = "crm_remote_session";

function base64UrlEncode(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(str: string): Uint8Array {
  let base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4) {
    base64 += "=";
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function getHmacKey(secret: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

/**
 * Creates a signed opaque session cookie: <sessionId>.<hmacSignature>
 * The cookie value contains ONLY the random opaque session ID.
 * Tokens (access_token, refresh_token) are NEVER stored in the cookie.
 */
export async function createSessionCookieValue(sessionId: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const b64Id = base64UrlEncode(enc.encode(sessionId));

  const key = await getHmacKey(secret);
  const sigBuffer = await crypto.subtle.sign("HMAC", key, enc.encode(b64Id));
  const b64Sig = base64UrlEncode(sigBuffer);

  return `${b64Id}.${b64Sig}`;
}

/**
 * Verifies the HMAC signature and extracts the opaque session ID.
 * Returns the sessionId if valid, or null if tampered or malformed.
 */
export async function verifySessionCookieValue(cookieValue: string, secret: string): Promise<string | null> {
  const parts = cookieValue.split(".");
  if (parts.length !== 2) return null;

  const [b64Id, b64Sig] = parts;
  const enc = new TextEncoder();

  try {
    const key = await getHmacKey(secret);
    const sigBytes = base64UrlDecode(b64Sig);
    const isValid = await crypto.subtle.verify("HMAC", key, sigBytes, enc.encode(b64Id));
    if (!isValid) return null;

    const idBytes = base64UrlDecode(b64Id);
    const sessionId = new TextDecoder().decode(idBytes);

    // Validate UUID format or string length
    if (!sessionId || sessionId.length < 16 || sessionId.length > 128) {
      return null;
    }

    return sessionId;
  } catch {
    return null;
  }
}

export function parseSessionCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  const cookies = cookieHeader.split(";").map(c => c.trim());
  const prefix = COOKIE_NAME + "=";
  const match = cookies.find(c => c.startsWith(prefix));
  return match ? match.slice(prefix.length) : null;
}

export function buildSetCookieHeader(cookieValue: string, erase = false): string {
  if (erase) {
    return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
  }
  return `${COOKIE_NAME}=${cookieValue}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=28800`;
}
