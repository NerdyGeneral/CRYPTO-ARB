import crypto from "node:crypto";

// Request signing for exchange APIs that need an account. Nothing here holds or loads a key; callers pass one in.

// Kraken REST: API-Sign = base64(HMAC-SHA512(base64-decoded secret, path + SHA256(nonce + POST body))).
export function krakenSignature(path: string, nonce: string, body: string, secretBase64: string) {
  const hash = crypto.createHash("sha256").update(nonce + body).digest();
  return crypto.createHmac("sha512", Buffer.from(secretBase64, "base64")).update(Buffer.concat([Buffer.from(path), hash])).digest("base64");
}

const base64url = (data: Buffer | string) => Buffer.from(data).toString("base64url");

// Coinbase Advanced Trade: a JWT signed with the key's EC (P-256) private key, valid for two minutes and bound
// to one request ("METHOD host/path"); sent as "Authorization: Bearer <jwt>".
export function coinbaseJwt(o: { keyName: string; privateKeyPem: string; method: string; host: string; path: string; now?: number; nonce?: string }) {
  const now = Math.floor((o.now ?? Date.now()) / 1000);
  const header = { alg: "ES256", kid: o.keyName, nonce: o.nonce ?? crypto.randomBytes(16).toString("hex"), typ: "JWT" };
  const payload = { iss: "cdp", sub: o.keyName, nbf: now, exp: now + 120, uri: `${o.method.toUpperCase()} ${o.host}${o.path}` };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = crypto.sign("sha256", Buffer.from(unsigned), { key: o.privateKeyPem, dsaEncoding: "ieee-p1363" });
  return `${unsigned}.${base64url(signature)}`;
}
