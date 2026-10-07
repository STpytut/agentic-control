// Off-site backups (0141, rc.129).
//
//   offsite-backup.mjs            upload the newest backup, then keep the newest
//                                 fourteen in the bucket (run by the unit after
//                                 every successful backup)
//   offsite-backup.mjs list       the backups in the bucket
//   offsite-backup.mjs fetch <name> <dir>
//                                 download one (with its receipt) to <dir>
//
// What is uploaded is the file the backup already encrypted with the host's
// passphrase (gpg, AES256), and its receipt. The bucket never holds anything
// readable without that passphrase — so the passphrase must be kept somewhere
// other than this host as well (OPERATIONS §16b).
//
// `list` and `fetch` also work on a fresh host with no database: the bucket is
// then named by OFFSITE_ENDPOINT, OFFSITE_BUCKET, OFFSITE_ACCESS_KEY_ID and
// OFFSITE_SECRET_ACCESS_KEY in the environment.

import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import { request } from "node:https";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { queryJson, closePool } from "../control-plane/db.mjs";
import { isMain } from "../control-plane/entrypoint.mjs";
import { decryptBrokerEnvelope, readPrivateKey } from "../control-plane/telegram.mjs";
import { listedObjects, sha256Hex, signRequest } from "./s3-sigv4.mjs";

const backupRoot = process.env.INFRA_BACKUP_ROOT ?? "/var/lib/infra-cod-backups";
const privateKeyPath = process.env.OPENCODE_BROKER_PRIVATE_KEY_PATH ?? "/etc/infra-cod/opencode/broker-private.pem";
const KEEP = Number(process.env.INFRA_OFFSITE_KEEP ?? 14);

