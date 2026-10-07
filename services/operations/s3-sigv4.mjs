// AWS Signature Version 4 for the few S3 calls off-site backups make (PUT,
// HEAD, GET, DELETE, ListObjectsV2) against an S3-compatible store such as
// Cloudflare R2. Written out rather than taken from the AWS SDK: four calls do
// not justify a dependency tree in a root-run backup.

import { createHash, createHmac } from "node:crypto";

const hmac = (key, data) => createHmac("sha256", key).update(data, "utf8").digest();
export const sha256Hex = (data) => createHash("sha256").update(data).digest("hex");
export const EMPTY_SHA256 = sha256Hex("");

// RFC 3986, as SigV4 requires: everything but unreserved characters encoded,
// and "/" kept in a path.
export function uriEncode(value, keepSlash = false) {
  const encoded = encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return keepSlash ? encoded.replace(/%2F/g, "/") : encoded;
}

// The headers to send with one request: Host, x-amz-date, x-amz-content-sha256
// and Authorization. `payloadHash` is the hex SHA-256 of the body.
export function signRequest({ method, url, region = "auto", accessKeyId, secretAccessKey, payloadHash = EMPTY_SHA256, headers = {}, now = new Date() }) {
  const target = new URL(url);
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);
  const all = { ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()])),
    host: target.host, "x-amz-date": amzDate, "x-amz-content-sha256": payloadHash };
  const names = Object.keys(all).sort();
  const canonicalHeaders = names.map((name) => `${name}:${all[name]}\n`).join("");
  const signedHeaders = names.join(";");
  const query = [...target.searchParams.entries()].map(([k, v]) => [uriEncode(k), uriEncode(v)])
    .sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : 1) : (a < b ? -1 : 1))).map(([k, v]) => `${k}=${v}`).join("&");
  const canonicalPath = target.pathname.split("/").map((part) => uriEncode(decodeURIComponent(part))).join("/") || "/";
  const canonicalRequest = [method, canonicalPath, query, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${day}/${region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, day), region), "s3"), "aws4_request");
  const signature = createHmac("sha256", key).update(toSign, "utf8").digest("hex");
  return { ...all, authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` };
}

// ListObjectsV2's answer, read for what retention needs.
export function listedObjects(xml) {
  return [...String(xml).matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map(([, block]) => ({
    key: block.match(/<Key>([\s\S]*?)<\/Key>/)?.[1]?.replace(/&amp;/g, "&") ?? "",
    lastModified: block.match(/<LastModified>([\s\S]*?)<\/LastModified>/)?.[1] ?? "",
    size: Number(block.match(/<Size>(\d+)<\/Size>/)?.[1] ?? 0),
  })).filter((object) => object.key);
}
