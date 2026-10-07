"use client";

import { controlPlaneActionHeaders } from "@/lib/csrf-client";
import type { OffsiteBackup } from "@/lib/offsite-backup";
import { encryptOpenCodeApiKey } from "@/lib/opencode-crypto";
import { formatTimestamp } from "@/lib/format-timestamp";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Badge, Button, Card, TextInput } from "@agentic/design-system";
import { connection as ui } from "@/components/ui/connection-card";
import { dangerOutlineClasses } from "@/components/ui/danger-button";
import { Notice } from "@/components/ui/notice";

async function action(body: Record<string, unknown>) {
  const response = await fetch("/api/control-plane/actions", { method: "POST", headers: controlPlaneActionHeaders(), body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.error ?? "Backup action failed");
  return data.result as Record<string, unknown>;
}

async function brokerKey() {
  const response = await fetch("/api/control-plane/opencode/broker-key", { cache: "no-store" });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.error ?? "The server's encryption key is unavailable");
  return String(data.publicKey);
}

function size(bytes: number | null) {
  if (bytes === null) return "";
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

// Settings → Backups (0141): every backup is copied to a bucket of yours, so
// losing the server does not lose its backups too.
export function OffsiteBackupCard({ initial }: { initial: OffsiteBackup }) {
  const router = useRouter();
  const [editing, setEditing] = useState(!initial.configured);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [endpoint, setEndpoint] = useState(initial.endpoint);
  const [bucket, setBucket] = useState(initial.bucket);
  const [keyId, setKeyId] = useState(initial.accessKeyId);
  const [secret, setSecret] = useState("");
  const stale = initial.stale;

  async function save() {
    setBusy("save");
    setError("");
    try {
      if (!/^https:\/\/[A-Za-z0-9.-]+$/.test(endpoint.trim().replace(/\/$/, ""))) throw new Error("The endpoint is the S3 API address R2 shows: https://<account id>.r2.cloudflarestorage.com");
      // Field by field: the database's one sentence did not say which was wrong,
      // and R2's token screen shows a cfat_… "Token value" beside the S3 keys.
      if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket.trim())) throw new Error("The bucket name is lowercase letters, digits, dots and hyphens, as R2 shows it.");
      if (keyId.trim().startsWith("cfat_")) throw new Error("That is the token value for Cloudflare's API. Paste the Access Key ID instead: 32 letters and digits.");
      if (!/^[A-Za-z0-9]{16,128}$/.test(keyId.trim())) throw new Error("The Access Key ID is letters and digits only — 32 of them for R2.");
      if (secret.trim().startsWith("cfat_")) throw new Error("That is the token value for Cloudflare's API. Paste the Secret Access Key instead: 64 letters and digits.");
      if (secret.trim().length < 16) throw new Error("Paste the secret access key R2 showed when you made the token.");
      const envelope = await encryptOpenCodeApiKey(secret.trim(), await brokerKey());
      await action({ kind: "offsite_set", endpoint: endpoint.trim().replace(/\/$/, ""), bucket: bucket.trim(), accessKeyId: keyId.trim(),
        ciphertext: envelope.ciphertext, iv: envelope.iv, tag: envelope.tag, keyWrap: envelope.keyWrap });
      setSecret("");
      setEditing(false);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The bucket could not be saved");
    } finally {
      setBusy("");
    }
  }

  async function disable() {
    if (!window.confirm("Stop copying backups off the server? The copies already in the bucket stay there.")) return;
    setBusy("disable");
    setError("");
    try {
      await action({ kind: "offsite_disable" });
      setEditing(true);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not stop the off-site copies");
    } finally {
      setBusy("");
    }
  }

  return <Card as="section" className="min-w-0">
    <div className={ui.heading}>
      <div>
        <p className="type-eyebrow text-muted">BACKUPS</p>
        <h2 className="type-section-title mt-1.5">Off-site copies</h2>
        <p className={ui.owner}>After every daily backup, the encrypted file is copied to your bucket; the newest 14 are kept.</p>
      </div>
      <Badge tone={!initial.configured ? "neutral" : stale || initial.lastError ? "danger" : "success"} className="shrink-0">
        {!initial.configured ? "Not set up" : stale ? "Out of date" : initial.lastError ? "Last upload failed" : "Copying"}
      </Badge>
    </div>

    {error && <Notice tone="danger" className="mt-3.5">{error}</Notice>}
    {initial.configured && initial.lastError && <Notice tone="danger" className="mt-3.5">The last upload failed: {initial.lastError}</Notice>}

    {initial.configured && !editing && <dl className={ui.meta}>
      <div className={ui.metaItem}><dt className={ui.metaTerm}>Bucket</dt><dd className={ui.metaValue}>{initial.bucket} · {initial.endpoint.replace(/^https:\/\//, "")}</dd></div>
      <div className={ui.metaItem}><dt className={ui.metaTerm}>Newest copy</dt><dd className={ui.metaValue}>
        {initial.lastUploadAt ? `${formatTimestamp(initial.lastUploadAt)} · ${size(initial.lastBytes)}` : "none yet — after the next daily backup"}
      </dd></div>
    </dl>}

    {editing && <form className="mt-4 grid gap-2.5" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <ol className="type-app-body m-0 grid gap-1 pl-5 text-ink/85">
        <li>In Cloudflare, open R2 and create a bucket.</li>
        <li>Create an API token with Object Read &amp; Write on that bucket.</li>
        <li>Paste its S3 endpoint, the bucket name, the access key id and the secret access key. The secret is encrypted in your browser for the server.</li>
      </ol>
      <TextInput value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder="https://<account id>.r2.cloudflarestorage.com" aria-label="S3 endpoint" autoComplete="off" spellCheck={false}/>
      <TextInput value={bucket} onChange={(event) => setBucket(event.target.value)} placeholder="bucket name" aria-label="Bucket" autoComplete="off" spellCheck={false}/>
      <TextInput value={keyId} onChange={(event) => setKeyId(event.target.value)} placeholder="Access key id" aria-label="Access key id" autoComplete="off" spellCheck={false}/>
      <TextInput value={secret} onChange={(event) => setSecret(event.target.value)} type="password" placeholder="Secret access key" aria-label="Secret access key" autoComplete="off" spellCheck={false}/>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" type="submit" disabled={Boolean(busy)}>{busy === "save" ? "Saving…" : "Save bucket"}</Button>
        {initial.configured && <Button size="sm" variant="secondary" type="button" onClick={() => setEditing(false)}>Cancel</Button>}
      </div>
    </form>}

    <Notice tone="info" className="mt-4">
      The copies are encrypted with this server&apos;s backup passphrase, so they are useless without it. Keep it somewhere other than this server — a password manager: <code>sudo cat /etc/infra-cod/backup.passphrase</code>
    </Notice>

    {initial.configured && !editing && <div className={ui.actions}>
      <Button size="sm" variant="secondary" onClick={() => setEditing(true)} disabled={Boolean(busy)}>Change bucket or key</Button>
      <button className={dangerOutlineClasses} onClick={() => void disable()} disabled={Boolean(busy)}>{busy === "disable" ? "Stopping…" : "Stop copying"}</button>
    </div>}
  </Card>;
}
