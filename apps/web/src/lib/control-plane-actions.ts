import { randomUUID } from "node:crypto";
import { executeJson } from "@/lib/database";
import type { Operator } from "@/lib/auth";
import { pinModel, requestModelCheck } from "@/lib/model-checks";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const maximumMessageLength = 64_000;

function uuid(value: unknown, name: string) {
  if (typeof value !== "string" || !uuidPattern.test(value)) throw new Error(`${name} is invalid`);
  return value;
}

function text(value: unknown, name: string, minimum = 2, maximum = 4000) {
  if (typeof value !== "string" || value.trim().length < minimum || value.length > maximum) throw new Error(`${name} is invalid`);
  return value.trim();
}

function messageText(value: unknown) {
  if (typeof value !== "string" || value.trim().length < 2) {
    throw new Error("Message must contain at least 2 characters");
  }
  if (value.length > maximumMessageLength) {
    throw new Error(`Message is too long (maximum ${maximumMessageLength.toLocaleString("en-US")} characters)`);
  }
  return value.trim();
}

function version(value: unknown) {
  if (!Number.isInteger(value) || Number(value) < 1) throw new Error("taskVersion is invalid");
  return Number(value);
}

function projectName(value: unknown) {
  return text(value, "name", 2, 80);
}

function projectSlug(value: string) {
  const slug = value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
  return slug || "project";
}

function repository(value: unknown) {
  if (value === undefined || value === null || value === "") return "";
  const url = text(value, "repository", 8, 500);
  if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(url)) {
    throw new Error("Only HTTPS GitHub repository URLs are supported in V1");
  }
  return url;
}

async function orchestratorProfile(value: unknown) {
  const requested = value === undefined || value === null || value === "" ? "" : uuid(value, "orchestratorProfileId");
  const result = await executeJson(
    `SELECT jsonb_build_object('id',id,'runtime_type',runtime_type,'model',model)::text
     FROM runtime_profiles
       WHERE enabled AND last_verified_at IS NOT NULL AND runtime_type='codex'
       AND (:'profile_id'='' OR id=:'profile_id'::uuid)
     ORDER BY last_verified_at DESC NULLS LAST,created_at,id LIMIT 1;`,
    { profile_id: requested },
  );
  if (!result) throw new Error("The selected orchestrator runtime is unavailable");
  return String(result.id);
}

// The structural profile a catalog-driven project needs, made if the host does
// not have one.
//
// `runtime_profiles` is written by nothing in this product — the only
// `INSERT INTO runtime_profiles` in the repository is in `pocs/` — so on a host
// that has only ever been installed the table is empty and every attempt to
// create a project answered "The selected orchestrator runtime is unavailable",
// after connecting a runtime and verifying a model. A developer who had run a
// PoC never saw it.
//
// What the profile carries is structure: `agents` and
// `project_agent_assignments` reference one and `create_task_with_executors`
// reads `runtime_type` off it. The runtime and model a task actually uses come
// from the verified catalog entry, through `set_project_runtime_defaults` and
// `capture_task_runtime_snapshot`.
async function structuralProfile(ownerId: string, runtimeType: "codex" | "opencode") {
  const result = await executeJson(
    `SELECT jsonb_build_object('id',ensure_structural_runtime_profile(:'owner_id'::uuid,:'runtime_type'))::text;`,
    { owner_id: ownerId, runtime_type: runtimeType },
  );
  if (!result?.id) throw new Error(`No structural ${runtimeType} adapter could be prepared`);
  return String(result.id);
}

async function catalogEntry(value: unknown, name: string) {
  if (value === undefined || value === null || value === "") return "";
  return uuid(value, name);
}

async function catalogExecutorEntries(value: unknown) {
  if (value !== undefined && !Array.isArray(value)) throw new Error("executorEntryIds is invalid");
  const requested = [...new Set((value as unknown[] | undefined)?.map((item) => uuid(item, "executorEntryId")) ?? [])];
  if (requested.length > 8) throw new Error("No more than eight executor models can be selected");
  return requested;
}

// A reasoning level as the panel sends it (Stage 12): "" for the runtime's
// default, or a bounded token. Which levels a model takes is the database's to
// check (0111), and it refuses the rest by name.
function reasoningLevel(value: unknown, name = "reasoningEffort") {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) throw new Error(`${name} is invalid`);
  return value;
}

// Each executor's level, keyed by its model and returned in the models' order.
function executorReasoningLevels(value: unknown, entryIds: string[]) {
  if (value === undefined || value === null) return entryIds.map(() => "");
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("executorReasoningEfforts is invalid");
  return entryIds.map((id) => reasoningLevel((value as Record<string, unknown>)[id], "executorReasoningEffort"));
}

async function ownedVerifiedCatalogEntries(ownerId: string, entryIds: string[]) {
  if (!entryIds.length) return "";
  const result = await executeJson(
    `WITH requested AS (SELECT jsonb_array_elements_text(:'ids'::jsonb)::uuid id)
     SELECT jsonb_build_object('valid',count(*)=:'count'::integer)::text
     FROM requested r JOIN provider_model_catalog m ON m.id=r.id
     JOIN provider_connections c ON c.id=m.connection_id
     WHERE m.status='verified' AND m.operator_id=:'owner_id'::uuid AND c.status='connected';`,
    { ids: JSON.stringify(entryIds), count: String(entryIds.length), owner_id: ownerId },
  );
  if (result?.valid !== true) throw new Error("One or more selected models are not available for this account");
  return entryIds.join(",");
}

async function executorProfiles(value: unknown) {
  if (value !== undefined && !Array.isArray(value)) throw new Error("executorProfileIds is invalid");
  const requested = [...new Set((value as unknown[] | undefined)?.map((item) => uuid(item, "executorProfileId")) ?? [])];
  if (requested.length > 8) throw new Error("No more than eight executor profiles can be selected");
  if (value === undefined) {
    const fallback = await executeJson(
      `SELECT jsonb_build_object('ids',COALESCE(jsonb_agg(id),'[]'::jsonb))::text FROM (
         SELECT DISTINCT ON (runtime_type,provider_type,model) id,runtime_type,provider_type,model,last_verified_at,created_at
          FROM runtime_profiles WHERE enabled AND last_verified_at IS NOT NULL
            AND runtime_type IN ('opencode','antigravity')
         ORDER BY runtime_type,provider_type,model,last_verified_at DESC NULLS LAST,created_at,id
       ) profiles;`,
      {},
    );
    return Array.isArray(fallback?.ids) ? fallback.ids.map(String) : [];
  }
  if (!requested.length) return [];
  const validated = await executeJson(
    `WITH requested AS (SELECT jsonb_array_elements_text(:'ids'::jsonb)::uuid id)
     SELECT jsonb_build_object('valid',count(*)=:'count'::integer)::text
     FROM requested r JOIN runtime_profiles rp ON rp.id=r.id
      WHERE rp.enabled AND rp.last_verified_at IS NOT NULL
        AND rp.runtime_type IN ('opencode','antigravity');`,
    { ids: JSON.stringify(requested), count: String(requested.length) },
  );
  if (validated?.valid !== true) throw new Error("One or more executor runtime profiles are unavailable");
  return requested;
}