function send({ target, method, key = "", query = "", body = null, payloadHash, headers = {}, out = null }) {
  const objectPath = key ? `/${key.split("/").map(encodeURIComponent).join("/")}` : "";
  const url = `${target.endpoint}/${target.bucket}${objectPath}${query ? `?${query}` : ""}`;
  const signed = signRequest({ method, url, region: target.region ?? "auto", accessKeyId: target.accessKeyId,
    secretAccessKey: target.secret, payloadHash, headers });
  return new Promise((resolve, reject) => {
    const req = request(url, { method, headers: signed, timeout: 600_000 }, (res) => {
      if (out && res.statusCode === 200) {
        pipeline(res, out).then(() => resolve({ status: 200, headers: res.headers, text: "" }), reject);
        return;
      }
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { if (text.length < 1_000_000) text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on("timeout", () => req.destroy(new Error(`${method} timed out`)));
    req.on("error", reject);
    if (body) body.pipe(req);
    else req.end();
  });
}

// The store's own complaint, without the request that carried the key.
const complaint = (answer) => `${answer.status} ${(answer.text.match(/<Code>([^<]+)<\/Code>/)?.[1] ?? "").slice(0, 80)}`.trim();

async function target() {
  if (process.env.OFFSITE_ENDPOINT) {
    return { endpoint: process.env.OFFSITE_ENDPOINT.replace(/\/$/, ""), bucket: process.env.OFFSITE_BUCKET,
      prefix: process.env.OFFSITE_PREFIX ?? "infra-cod/", region: process.env.OFFSITE_REGION ?? "auto",
      accessKeyId: process.env.OFFSITE_ACCESS_KEY_ID, secret: process.env.OFFSITE_SECRET_ACCESS_KEY, fromDatabase: false };
  }
  const row = await queryJson(`SELECT offsite_backup_for_upload()::text;`);
  if (!row) return null;
  return { endpoint: row.endpoint, bucket: row.bucket, prefix: row.prefix, region: row.region, accessKeyId: row.access_key_id,
    secret: decryptBrokerEnvelope(row.envelope, readPrivateKey(privateKeyPath)), lastObject: row.last_object, fromDatabase: true };
}

async function list(t) {
  const objects = [];
  let token = "";
  do {
    const query = `list-type=2&prefix=${encodeURIComponent(t.prefix)}${token ? `&continuation-token=${encodeURIComponent(token)}` : ""}`;
    const answer = await send({ target: t, method: "GET", query, payloadHash: sha256Hex("") });
    if (answer.status !== 200) throw new Error(`listing the bucket failed: ${complaint(answer)}`);
    objects.push(...listedObjects(answer.text));
    token = answer.text.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/)?.[1] ?? "";
  } while (token);
  return objects;
}

async function putFile(t, key, file, sha256) {
  const size = (await stat(file)).size;
  const answer = await send({ target: t, method: "PUT", key, body: createReadStream(file), payloadHash: sha256,
    headers: { "content-length": size, "content-type": "application/octet-stream" } });
  if (answer.status !== 200) throw new Error(`uploading ${path.basename(file)} failed: ${complaint(answer)}`);
  const head = await send({ target: t, method: "HEAD", key, payloadHash: sha256Hex("") });
  if (head.status !== 200 || Number(head.headers["content-length"]) !== size) {
    throw new Error(`${path.basename(file)} is not in the bucket at its full size after the upload`);
  }
  return size;
}

// The newest KEEP backups stay; older ones go, each with its receipt.
export function objectsToDelete(objects, keep = KEEP) {
  const backups = objects.filter((object) => object.key.endsWith(".gpg"))
    .sort((a, b) => (a.lastModified < b.lastModified ? 1 : -1));
  const stale = new Set(backups.slice(keep).map((object) => object.key));
  return objects.filter((object) => stale.has(object.key) || stale.has(object.key.replace(/\.json$/, ""))).map((object) => object.key);
}

async function upload() {
  const t = await target();
  if (!t) return { status: "not_configured" };
  const receipt = JSON.parse(await readFile(path.join(backupRoot, "latest.json"), "utf8"));
  const name = receipt.encrypted_file;
  if (!name || name.includes("/")) throw new Error("the newest backup's receipt names no file");
  if (t.lastObject === `${t.prefix}${name}`) return { status: "already_uploaded", object: t.lastObject };
  const file = path.join(backupRoot, name);
  try {
    const bytes = await putFile(t, `${t.prefix}${name}`, file, receipt.encrypted_sha256);
    const receiptFile = `${file}.json`;
    await putFile(t, `${t.prefix}${name}.json`, receiptFile, sha256Hex(await readFile(receiptFile)));
    const stale = objectsToDelete(await list(t));
    for (const key of stale) {
      const answer = await send({ target: t, method: "DELETE", key, payloadHash: sha256Hex("") });
      if (answer.status !== 204 && answer.status !== 200) throw new Error(`removing an old copy failed: ${complaint(answer)}`);
    }
    if (t.fromDatabase) await queryJson(`SELECT record_offsite_upload(:'object',:'bytes'::bigint,NULL);`, { object: `${t.prefix}${name}`, bytes: String(bytes) });
    return { status: "uploaded", object: `${t.prefix}${name}`, bytes, removed: stale.length };
  } catch (error) {
    const message = String(error?.message ?? error).replaceAll(t.secret, "[redacted]").slice(0, 500);
    if (t.fromDatabase) await queryJson(`SELECT record_offsite_upload(NULL,NULL,:'error');`, { error: message }).catch(() => undefined);
    throw new Error(message);
  }
}

async function main() {
  const [command = "upload", ...args] = process.argv.slice(2);
  if (command === "upload") {
    process.stdout.write(`${JSON.stringify({ type: "offsite-backup", ...(await upload()) })}\n`);
  } else if (command === "list") {
    const t = await target();
    if (!t) throw new Error("no off-site bucket is configured");
    for (const object of await list(t)) process.stdout.write(`${object.lastModified}  ${String(object.size).padStart(12)}  ${object.key}\n`);
  } else if (command === "fetch") {
    const [name, dir] = args;
    if (!name || !dir || name.includes("/")) throw new Error("usage: offsite-backup.mjs fetch <backup file name> <directory>");
    const t = await target();
    if (!t) throw new Error("no off-site bucket is configured");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    for (const file of [name, `${name}.json`]) {
      const answer = await send({ target: t, method: "GET", key: `${t.prefix}${file}`, payloadHash: sha256Hex(""),
        out: createWriteStream(path.join(dir, file), { mode: 0o600 }) });
      if (answer.status !== 200) throw new Error(`fetching ${file} failed: ${complaint(answer)}`);
    }
    process.stdout.write(`fetched ${name} and its receipt to ${dir}\n`);
  } else {
    throw new Error(`unknown command ${command}: upload, list or fetch`);
  }
}

if (isMain(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ type: "offsite-backup.failed", error: String(error?.message ?? error).slice(0, 500) })}\n`);
    process.exitCode = 1;
  } finally {
    await closePool().catch(() => undefined);
  }
}
