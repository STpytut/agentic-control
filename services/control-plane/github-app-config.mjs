// Where the GitHub broker finds its App (Stage 12 G1). Two sources:
//
//   env    — an App an operator created by hand and wrote into
//            /etc/infra-cod/github-app.env with its key beside it (OPERATIONS.md).
//            When GITHUB_APP_ID is set it is the App, whatever else exists.
//   panel  — the App the settings page created through GitHub's manifest flow
//            (0125): its public fields in github_app_manifests, its private key
//            and client secret in files under the broker's own state directory,
//            which nothing else on the host reads.

import { mkdir, readFile, rename, writeFile, chmod } from "node:fs/promises";
import path from "node:path";

export const DEFAULT_APP_STATE_DIR = "/var/lib/infra-cod-github/app";
export const KEY_FILE = "private-key.pem";
export const CLIENT_SECRET_FILE = "client-secret";

// A slug as GitHub spells it. The host's env had the App's URL where the slug
// belongs (https://github.com/apps/infra-cod), which made every install link
// point nowhere; the URL's last segment is the slug, so it is read as one.
export function normaliseSlug(value) {
  const text = String(value ?? "").trim().replace(/\/+$/, "");
  const slug = text.includes("/") ? text.slice(text.lastIndexOf("/") + 1) : text;
  return /^[a-z0-9][a-z0-9-]{0,99}$/.test(slug) ? slug : "";
}

export async function resolveAppConfig({ env = process.env, registration = null, stateDir = DEFAULT_APP_STATE_DIR,
  read = (file) => readFile(file, "utf8") } = {}) {
  const envAppId = String(env.GITHUB_APP_ID ?? "").trim();
  if (envAppId) {
    return {
      source: "env", appId: envAppId, slug: normaliseSlug(env.GITHUB_APP_SLUG),
      clientId: String(env.GITHUB_APP_CLIENT_ID ?? "").trim(),
      clientSecret: String(env.GITHUB_APP_CLIENT_SECRET ?? "").trim(),
      keyPath: env.GITHUB_APP_PRIVATE_KEY_PATH ?? "",
    };
  }
  if (!registration?.app_id) return { source: null, appId: "", slug: "", clientId: "", clientSecret: "", keyPath: "" };
  const clientSecret = await read(path.join(stateDir, CLIENT_SECRET_FILE)).then((text) => text.trim(), () => "");
  return {
    source: "panel", appId: String(registration.app_id), slug: normaliseSlug(registration.slug),
    clientId: String(registration.client_id ?? ""), clientSecret, keyPath: path.join(stateDir, KEY_FILE),
  };
}

// The conversion's secrets, as files only the broker's user reads: written
// beside their final name and renamed over it, so a crash leaves the old file
// or the new one and never half of either.
export async function writeAppSecrets({ stateDir = DEFAULT_APP_STATE_DIR, pem, clientSecret }) {
  if (!String(pem ?? "").includes("PRIVATE KEY")) throw new Error("GitHub returned no private key for the App");
  if (!clientSecret) throw new Error("GitHub returned no client secret for the App");
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await chmod(stateDir, 0o700);
  for (const [name, contents] of [[KEY_FILE, pem], [CLIENT_SECRET_FILE, `${clientSecret}\n`]]) {
    const target = path.join(stateDir, name);
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, contents, { mode: 0o600 });
    await rename(temporary, target);
  }
}
