// Browser-side hybrid encryption of the OpenCode Go API key.
//
// The plaintext key is encrypted in the browser with the VPS broker's public
// key (RSA-OAEP-SHA256 wrapped AES-256-GCM). Only the envelope reaches the web
// API and PostgreSQL; the web process never sees the plaintext, and only the broker's
// private key (which stays on the VPS) can decrypt it.

export type OpenCodeSecretEnvelope = {
  ciphertext: string;
  iv: string;
  tag: string;
  keyWrap: string;
};

function toBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function pemToSparse(pem: string) {
  const body = pem
    .replace(/-----(BEGIN|END) PUBLIC KEY-----/g, "")
    .replace(/\s+/g, "");
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

export async function encryptOpenCodeApiKey(apiKey: string, publicKeyPem: string): Promise<OpenCodeSecretEnvelope> {
  const rsa = await crypto.subtle.importKey(
    "spki",
    pemToSparse(publicKeyPem),
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["encrypt"],
  );
  const aes = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aes, new TextEncoder().encode(apiKey)),
  );
  const ciphertext = sealed.slice(0, sealed.length - 16);
  const tag = sealed.slice(sealed.length - 16);
  const rawKey = new Uint8Array(await crypto.subtle.exportKey("raw", aes));
  const keyWrap = new Uint8Array(await crypto.subtle.encrypt({ name: "RSA-OAEP" }, rsa, rawKey));
  return {
    ciphertext: toBase64(ciphertext),
    iv: toBase64(iv),
    tag: toBase64(tag),
    keyWrap: toBase64(keyWrap),
  };
}