// The runtime of each selected catalog entry, in the order given. The
// structural profile of an assignment is its runtime's, and a turn is run by
// the runtime its assignment's profile names (complete_orchestrator_job,
// orchestrator_job_context) — so the profile follows the model the operator
// picked, never a runtime assumed here. An OpenCode orchestrator on a Codex
// profile would have handed an OpenCode model to Codex.
async function catalogRuntimes(ownerId: string, entryIds: string[]) {
  if (!entryIds.length) return [];
  const result = await executeJson(
    `WITH requested AS (
       SELECT r.id::uuid id, r.ordinality FROM jsonb_array_elements_text(:'ids'::jsonb) WITH ORDINALITY r(id,ordinality))
     SELECT jsonb_build_object('runtimes',COALESCE(jsonb_agg(m.runtime_type ORDER BY r.ordinality),'[]'::jsonb))::text
     FROM requested r JOIN provider_model_catalog m ON m.id=r.id AND m.operator_id=:'owner_id'::uuid;`,
    { ids: JSON.stringify(entryIds), owner_id: ownerId },
  );
  const runtimes = Array.isArray(result?.runtimes) ? result.runtimes.map(String) : [];
  if (runtimes.length !== entryIds.length) throw new Error("One or more selected models are not available for this account");
  return runtimes as ("codex" | "opencode")[];
}

async function structuralProfiles(ownerId: string, entryIds: string[]) {
  const runtimes = await catalogRuntimes(ownerId, entryIds);
  const byRuntime = new Map<string, string>();
  for (const runtime of runtimes) {
    if (!byRuntime.has(runtime)) byRuntime.set(runtime, await structuralProfile(ownerId, runtime));
  }
  return runtimes.map((runtime) => byRuntime.get(runtime) as string);
}

