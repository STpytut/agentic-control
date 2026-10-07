import { executeJson } from "@/lib/database";

// Settings → Backups (0141): where the off-site copies go and how the last
// upload went. Never the secret key — the panel holds it only as the envelope
// it sent.
export type OffsiteBackup = {
  configured: boolean;
  endpoint: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  lastUploadAt: string;
  lastAttemptAt: string;
  lastObject: string;
  lastBytes: number | null;
  lastError: string;
  /** Configured, and no copy has reached the bucket in 36 hours (the health alert's bound). */
  stale: boolean;
};

export async function getOffsiteBackup(operatorId: string): Promise<OffsiteBackup | null> {
  const row = await executeJson(`SELECT get_offsite_backup(:'owner_id'::uuid)::text;`, { owner_id: operatorId })
    .catch(() => null) as Record<string, unknown> | null;
  if (!row) return null;
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  return {
    configured: row.configured === true, endpoint: text(row.endpoint), bucket: text(row.bucket), prefix: text(row.prefix),
    accessKeyId: text(row.access_key_id), lastUploadAt: text(row.last_upload_at), lastAttemptAt: text(row.last_attempt_at),
    lastObject: text(row.last_object), lastBytes: typeof row.last_bytes === "number" ? row.last_bytes : null, lastError: text(row.last_error),
    stale: row.configured === true && Date.now() - new Date(text(row.last_upload_at) || text(row.set_at)).getTime() > 36 * 3600_000,
  };
}
