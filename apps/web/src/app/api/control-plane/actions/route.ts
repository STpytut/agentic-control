import { performControlPlaneAction } from "@/lib/control-plane-actions";
import { requireCsrf, requireOperatorApi, writeSessionAudit } from "@/lib/auth";
import { withTransaction } from "@/lib/database";
import { revalidatePath } from "next/cache";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const operator = await requireOperatorApi();
  if (operator instanceof Response) return operator;

  // The security control. The `x-control-plane-action` confirmation header
  // below is a UI safeguard against an accidental submit, not an authorization
  // check, and the previous Origin comparison here was only a weaker duplicate
  // of what `requireCsrf` already does.
  try {
    await requireCsrf(request);
  } catch {
    return Response.json({ ok: false, error: "CSRF check failed" }, { status: 403 });
  }

  const contentType = request.headers.get("content-type") ?? "";
  const confirmation = request.headers.get("x-control-plane-action");
  if (!contentType.startsWith("application/json") || confirmation !== "confirmed") {
    return Response.json({ ok: false, error: "Action confirmation is required" }, { status: 400 });
  }

  let body: Record<string, unknown> = {};
  try {
    body = await request.json();
    const kind = String(body.kind ?? "unknown");

    // The action and the row saying the operator asked for it are one database
    // transaction. Committed separately — which is what this was — a failure
    // writing the audit left the action applied, unrecorded, and the caller told
    // it failed, so a retry duplicates or conflicts. `withTransaction` puts every
    // query the action makes on the same connection, so the rollback covers all
    // of it.
    const result = await withTransaction(async () => {
      const actionResult = await performControlPlaneAction(body, operator);
      const ownedProjectId = typeof actionResult?.project_id === "string" ? actionResult.project_id
        : typeof body.projectId === "string" ? body.projectId : "";
      await writeSessionAudit(
        `operator.${kind}`,
        kind,
        String(actionResult?.task_id ?? actionResult?.project_id ?? body.id ?? "control-plane"),
        "allowed",
        {},
        ownedProjectId,
      );
      return actionResult;
    });

    // After the commit: a cache invalidation for a rolled-back action would send
    // the panel looking for a change that does not exist.
    revalidatePath("/");
    return Response.json({ ok: true, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Control-plane action failed";
    const kind = String(body.kind ?? "invalid_action");
    // Outside the transaction, because the transaction is gone: nothing was
    // committed, and a refusal is exactly the thing that has to survive it.
    // Attributed to the session that made the request, never to an id the caller
    // supplied.
    await writeSessionAudit(kind === "invalid_action" ? "operator.invalid_action" : `operator.${kind}`,
      "control_plane_action", String(body.projectId ?? body.id ?? "invalid"), "denied",
      { reason: message.slice(0, 300) }).catch(() => undefined);
    const conflict = message.includes("expected version") || message.includes("reviewable")
      || message.includes("already moved forward") || message.includes("source task is not terminal");
    const unavailable = message.includes("resource is unavailable");
    return Response.json({ ok: false, error: conflict
      ? "This task changed while the action was open. The current state is being refreshed."
      : message }, { status: conflict ? 409 : unavailable ? 404 : 400 });
  }
}
