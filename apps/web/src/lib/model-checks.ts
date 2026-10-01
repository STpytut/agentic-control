// The database half of the Models card and the Team picker (Stage 12 W7).
//
// Each function here is one call to a function of docs/W6_W7_CONTRACT.md, with
// the operator first, as the contract takes it; the parsing is ./models.ts,
// which the client components share. The database decides everything —
// ownership (42501), the day's ceiling (54000), whether a check is already
// running — and the panel only shows the answer.
import { executeJson, hasDatabaseConnection } from "@/lib/database";
import {
  CHECK_BUDGET_WORDS, catalogSearchFromJson, modelCheckFromJson, operatorModelsFromJson,
  type CatalogFilters, type CatalogSearch, type CheckTrigger, type ModelCheck, type OperatorModels,
} from "@/lib/models";

type Json = Record<string, unknown>;

export const SEARCH_LIMIT = 50;

type PgError = { code?: unknown; detail?: unknown; message?: unknown };

function sqlState(error: unknown) {
  return error && typeof error === "object" ? String((error as PgError).code ?? "") : "";
}

// The database's refusals, in the words the card and the dialog show. The
// route turns a message containing "resource is unavailable" into a 404.
export function modelCheckError(error: unknown): Error {
  const code = sqlState(error);
  if (code === "54000") return new Error(CHECK_BUDGET_WORDS);
  if (code === "42501") return new Error("Model resource is unavailable");
  return error instanceof Error ? error : new Error("The model check request failed");
}

// The Models card: pinned, in use and small lists, per connection — or null
// without a database (the demo page).
export async function getOperatorModels(ownerId: string): Promise<OperatorModels | null> {
  if (!hasDatabaseConnection()) return null;
  const value = await executeJson(`SELECT get_operator_models(:'owner_id'::uuid)::text;`, { owner_id: ownerId });
  return value ? operatorModelsFromJson(value, new Date().toISOString()) : null;
}

export async function searchOperatorModelCatalog(ownerId: string, connectionId: string, query: string,
  filters: CatalogFilters, limit = SEARCH_LIMIT): Promise<CatalogSearch> {
  try {
    const value = await executeJson(
      `SELECT search_operator_model_catalog(:'owner_id'::uuid,:'connection_id'::uuid,:'query',:'filters'::jsonb,:'limit'::integer)::text;`,
      { owner_id: ownerId, connection_id: connectionId, query: query.slice(0, 200),
        filters: JSON.stringify({ vendor: filters.vendor || null, checked_only: filters.checkedOnly }),
        limit: String(Math.max(1, Math.min(SEARCH_LIMIT, Math.floor(limit)))) },
    );
    return catalogSearchFromJson(value);
  } catch (error) {
    throw modelCheckError(error);
  }
}

export async function getModelCheck(ownerId: string, checkId: string): Promise<ModelCheck | null> {
  try {
    const value = await executeJson(`SELECT get_model_check(:'owner_id'::uuid,:'check_id'::uuid)::text;`,
      { owner_id: ownerId, check_id: checkId });
    return value ? modelCheckFromJson(value) : null;
  } catch (error) {
    throw modelCheckError(error);
  }
}

// The three writes, called by the action route inside its transaction. They
// answer the contract's JSON as it came (the route sends it on as `result`);
// the component that asked parses it with pinResultFromJson/checkRequestFromJson.
export async function pinModel(ownerId: string, entryId: string, pinned: boolean): Promise<Json> {
  try {
    const value = await executeJson(pinned
      ? `SELECT pin_model(:'owner_id'::uuid,:'entry_id'::uuid)::text;`
      : `SELECT unpin_model(:'owner_id'::uuid,:'entry_id'::uuid)::text;`,
    { owner_id: ownerId, entry_id: entryId });
    return value ?? {};
  } catch (error) {
    throw modelCheckError(error);
  }
}

export async function requestModelCheck(ownerId: string, entryId: string, trigger: CheckTrigger): Promise<Json> {
  try {
    const value = await executeJson(`SELECT request_model_check(:'owner_id'::uuid,:'entry_id'::uuid,:'trigger')::text;`,
      { owner_id: ownerId, entry_id: entryId, trigger });
    return value ?? {};
  } catch (error) {
    throw modelCheckError(error);
  }
}
