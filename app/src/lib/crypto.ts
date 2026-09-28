// End-to-end encryption for account sync (see specs/app-sync-plan.md).
//
// The password never leaves the device. PBKDF2 turns it into a master secret, and HKDF splits that
// into two unrelated keys:
//   - `auth`: sent to the server as the login secret (the server keeps only a keyed hash of it);
//   - `kek`: stays on the device and wraps the random data key that encrypts the state.
// So the server, and anyone who copies its database, holds only ciphertext. Reading it means guessing
// the password, at 600k PBKDF2 rounds per guess.

const enc = new TextEncoder();
const dec = new TextDecoder();

/** OWASP's 2023+ recommendation for PBKDF2-HMAC-SHA256. */
export const KDF_ITERATIONS = 600_000;
export const MIN_PASSWORD = 10;
/** Keep in sync with worker/index.ts. */
export const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;

export const normaliseUsername = (u: string) => u.trim().toLowerCase();

/** AES-GCM output: base64url IV and ciphertext (with tag). */
export interface Sealed { iv: string; ct: string }

export interface PasswordKeys {
  /** base64url, 32 bytes: what the server checks */
  auth: string;
  /** never leaves the device */
  kek: CryptoKey;
}

export function b64(bytes: ArrayBuffer | Uint8Array): string {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function unb64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const hkdf = (info: string) => ({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: enc.encode(info) });

export async function deriveKeys(username: string, password: string, iterations = KDF_ITERATIONS): Promise<PasswordKeys> {
  // a per-user salt that needs no round trip: the username is unique on the server
  const salt = await crypto.subtle.digest("SHA-256", enc.encode(`pocketaces/v1/${username}`));
  const pw = await crypto.subtle.importKey("raw", enc.encode(password.normalize("NFKC")), "PBKDF2", false, ["deriveBits"]);
  const master = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, pw, 256);
  const hk = await crypto.subtle.importKey("raw", master, "HKDF", false, ["deriveBits", "deriveKey"]);
  const auth = await crypto.subtle.deriveBits(hkdf("pocketaces/auth"), hk, 256);
  const kek = await crypto.subtle.deriveKey(hkdf("pocketaces/kek"), hk, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  return { auth: b64(auth), kek };
}

async function seal(key: CryptoKey, data: Uint8Array<ArrayBuffer>, aad: string): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(aad) }, key, data);
  return { iv: b64(iv), ct: b64(ct) };
}

async function open(key: CryptoKey, s: Sealed, aad: string): Promise<Uint8Array<ArrayBuffer>> {
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(s.iv), additionalData: enc.encode(aad) }, key, unb64(s.ct));
  return new Uint8Array(pt);
}

/** Stored non-extractable, so script on the page can use the data key but can't read it out. */
const importDataKey = (raw: Uint8Array<ArrayBuffer>) =>
  crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);

const dekAad = (username: string) => `pocketaces/dek/${username}`;

/** A fresh random data key, and its copy wrapped with the password key for the server. */
export async function newDataKey(kek: CryptoKey, username: string): Promise<{ key: CryptoKey; wrapped: Sealed }> {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  try {
    return { key: await importDataKey(raw), wrapped: await seal(kek, raw, dekAad(username)) };
  } finally {
    raw.fill(0);
  }
}

/** Throws if the password (so the kek) is wrong. */
export async function unwrapDataKey(kek: CryptoKey, username: string, wrapped: Sealed): Promise<CryptoKey> {
  const raw = await open(kek, wrapped, dekAad(username));
  try {
    return await importDataKey(raw);
  } finally {
    raw.fill(0);
  }
}

/** Password change: same data key, wrapped with the new password key. */
export async function rewrapDataKey(oldKek: CryptoKey, newKek: CryptoKey, username: string, wrapped: Sealed): Promise<Sealed> {
  const raw = await open(oldKek, wrapped, dekAad(username));
  try {
    return await seal(newKek, raw, dekAad(username));
  } finally {
    raw.fill(0);
  }
}

async function pipe(data: Uint8Array<ArrayBuffer>, t: CompressionStream | DecompressionStream): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(t)).arrayBuffer());
}

// Binding the username and version into the AAD stops the server from passing off another
// account's blob or relabelling an old blob as a newer version.
const stateAad = (username: string, version: number) => `pocketaces/state/${username}/${version}`;

export async function sealState(key: CryptoKey, username: string, version: number, state: unknown): Promise<Sealed> {
  const gz = await pipe(enc.encode(JSON.stringify(state)), new CompressionStream("gzip"));
  return seal(key, gz, stateAad(username, version));
}

export async function openState(key: CryptoKey, username: string, version: number, s: Sealed): Promise<unknown> {
  const gz = await open(key, s, stateAad(username, version));
  return JSON.parse(dec.decode(await pipe(gz, new DecompressionStream("gzip"))));
}