function taskTitle(message: string, value: unknown) {
  if (typeof value === "string" && value.trim().length >= 2) return text(value, "title", 2, 120);
  const firstLine = message.split("\n").find((line) => line.trim())?.trim() ?? "New task";
  if (firstLine.length <= 80) return firstLine;
  // The chat's title is the pull request's: its first sentence when that is
  // short, else cut at a word — not "…one JSON objec…" (the first clean install).
  const sentence = /^(.{8,80}?)[.:!?](\s|$)/.exec(firstLine)?.[1];
  if (sentence) return sentence;
  const cut = firstLine.slice(0, 78);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 40)).trimEnd()}…`;
}

async function ownedProjectForAction(kind: string, body: Record<string, unknown>, ownerId: string) {
  if (kind === "create_project" || kind.startsWith("github_") || kind.startsWith("codex_")
      || kind.startsWith("opencode_") || kind.startsWith("claude_") || kind.startsWith("telegram_") || kind.startsWith("offsite_") || kind === "catalog_refresh"
      || kind === "model_pin" || kind === "model_unpin"
      || kind === "model_check" || kind === "runtime_update") return "";
  let sql: string;
  let id: string;
  if (kind === "approval") {
    id = uuid(body.id,"id");
    sql = `SELECT jsonb_build_object('project_id',p.id)::text FROM approvals a
      JOIN projects p ON p.id=a.project_id WHERE a.id=:'id'::uuid AND p.owner_id=:'owner_id'::uuid;`;
  } else if (kind === "interaction") {
    id = uuid(body.id,"id");
    sql = `SELECT jsonb_build_object('project_id',p.id)::text FROM worker_interaction_reports r
      JOIN projects p ON p.id=r.project_id WHERE r.id=:'id'::uuid AND p.owner_id=:'owner_id'::uuid;`;
  } else if (kind === "incident" || kind === "dead_letter_retry" || kind === "dead_letter_dismiss") {
    if (typeof body.id !== "string" || !/^\d+$/.test(body.id)) throw new Error("id is invalid");
    id = body.id;
    sql = `SELECT jsonb_build_object('project_id',p.id)::text FROM runtime_jobs j
      JOIN projects p ON p.id=j.project_id WHERE j.id=:'id'::bigint AND p.owner_id=:'owner_id'::uuid;`;
  } else if (kind === "publish_request") {
    // Sprint B P1: the project is the prepared publish's, as the card showed it.
    id = uuid(body.id,"id");
    sql = `SELECT jsonb_build_object('project_id',p.id)::text FROM publish_preparations pp
      JOIN projects p ON p.id=pp.project_id WHERE pp.id=:'id'::uuid AND p.owner_id=:'owner_id'::uuid;`;
  } else if (kind === "publish_retry") {
    id = uuid(body.id,"id");
    sql = `SELECT jsonb_build_object('project_id',p.id)::text FROM publish_intents i
      JOIN projects p ON p.id=i.project_id WHERE i.id=:'id'::uuid AND p.owner_id=:'owner_id'::uuid;`;
  } else if (kind === "issue_start" || kind === "issue_dismiss") {
    // 0132: an issue waiting in one of the owner's projects.
    id = uuid(body.linkId,"linkId");
    sql = `SELECT jsonb_build_object('project_id',p.id)::text FROM issue_links l
      JOIN projects p ON p.id=l.project_id WHERE l.id=:'id'::uuid AND p.owner_id=:'owner_id'::uuid;`;
  } else if (kind === "unarchive_project") {
    // 0120: only an archived project can be restored.
    id = uuid(body.projectId,"projectId");
    sql = `SELECT jsonb_build_object('project_id',id)::text FROM projects
      WHERE id=:'id'::uuid AND owner_id=:'owner_id'::uuid AND status='archived';`;
  } else if (kind === "delete_project_now" || kind === "undo_delete_project" || kind === "retry_project_cleanup") {
    id = uuid(body.projectId,"projectId");
    sql = `SELECT jsonb_build_object('project_id',id)::text FROM projects
      WHERE id=:'id'::uuid AND owner_id=:'owner_id'::uuid
        AND status IN ('deleting','deletion_failed');`;
  } else {
    id = uuid(body.projectId,"projectId");
    sql = `SELECT jsonb_build_object('project_id',id)::text FROM projects
      WHERE id=:'id'::uuid AND owner_id=:'owner_id'::uuid
        AND status NOT IN ('archived','deleting','deletion_failed','deleted');`;
  }
  const owned = await executeJson(sql,{ id, owner_id: ownerId });
  if (!owned) throw new Error("Project resource is unavailable");
  return String(owned.project_id);
}

async function appRepository(operatorId: string, fullName: string) {
  const { getOperatorGitHubConnections } = await import("@/lib/github-connections");
  for (const connection of await getOperatorGitHubConnections(operatorId)) {
    if (connection.status !== "connected") continue;
    const rows = await executeJson(
      `SELECT list_operator_github_repositories(:'operator_id'::uuid,:'connection_id'::uuid,:'search',20)::text;`,
      { operator_id: operatorId, connection_id: connection.connectionId, search: fullName },
    );
    const match = (Array.isArray(rows) ? rows : []).find((row) =>
      String((row as Record<string, unknown>).full_name ?? "").toLowerCase() === fullName.toLowerCase());
    if (match) return { connectionId: connection.connectionId, githubRepositoryId: String((match as Record<string, unknown>).github_repository_id) };
  }
  return null;
}

export async function performControlPlaneAction(body: Record<string, unknown>, operator: Operator) {
  const kind = text(body.kind, "kind", 3, 32);
  // The local operator record is the actor now: there is no separate Supabase
  // identity to name, and audit entries are keyed by this user id anyway.
  const actor = operator.userId;
  const ownedProjectId = await ownedProjectForAction(kind,body,operator.userId);
  const correlation = randomUUID();

  if (kind === "create_project") {
    const id = randomUUID();
    const name = projectName(body.name);
    const repo = repository(body.repository);
    const branch = text(body.defaultBranch ?? "main", "defaultBranch", 1, 100);
    let providerConnectionId = body.providerConnectionId === undefined ? "" : uuid(body.providerConnectionId, "providerConnectionId");
    let githubRepositoryId = typeof body.githubRepositoryId === "string" && /^\d+$/.test(body.githubRepositoryId) ? body.githubRepositoryId : "";
    if ((providerConnectionId && !githubRepositoryId) || (githubRepositoryId && !providerConnectionId)) {
      throw new Error("GitHub repository selection is incomplete");
    }
    // A URL of a repository the GitHub App already reaches is that repository
    // (Stage 12 G1). Taken as a URL, the project could clone and never publish:
    // a publish goes through the App, and a deploy-key project has none — which
    // is where the battle test's first project ended up.
    if (repo && !githubRepositoryId) {
      const fullName = repo.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");
      const found = await appRepository(operator.userId, fullName);
      if (found) ({ connectionId: providerConnectionId, githubRepositoryId } = found);
    }
    const credentialMode = githubRepositoryId ? "github_app" : repo ? "deploy_key" : "empty";
    const slug = `${projectSlug(name)}-${id.slice(0, 8)}`;
    const workspaceRoot = (process.env.CONTROL_PLANE_WORKSPACE_ROOT ?? "/srv/infra-cod/workspaces").replace(/\/$/, "");
    const workspace = `${workspaceRoot}/${id}`;
    const orchestratorEntryId = await catalogEntry(body.orchestratorEntryId, "orchestratorEntryId");
    const executorEntryIds = await catalogExecutorEntries(body.executorEntryIds);
    // A catalog selection carries the runtime and the model; the profile is
    // structure, and structure is made rather than looked for. Without a catalog
    // entry the old path stands, because then the profile *is* the selection.
    const orchestratorProfileId = orchestratorEntryId
      ? (await structuralProfiles(operator.userId, [orchestratorEntryId]))[0]
      : await orchestratorProfile(body.orchestratorProfileId);
    const executorProfileIds = orchestratorEntryId
      ? await structuralProfiles(operator.userId, executorEntryIds)
      : await executorProfiles(body.executorProfileIds);
    if (!executorEntryIds.length && orchestratorEntryId) {
      throw new Error("Select at least one executor");
    }
    if (!executorProfileIds.length) {
      throw new Error("Select at least one executor");
    }
    const reasoningEffort = reasoningLevel(body.reasoningEffort);
    const executorReasoningEfforts = executorReasoningLevels(body.executorReasoningEfforts, executorEntryIds);
    const serviceTier = typeof body.serviceTier === "string" ? body.serviceTier.slice(0, 64) : "";
    if (orchestratorEntryId) {
      await ownedVerifiedCatalogEntries(operator.userId, [orchestratorEntryId, ...executorEntryIds]);
    }
    const provisioningSource = credentialMode === "github_app" || repo ? "clone" : "empty";
    const settings = JSON.stringify({ provisioning_status: "pending", provisioning_source: provisioningSource, requested_repository: repo || null, agent_roster_configured: true });
    const result = await executeJson(
      `SELECT create_project_with_roster(
         :'project_id'::uuid,:'owner_id'::uuid,:'name',:'slug',:'workspace',
         :'repository',:'branch',:'settings'::jsonb,:'credential_mode',
         :'orchestrator_profile_id'::uuid,:'executor_profile_ids'::jsonb,
         :'actor',:'correlation',
         NULLIF(:'provider_connection_id','')::uuid,
         NULLIF(:'github_repository_id','')::bigint)::text;`,
      { actor, owner_id: operator.userId, project_id: id, name, slug, workspace,
        repository: repo, branch, settings, correlation,
        orchestrator_profile_id: orchestratorProfileId,
        executor_profile_ids: JSON.stringify(executorProfileIds),
        provider_connection_id: providerConnectionId,
        github_repository_id: githubRepositoryId, credential_mode: credentialMode },
    );
    if (!result) throw new Error("Project agent roster could not be created");
    if (credentialMode === "github_app" && !result.repository_full_name) {
      throw new Error("The selected GitHub repository is no longer available to the GitHub App.");
    }
    if (orchestratorEntryId) {
      const defaults = await executeJson(
        `SELECT set_project_runtime_defaults(
          :'project_id'::uuid,:'owner_id'::uuid,1,
          :'orchestrator_entry_id'::uuid,
          CASE WHEN :'executor_entry_ids'='' THEN NULL ELSE string_to_array(:'executor_entry_ids',',')::uuid[] END,
          :'reasoning_effort',:'service_tier',:'actor',:'correlation',
          ARRAY(SELECT jsonb_array_elements_text(:'executor_reasoning_efforts'::jsonb))
        )::text;`,
        {
          project_id: id, owner_id: operator.userId,
          orchestrator_entry_id: orchestratorEntryId,
          executor_entry_ids: executorEntryIds.join(","),
          reasoning_effort: reasoningEffort, service_tier: serviceTier,
          executor_reasoning_efforts: JSON.stringify(executorReasoningEfforts),
          actor, correlation,
        },
      );
      if (!defaults) throw new Error("Project runtime defaults could not be saved");
      result.runtime_defaults = defaults;
    }
    return result;
  }

  // Connect authorises an App already installed; install opens GitHub's
  // installation page, where an App is installed or given more repositories
  // (Stage 12 G1). Both come back to the callback with this state.
  if (kind === "github_connect" || kind === "github_reconnect" || kind === "github_install") {
    const { generateLoginState, stateDigest, buildGitHubAuthorizationUrl, buildGitHubInstallUrl, getGitHubAppConfig } = await import("@/lib/github-connections");
    const app = await getGitHubAppConfig();
    if (!app) throw new Error("Create the GitHub App first");
    const state = generateLoginState();
    const digest = stateDigest(state);
    await executeJson(
      `SELECT jsonb_build_object(
         'session_id',start_provider_login_session(:'operator_id'::uuid,'github',:'state_digest',interval '10 minutes')
       )::text;`,
      { operator_id: operator.userId, state_digest: digest },
    );
    const installUrl = kind === "github_install" ? buildGitHubInstallUrl(state, app.slug) : buildGitHubAuthorizationUrl(state, app.clientId);
    return { install_url: installUrl };
  }

  // Qualify and Promote from Settings → Runtimes (0127): a request the host's
  // update pass runs with the CLI's own code, as root, within five minutes.
  if (kind === "runtime_update") {
    const runtime = text(body.runtime, "runtime", 3, 32);
    const version = text(body.version, "version", 5, 32);
    const updateKind = body.updateKind === "promote" ? "promote" : body.updateKind === "qualify" ? "qualify" : "";
    if (!updateKind) throw new Error("Choose qualify or promote");
    return executeJson(
      `SELECT request_runtime_update(:'operator_id'::uuid,:'runtime',:'version',:'kind')::text;`,
      { operator_id: operator.userId, runtime, version, kind: updateKind },
    );
  }

  // The GitHub App from the settings page (Stage 12 G1): a state for the
  // manifest's round trip, and the manifest the page posts to GitHub.
  if (kind === "github_app_create") {
    const { generateLoginState, stateDigest, buildGitHubAppManifest, gitHubAppCreationUrl, getGitHubAppConfig } = await import("@/lib/github-connections");
    const { authSiteUrl } = await import("@/lib/auth");
    if (await getGitHubAppConfig()) throw new Error("A GitHub App is already configured for this panel");
    const organization = typeof body.organization === "string" ? body.organization.trim() : "";
    if (organization && !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(organization)) throw new Error("That is not a GitHub organization name");
    const state = generateLoginState();
    await executeJson(
      `SELECT start_github_app_manifest(:'operator_id'::uuid,:'state_digest',NULLIF(:'organization',''))::text;`,
      { operator_id: operator.userId, state_digest: stateDigest(state), organization },
    );
    return { post_url: gitHubAppCreationUrl(state, organization), manifest: JSON.stringify(buildGitHubAppManifest(authSiteUrl())) };
  }

  if (kind === "github_disconnect") {
    const connectionId = uuid(body.connectionId, "connectionId");
    return executeJson(
      `SELECT disconnect_github_connection(:'connection_id'::uuid,:'operator_id'::uuid,:'correlation')::text;`,
      { connection_id: connectionId, operator_id: operator.userId, correlation },
    );
  }

  if (kind === "github_verify") {
    const connectionId = uuid(body.connectionId, "connectionId");
    return executeJson(
      `SELECT request_github_verify(:'connection_id'::uuid,:'operator_id'::uuid,:'correlation')::text;`,
      { connection_id: connectionId, operator_id: operator.userId, correlation },
    );
  }

  if (kind === "codex_connect" || kind === "codex_reconnect") {
    return executeJson(
      `SELECT start_codex_device_login(
        :'operator_id'::uuid,:'correlation',interval '15 minutes'
      )::text;`,
      { operator_id: operator.userId, correlation },
    );
  }

  if (kind === "codex_verify" || kind === "codex_disconnect") {
    const connectionId = uuid(body.connectionId, "connectionId");
    return executeJson(
      `SELECT request_codex_connection_action(
        :'connection_id'::uuid,:'operator_id'::uuid,:'action',:'correlation'
      )::text;`,
      {
        connection_id: connectionId,
        operator_id: operator.userId,
        action: kind === "codex_verify" ? "verify" : "disconnect",
        correlation,
      },
    );
  }

  if (kind === "opencode_connect" || kind === "opencode_reconnect") {
    // Which API-key gateway: OpenCode Go or OpenRouter (0083). The provider
    // OpenCode signs in to follows from the gateway on the VPS; nothing the
    // browser sends names a provider.
    const accessGateway = body.accessGateway === undefined ? "opencode_go" : body.accessGateway;
    if (accessGateway !== "opencode_go" && accessGateway !== "openrouter") {
      throw new Error("accessGateway is invalid");
    }
    return executeJson(
      `SELECT start_opencode_enrollment(
        :'operator_id'::uuid,:'billing_boundary',:'correlation',interval '15 minutes'
      )::text;`,
      { operator_id: operator.userId, billing_boundary: accessGateway, correlation },
    );
  }

  if (kind === "opencode_store_enrollment") {
    const enrollmentId = uuid(body.enrollmentId, "enrollmentId");
    const b64 = (value: unknown, name: string) => {
      if (typeof value !== "string" || value.length < 16 || !/^[A-Za-z0-9+/=]+$/.test(value)) {
        throw new Error(`${name} is invalid`);
      }
      return value;
    };
    const keyFingerprint = typeof body.keyFingerprint === "string" ? body.keyFingerprint.slice(0, 64) : "";
    return executeJson(
      `SELECT store_opencode_enrollment_secret(
        :'enrollment_id'::uuid,:'operator_id'::uuid,
        :'ciphertext',:'iv',:'tag',:'key_wrap',:'key_fingerprint'
      )::text;`,
      {
        enrollment_id: enrollmentId,
        operator_id: operator.userId,
        ciphertext: b64(body.ciphertext, "ciphertext"),
        iv: b64(body.iv, "iv"),
        tag: b64(body.tag, "tag"),
        key_wrap: b64(body.keyWrap, "keyWrap"),
        key_fingerprint: keyFingerprint,
      },
    );
  }

  if (kind === "opencode_verify" || kind === "opencode_disconnect") {
    const connectionId = uuid(body.connectionId, "connectionId");
    return executeJson(
      `SELECT request_opencode_connection_action(
        :'connection_id'::uuid,:'operator_id'::uuid,:'action',:'correlation'
      )::text;`,
      {
        connection_id: connectionId,
        operator_id: operator.userId,
        action: kind === "opencode_verify" ? "verify" : "disconnect",
        correlation,
      },
    );
  }

  if (kind === "retry_provisioning") {
    const result = await executeJson(
      `SELECT retry_project_provisioning(
         :'project_id'::uuid,:'owner_id'::uuid,:'actor',:'correlation')::text;`,
      { project_id: ownedProjectId, owner_id: operator.userId, actor, correlation },
    );
    if (!result) throw new Error("Failed provisioning is no longer retryable");
    return result;
  }

  // GitHub issues as chats (0132): the settings, and a waiting issue started
  // as a chat or dismissed. Each function checks the owner again.
  if (kind === "issue_intake_set") {
    const label = text(body.label ?? "agent", "label", 1, 50);
    return await executeJson(
      `SELECT set_issue_intake(:'project_id'::uuid,:'owner_id'::uuid,:'enabled'::boolean,:'label',:'actor')::text;`,
      { project_id: ownedProjectId, owner_id: operator.userId, enabled: String(body.enabled === true), label, actor },
    );
  }
  if (kind === "issue_start") {
    return await executeJson(
      `SELECT start_issue_chat(:'link_id'::uuid,:'owner_id'::uuid,:'actor',:'correlation')::text;`,
      { link_id: uuid(body.linkId, "linkId"), owner_id: operator.userId, actor, correlation },
    );
  }
  if (kind === "issue_dismiss") {
    return await executeJson(
      `SELECT dismiss_issue(:'link_id'::uuid,:'owner_id'::uuid,:'actor')::text;`,
      { link_id: uuid(body.linkId, "linkId"), owner_id: operator.userId, actor },
    );
  }

  if (kind === "create_task") {
    const projectId = ownedProjectId;
    const taskId = randomUUID();
    const message = messageText(body.message);
    const title = taskTitle(message, body.title);
    const orchestratorAssignmentId = body.orchestratorAssignmentId === undefined ? "" : uuid(body.orchestratorAssignmentId, "orchestratorAssignmentId");
    if (body.executorAssignmentIds !== undefined && !Array.isArray(body.executorAssignmentIds)) throw new Error("executorAssignmentIds is invalid");
    const executorSelectionExplicit = body.executorAssignmentIds !== undefined;
    const executorAssignmentIds = [...new Set((body.executorAssignmentIds as unknown[] | undefined)?.map((item) => uuid(item, "executorAssignmentId")) ?? [])];
    const result = await executeJson(
      `SELECT create_task_with_executors(
         :'project_id'::uuid,:'task_id'::uuid,:'title',:'message',:'actor',:'correlation',
         NULLIF(:'orchestrator_assignment_id','')::uuid,
         :'executor_assignment_ids'::jsonb,
         :'executor_selection_explicit'::boolean)::text;`,
      { project_id: projectId, task_id: taskId, title, message, actor, correlation,
        orchestrator_assignment_id: orchestratorAssignmentId,
        executor_assignment_ids: JSON.stringify(executorAssignmentIds),
        executor_selection_explicit: String(executorSelectionExplicit) },
    );
    if (!result) throw new Error("The selected task orchestrator is unavailable");
    return result;
  }

  if (kind === "create_followup") {
    const sourceTaskId = uuid(body.sourceTaskId, "sourceTaskId");
    const sourceVersion = version(body.taskVersion);
    const message = messageText(body.message);
    const title = taskTitle(message, body.title);
    const result = await executeJson(
      `SELECT create_followup_task(
        :'project_id'::uuid,:'source_task_id'::uuid,:'new_task_id'::uuid,
        :'actor',:'title',:'message',:'key',:'version'::bigint,:'correlation'
      )::text;`,
      { project_id: ownedProjectId, source_task_id: sourceTaskId, new_task_id: randomUUID(),
        actor, title, message, key: `web-followup:${sourceTaskId}:${sourceVersion}`,
        version: String(sourceVersion), correlation },
    );
    if (!result) throw new Error("The follow-up task could not be created");
    return result;
  }

  if (kind === "chat_message") {
    const projectId = ownedProjectId;
    const taskId = uuid(body.taskId, "taskId");
    const message = messageText(body.message);
    const result = await executeJson(
      `SELECT record_task_chat_message(
         :'project_id'::uuid,:'task_id'::uuid,:'message',:'actor',:'correlation')::text;`,
      { project_id: projectId, task_id: taskId, message, actor, correlation },
    );
    if (!result) throw new Error("This task is closed. Start a linked follow-up instead.");
    return result;
  }

  if (kind === "approval") {
    const decision = body.decision === "approved" || body.decision === "denied" ? body.decision : null;
    if (!decision) throw new Error("decision is invalid");
    return executeJson(
      `SELECT decide_approval(:'id'::uuid,:'actor',:'decision',:'reason',:'correlation')::text;`,
      { id: uuid(body.id, "id"), actor, decision, reason: text(body.reason ?? "Operator decision", "reason", 3, 500), correlation },
    );
  }
  if (kind === "review_approve") {
    const taskId = uuid(body.taskId, "taskId");
    const approved = await executeJson(
      `SELECT approve_task_review(:'project_id'::uuid,:'task_id'::uuid,:'actor',:'summary',:'key',:'version'::bigint,:'correlation')::text;`,
      { project_id: ownedProjectId, task_id: taskId, actor,
        summary: text(body.summary, "summary", 3, 2000), key: `web-approve:${taskId}:${version(body.taskVersion)}`,
        version: String(version(body.taskVersion)), correlation },
    );
    if (body.publish !== true) return approved;
    // "Approve & open PR" (0138): the same click asks for the publish. A
    // refusal is answered, not raised, so the approval stands and the Publish
    // card asks again.
    const publish = await executeJson(
      `SELECT request_publish_on_approval(:'project_id'::uuid,:'task_id'::uuid,:'owner_id'::uuid,:'actor',:'correlation')::text;`,
      { project_id: ownedProjectId, task_id: taskId, owner_id: operator.userId, actor, correlation },
    );
    return { ...(approved as Record<string, unknown>), publish };
  }
  if (kind === "revision") {
    const taskId = uuid(body.taskId, "taskId");
    const changes = text(body.changes, "changes", 3, 4000);
    const criteria = Array.isArray(body.acceptanceCriteria) ? body.acceptanceCriteria : [];
    const result = await executeJson(
      `SELECT request_revision(:'project_id'::uuid,:'task_id'::uuid,:'reviewer_id'::uuid,
        :'changes'::jsonb,:'criteria'::jsonb,:'key',:'version'::bigint,:'correlation')::text
       FROM tasks WHERE id=:'task_id'::uuid AND project_id=:'project_id'::uuid
         AND status='awaiting_review' AND version=:'version'::bigint;`,
      { project_id: ownedProjectId, task_id: taskId,
        reviewer_id: uuid(body.reviewerAgentId, "reviewerAgentId"), changes: JSON.stringify([changes]),
        criteria: JSON.stringify(criteria), key: `web-revision:${taskId}:${version(body.taskVersion)}`,
        version: String(version(body.taskVersion)), correlation },
    );
    if (!result) throw new Error("The review has already moved forward. Refresh the current task state.");
    return result;
  }
  if (kind === "interaction") {
    return executeJson(
      `SELECT resolve_worker_interaction(:'id'::uuid,:'actor',:'response'::jsonb,:'correlation')::text;`,
      { id: uuid(body.id, "id"), actor, response: JSON.stringify({ response: text(body.response, "response", 2, 4000) }), correlation },
    );
  }
  if (kind === "incident") {
    const id = typeof body.id === "string" && /^\d+$/.test(body.id) ? body.id : "";
    if (!id) throw new Error("id is invalid");
    return executeJson(`SELECT resolve_runtime_job_incident(:'id'::bigint,:'actor',:'resolution',:'correlation')::text;`,
      { id, actor, resolution: text(body.resolution, "resolution", 8, 2000), correlation });
  }
  // A dead letter's two answers (0072). The attempt is the one the card showed:
  // a second click on the same card is the same answer, and a card left open
  // across a later death is refused rather than applied to it.
  if (kind === "dead_letter_retry" || kind === "dead_letter_dismiss") {
    const id = typeof body.id === "string" && /^\d+$/.test(body.id) ? body.id : "";
    if (!id) throw new Error("id is invalid");
    if (!Number.isInteger(body.attempt) || Number(body.attempt) < 0) throw new Error("attempt is invalid");
    const retry = kind === "dead_letter_retry";
    const note = retry
      ? (typeof body.note === "string" && body.note.trim().length >= 3 ? text(body.note, "note", 3, 2000) : "Retried from the control panel")
      : text(body.note, "note", 8, 2000);
    return executeJson(
      `SELECT ${retry ? "retry_dead_letter_job" : "dismiss_dead_letter_job"}(
        :'id'::bigint,:'attempt'::integer,:'owner_id'::uuid,:'actor',:'note',:'correlation')::text;`,
      { id, attempt: String(body.attempt), owner_id: operator.userId, actor, note, correlation },
    );
  }
  // Sprint B P1: the operator's publish of a prepared commit, and the retry of
  // one that stopped. Each checks the owner itself; the retry answers the
  // attempt the card showed.
  if (kind === "publish_request") {
    return executeJson(
      `SELECT request_publish(:'id'::uuid,:'owner_id'::uuid,:'actor',:'correlation')::text;`,
      { id: uuid(body.id, "id"), owner_id: operator.userId, actor, correlation },
    );
  }
  if (kind === "publish_retry") {
    if (!Number.isInteger(body.attempt) || Number(body.attempt) < 0) throw new Error("attempt is invalid");
    return executeJson(
      `SELECT retry_publish_intent(:'id'::uuid,:'attempt'::integer,:'owner_id'::uuid,:'actor',:'correlation')::text;`,
      { id: uuid(body.id, "id"), attempt: String(body.attempt), owner_id: operator.userId, actor, correlation },
    );
  }
  if (kind === "interrupt") {
    const taskId = uuid(body.taskId, "taskId");
    return executeJson(
      `SELECT request_runtime_interrupt(:'project_id'::uuid,:'task_id'::uuid,:'actor',:'reason',:'correlation')::text;`,
      { project_id: ownedProjectId, task_id: taskId, actor,
        reason: text(body.reason ?? "Interrupted by operator", "reason", 3, 500), correlation },
    );
  }
  if (kind === "workspace_operation") {
    const operationType = body.operationType === "recover_lock" || body.operationType === "restore_owner"
      ? body.operationType : null;
    if (!operationType) throw new Error("operationType is invalid");
    return executeJson(
      `SELECT request_workspace_operation(:'project_id'::uuid,:'operation_type',:'actor',:'reason',:'correlation')::text;`,
      { project_id: ownedProjectId, operation_type: operationType, actor,
        reason: text(body.reason, "reason", 3, 500), correlation },
    );
  }

  if (kind === "catalog_refresh") {
    const connectionId = body.connectionId === undefined || body.connectionId === ""
      ? "" : uuid(body.connectionId, "connectionId");
    const result = await executeJson(
      `WITH owned_connections AS (
         SELECT c.id FROM provider_connections c
         WHERE c.operator_id=:'owner_id'::uuid
           AND c.connection_kind='model_access'
           AND c.status='connected'
           AND (:'connection_id'='' OR c.id=:'connection_id'::uuid)
       ), requested AS (
         SELECT request_catalog_refresh(id,:'owner_id'::uuid,'settings_refresh') AS result
         FROM owned_connections
       )
       SELECT jsonb_build_object('refreshes',COALESCE(jsonb_agg(result),'[]'::jsonb))::text
       FROM requested;`,
      { owner_id: operator.userId, connection_id: connectionId },
    );
    return result ?? { refreshes: [] };
  }

  // Stage 12 W7 (docs/W6_W7_CONTRACT.md): a pin, an unpin and a check are the
  // operator's own; the database checks the entry is theirs (42501) and the
  // day's ceiling (54000), and a check already queued is returned, not repeated.
  if (kind === "model_pin" || kind === "model_unpin") {
    return pinModel(operator.userId, uuid(body.entryId, "entryId"), kind === "model_pin");
  }
  if (kind === "model_check") {
    const trigger = body.trigger;
    if (trigger !== "pick" && trigger !== "pin" && trigger !== "check_again") throw new Error("trigger is invalid");
    return requestModelCheck(operator.userId, uuid(body.entryId, "entryId"), trigger);
  }

  // Sprint C K2: the operator's Claude subscription, signed in on the host,
  // connected for the team — or disconnected, which dispatch reads as revoked.
  // 0140: Telegram notifications. The token arrives as the broker envelope
  // the browser made (as OpenCode keys do) and is never read back here.
  if (kind === "telegram_set") {
    const b64 = (value: unknown, name: string) => {
      if (typeof value !== "string" || value.length < 16 || value.length > 8192 || !/^[A-Za-z0-9+/=]+$/.test(value)) {
        throw new Error(`${name} is invalid`);
      }
      return value;
    };
    return executeJson(`SELECT set_telegram_bot(:'owner_id'::uuid,:'envelope'::jsonb)::text;`, {
      owner_id: operator.userId,
      envelope: JSON.stringify({ ciphertext: b64(body.ciphertext, "ciphertext"), iv: b64(body.iv, "iv"),
        tag: b64(body.tag, "tag"), key_wrap: b64(body.keyWrap, "keyWrap") }),
    });
  }
  // 0141: where the off-site backups go. The secret key arrives as the broker
  // envelope the browser made, like the Telegram token.
  if (kind === "offsite_set") {
    const b64 = (value: unknown, name: string) => {
      if (typeof value !== "string" || value.length < 16 || value.length > 8192 || !/^[A-Za-z0-9+/=]+$/.test(value)) throw new Error(`${name} is invalid`);
      return value;
    };
    return executeJson(`SELECT set_offsite_backup(:'owner_id'::uuid,:'endpoint',:'bucket',:'key_id',:'envelope'::jsonb)::text;`, {
      owner_id: operator.userId,
      endpoint: text(body.endpoint, "endpoint", 12, 300),
      bucket: text(body.bucket, "bucket", 3, 63),
      key_id: text(body.accessKeyId, "accessKeyId", 16, 128),
      envelope: JSON.stringify({ ciphertext: b64(body.ciphertext, "ciphertext"), iv: b64(body.iv, "iv"), tag: b64(body.tag, "tag"), key_wrap: b64(body.keyWrap, "keyWrap") }),
    });
  }
  // 0143: the project's check command, run by the platform after each
  // implementation. Owner-only, checked by the function; an empty command
  // turns the check off.
  if (kind === "project_check_set") {
    const command = typeof body.command === "string" ? body.command.trim() : "";
    if (command.length > 500 || /[\r\n]/.test(command)) throw new Error("The check command is one line of at most 500 characters");
    const timeout = Number(body.timeoutSeconds);
    if (!Number.isInteger(timeout)) throw new Error("timeoutSeconds is invalid");
    return executeJson(`SELECT set_project_check(:'project_id'::uuid,:'owner_id'::uuid,:'command',:'timeout'::integer)::text;`, {
      project_id: ownedProjectId, owner_id: operator.userId, command,
      timeout: String(timeout),
    });
  }
  // 0145: bring the workspace up to date with GitHub now, or reset it to
  // GitHub after a sync said they diverged (local commits go to a backup
  // branch). Owner-only, checked by the function.
  if (kind === "workspace_sync") {
    const mode = body.mode === "reset" ? "reset" : "sync";
    return executeJson(`SELECT request_workspace_sync(:'project_id'::uuid,:'owner_id'::uuid,:'mode')::text;`,
      { project_id: ownedProjectId, owner_id: operator.userId, mode });
  }
  if (kind === "offsite_disable") {
    return executeJson(`SELECT disable_offsite_backup(:'owner_id'::uuid)::text;`, { owner_id: operator.userId });
  }
  if (kind === "telegram_disconnect") {
    return executeJson(`SELECT disconnect_telegram(:'owner_id'::uuid)::text;`, { owner_id: operator.userId });
  }
  if (kind === "telegram_test") {
    return executeJson(`SELECT send_telegram_test(:'owner_id'::uuid)::text;`, { owner_id: operator.userId });
  }

  if (kind === "claude_connect") {
    return executeJson(`SELECT connect_claude_connection(:'owner_id'::uuid,:'actor',:'correlation')::text;`,
      { owner_id: operator.userId, actor, correlation });
  }
  // rc.123 (0136): the sign-in itself, from the panel. Start runs
  // `claude auth login` on the host; the code the owner pastes goes to that
  // process, through the account worker, and is never read back.
  if (kind === "claude_login_start") {
    return executeJson(`SELECT start_claude_login(:'owner_id'::uuid)::text;`, { owner_id: operator.userId });
  }
  if (kind === "claude_login_code") {
    if (typeof body.code !== "string" || body.code.length > 512) throw new Error("code is invalid");
    return executeJson(`SELECT submit_claude_login_code(:'owner_id'::uuid,:'session_id'::uuid,:'code')::text;`,
      { owner_id: operator.userId, session_id: uuid(body.sessionId, "sessionId"), code: body.code });
  }
  if (kind === "claude_disconnect") {
    return executeJson(`SELECT disconnect_claude_connection(:'owner_id'::uuid,:'connection_id'::uuid,:'actor',:'correlation')::text;`,
      { owner_id: operator.userId, connection_id: uuid(body.connectionId, "connectionId"), actor, correlation });
  }

  // Sprint C U2: the Team tab's three changes. Each carries the team version
  // the tab showed; the database checks the owner, the version and every rule
  // of the team itself (0089), and refuses with the reason the tab shows.
  if (kind === "team_add_executor") {
    return executeJson(
      `SELECT add_project_executor(:'project_id'::uuid,:'owner_id'::uuid,:'version'::bigint,:'entry_id'::uuid,:'actor',:'correlation',
        :'reasoning_effort')::text;`,
      { project_id: ownedProjectId, owner_id: operator.userId, version: String(version(body.teamVersion)),
        entry_id: uuid(body.entryId, "entryId"), reasoning_effort: reasoningLevel(body.reasoningEffort), actor, correlation },
    );
  }
  if (kind === "team_change_model") {
    return executeJson(
      `SELECT change_project_assignment_model(:'project_id'::uuid,:'owner_id'::uuid,:'version'::bigint,
        :'assignment_id'::uuid,:'entry_id'::uuid,:'actor',:'correlation',
        CASE WHEN :'keep_reasoning'='true' THEN NULL ELSE :'reasoning_effort' END)::text;`,
      { project_id: ownedProjectId, owner_id: operator.userId, version: String(version(body.teamVersion)),
        assignment_id: uuid(body.assignmentId, "assignmentId"), entry_id: uuid(body.entryId, "entryId"),
        // Without a level the member keeps its own where the new model lists
        // it, and the result says when it was reset (0111).
        keep_reasoning: body.reasoningEffort === undefined ? "true" : "false",
        reasoning_effort: reasoningLevel(body.reasoningEffort), actor, correlation },
    );
  }
  // A member's reasoning level alone, its model unchanged (0111).
  if (kind === "team_set_reasoning") {
    return executeJson(
      `SELECT set_project_assignment_reasoning(:'project_id'::uuid,:'owner_id'::uuid,:'version'::bigint,
        :'assignment_id'::uuid,:'reasoning_effort',:'actor',:'correlation')::text;`,
      { project_id: ownedProjectId, owner_id: operator.userId, version: String(version(body.teamVersion)),
        assignment_id: uuid(body.assignmentId, "assignmentId"), reasoning_effort: reasoningLevel(body.reasoningEffort),
        actor, correlation },
    );
  }
  if (kind === "team_disable_executor") {
    return executeJson(
      `SELECT disable_project_executor(:'project_id'::uuid,:'owner_id'::uuid,:'version'::bigint,:'assignment_id'::uuid,:'actor',:'correlation')::text;`,
      { project_id: ownedProjectId, owner_id: operator.userId, version: String(version(body.teamVersion)),
        assignment_id: uuid(body.assignmentId, "assignmentId"), actor, correlation },
    );
  }

  // The operator closes a task it abandoned (0090): owner, version and "nothing
  // of it is running" are the database's to check.
  if (kind === "task_close") {
    return executeJson(
      `SELECT close_task(:'project_id'::uuid,:'task_id'::uuid,:'owner_id'::uuid,:'version'::bigint,:'actor',:'correlation')::text;`,
      { project_id: ownedProjectId, task_id: uuid(body.taskId, "taskId"), owner_id: operator.userId,
        version: String(version(body.taskVersion)), actor, correlation },
    );
  }

  if (kind === "set_runtime_defaults") {
    const projectId = ownedProjectId;
    const orchestratorEntryId = uuid(body.orchestratorEntryId, "orchestratorEntryId");
    const executorEntryIds = await catalogExecutorEntries(body.executorEntryIds);
    const reasoningEffort = reasoningLevel(body.reasoningEffort);
    const executorReasoningEfforts = executorReasoningLevels(body.executorReasoningEfforts, executorEntryIds);
    const serviceTier = typeof body.serviceTier === "string" ? body.serviceTier.slice(0, 64) : "";
    const expectedVersion = version(body.defaultsVersion);
    await ownedVerifiedCatalogEntries(operator.userId, [orchestratorEntryId, ...executorEntryIds]);
    return executeJson(
      `SELECT set_project_runtime_defaults(
        :'project_id'::uuid,:'owner_id'::uuid,:'expected_version'::bigint,
        :'orchestrator_entry_id'::uuid,
        CASE WHEN :'executor_entry_ids'='' THEN NULL ELSE string_to_array(:'executor_entry_ids',',')::uuid[] END,
        :'reasoning_effort',:'service_tier',:'actor',:'correlation',
        ARRAY(SELECT jsonb_array_elements_text(:'executor_reasoning_efforts'::jsonb))
      )::text;`,
      {
        project_id: projectId, owner_id: operator.userId,
        expected_version: String(expectedVersion),
        orchestrator_entry_id: orchestratorEntryId,
        executor_entry_ids: executorEntryIds.join(","),
        reasoning_effort: reasoningEffort, service_tier: serviceTier,
        executor_reasoning_efforts: JSON.stringify(executorReasoningEfforts),
        actor, correlation,
      },
    );
  }

  // The sidebar's ⋯ menu (0120): rename, archive, and restore from Settings →
  // Projects. Each is fenced on the project's version by the database.
  if (kind === "rename_project") {
    return executeJson(
      `SELECT rename_project(:'project_id'::uuid,:'owner_id'::uuid,:'version'::bigint,:'name',:'correlation')::text;`,
      { project_id: ownedProjectId, owner_id: operator.userId, version: String(version(body.projectVersion)),
        name: projectName(body.name), correlation },
    );
  }
  if (kind === "archive_project" || kind === "unarchive_project") {
    return executeJson(
      `SELECT ${kind}(:'project_id'::uuid,:'owner_id'::uuid,:'version'::bigint,:'correlation')::text;`,
      { project_id: ownedProjectId, owner_id: operator.userId, version: String(version(body.projectVersion)), correlation },
    );
  }

  if (kind === "delete_project") {
    const projectId = ownedProjectId;
    const expectedVersion = version(body.projectVersion);
    const confirmName = text(body.confirmName, "confirmName", 2, 80);
    const project = await executeJson(
      `SELECT jsonb_build_object('name',name,'slug',slug)::text FROM projects
       WHERE id=:'project_id'::uuid AND owner_id=:'owner_id'::uuid;`,
      { project_id: projectId, owner_id: operator.userId },
    );
    if (!project) throw new Error("Project resource is unavailable");
    if (confirmName !== String(project.name) && confirmName !== String(project.slug)) {
      throw new Error("Type the project name or slug to confirm deletion");
    }
    return executeJson(
      `SELECT request_project_deletion(
        :'project_id'::uuid,:'owner_id'::uuid,:'version'::bigint,:'correlation',false
      )::text;`,
      { project_id: projectId, owner_id: operator.userId, version: String(expectedVersion), correlation },
    );
  }

  if (kind === "delete_project_now") {
    const projectId = ownedProjectId;
    const expectedVersion = version(body.projectVersion);
    return executeJson(
      `SELECT approve_project_delete_now(
        :'project_id'::uuid,:'owner_id'::uuid,:'version'::bigint,:'correlation'
      )::text;`,
      { project_id: projectId, owner_id: operator.userId, version: String(expectedVersion), correlation },
    );
  }

  if (kind === "undo_delete_project") {
    const projectId = ownedProjectId;
    const expectedVersion = version(body.projectVersion);
    return executeJson(
      `SELECT undo_project_deletion(
        :'project_id'::uuid,:'owner_id'::uuid,:'version'::bigint,:'correlation'
      )::text;`,
      { project_id: projectId, owner_id: operator.userId, version: String(expectedVersion), correlation },
    );
  }

  if (kind === "retry_project_cleanup") {
    const projectId = ownedProjectId;
    const expectedVersion = version(body.projectVersion);
    return executeJson(
      `SELECT retry_project_cleanup(
        :'project_id'::uuid,:'owner_id'::uuid,:'version'::bigint,:'correlation'
      )::text;`,
      { project_id: projectId, owner_id: operator.userId, version: String(expectedVersion), correlation },
    );
  }
  throw new Error("Unsupported action kind");
}
