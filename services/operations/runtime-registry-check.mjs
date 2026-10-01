// Every place that repeats what the adapter registry says, compared with it.
//
// The registry is the source (WP-5a). Some copies cannot import it: the database
// is SQL, the web tier is its own package, units and tmpfiles are systemd's
// files, the installer is shell. Each such copy is read here and compared, and
// every difference comes back as one sentence naming the file or the database
// object that has to change.
//
// Pure in the registry: both functions take the adapters as an argument. That is
// what lets a test hand them a fictional third runtime and see every place that
// does not know it yet named — the proof that adding a runtime is a checklist
// the tests write, not one somebody remembers.
//
// Not a place: the 17 web files that branch on a runtime's *behaviour* (Codex
// connects by device code, OpenCode by enrollment). Those are the runtime driver
// WP-5b introduces, and comparing them with a descriptor would test nothing.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";

import { credentialReferenceFor, sandboxPathsFor } from "./runtime-adapters.mjs";
import { LONG_RUNNING_SERVICES } from "./unit-contract.mjs";

// ---------------------------------------------------------------- the files

function read(root, relative) {
  return readFileSync(path.join(root, relative), "utf8");
}

function withoutComments(text, marker) {
  return text.split("\n").filter((line) => !line.trimStart().startsWith(marker)).join("\n");
}

function tmpfilesEntries(root) {
  const directory = path.join(root, "deploy/tmpfiles.d");
  const entries = new Map();
  for (const file of readdirSync(directory)) {
    for (const line of readFileSync(path.join(directory, file), "utf8").split("\n")) {
      const fields = line.trim().split(/\s+/);
      if (fields[0] !== "d" || fields.length < 5) continue;
      entries.set(fields[1], { mode: Number.parseInt(fields[2], 8), owner: fields[3], group: fields[4] });
    }
  }
  return entries;
}

function unitDirectives(root, unit, key) {
  const file = path.join(root, "deploy/systemd", `${unit}.service`);
  if (!existsSync(file)) return null;
  return readFileSync(file, "utf8").split("\n")
    .filter((line) => line.startsWith(`${key}=`))
    .map((line) => line.slice(key.length + 1).trim());
}

function webLabels(root) {
  const source = read(root, "apps/web/src/lib/runtime-labels.ts");
  const body = source.slice(source.indexOf("RUNTIME_LABELS"), source.indexOf("};"));
  return new Map([...body.matchAll(/^\s*([a-z][a-z0-9_-]*):\s*"([^"]*)",?$/gm)].map((match) => [match[1], match[2]]));
}

function webRoles(root) {
  const source = read(root, "apps/web/src/lib/runtime-labels.ts");
  const start = source.indexOf("RUNTIME_ROLES");
  if (start < 0) return new Map();
  const body = source.slice(start, source.indexOf("};", start));
  return new Map([...body.matchAll(/^\s*([a-z][a-z0-9_-]*):\s*\[([^\]]*)\],?$/gm)]
    .map((match) => [match[1], [...match[2].matchAll(/"([^"]+)"/g)].map((role) => role[1])]));
}

function shellList(text, opener) {
  const start = text.indexOf(opener);
  if (start < 0) return [];
  const rest = text.slice(start + opener.length);
  return rest.slice(0, rest.indexOf(")")).split(/\s+/).filter(Boolean);
}

function shellWords(text, pattern) {
  const match = pattern.exec(text);
  return match ? match[1].split(/\s+/).filter(Boolean) : [];
}

function shellConstant(text, name) {
  const match = new RegExp(`^readonly ${name}="\\$\\{PREFIX\\}([^"]+)"`, "m").exec(text);
  return match ? match[1] : null;
}

// ------------------------------------------------------------ static copies

export function registryGaps({ adapters, layout, root }) {
  const gaps = [];
  const names = adapters.map((adapter) => adapter.name);

  // The panel's names.
  const labels = webLabels(root);
  for (const adapter of adapters) {
    const label = labels.get(adapter.name);
    if (label === undefined) gaps.push(`apps/web/src/lib/runtime-labels.ts has no label for ${adapter.name}`);
    else if (label !== adapter.display.label) {
      gaps.push(`apps/web/src/lib/runtime-labels.ts labels ${adapter.name} "${label}", the registry "${adapter.display.label}"`);
    }
  }
  for (const name of labels.keys()) {
    if (!names.includes(name)) gaps.push(`apps/web/src/lib/runtime-labels.ts labels ${name}, which the registry does not declare`);
  }
  // And the roles it offers each runtime for, which replaced the panel's
  // `runtimeType === "codex"` (WP-9c).
  const roles = webRoles(root);
  for (const adapter of adapters) {
    const declared = roles.get(adapter.name);
    if (declared === undefined) gaps.push(`apps/web/src/lib/runtime-labels.ts gives no roles for ${adapter.name}`);
    else if ([...declared].sort().join(",") !== [...adapter.roles].sort().join(",")) {
      gaps.push(`apps/web/src/lib/runtime-labels.ts gives ${adapter.name} the roles ${declared.join(", ")}, the registry ${adapter.roles.join(", ")}`);
    }
  }
  for (const name of roles.keys()) {
    if (!names.includes(name)) gaps.push(`apps/web/src/lib/runtime-labels.ts gives roles to ${name}, which the registry does not declare`);
  }

  // The workers that exist because a runtime does: each is a contracted,
  // shipped service, and belongs to exactly one runtime.
  const claimed = new Map();
  for (const adapter of adapters) {
    for (const unit of adapter.units) {
      claimed.set(unit, [...(claimed.get(unit) ?? []), adapter.name]);
      if (!LONG_RUNNING_SERVICES.includes(unit)) {
        gaps.push(`services/operations/unit-contract.mjs does not list ${unit}, which ${adapter.name} names`);
      }
      if (!existsSync(path.join(root, "deploy/systemd", `${unit}.service`))) {
        gaps.push(`deploy/systemd/${unit}.service does not exist, and ${adapter.name} names it`);
      }
    }
  }
  for (const [unit, owners] of claimed) {
    if (owners.length > 1) gaps.push(`${unit} is claimed by ${owners.join(" and ")}; a unit belongs to one runtime`);
  }

  // Every directory the units mount: tmpfiles creates it with the declared
  // owner, group and mode.
  const tmpfiles = tmpfilesEntries(root);
  const declared = [...adapters.flatMap(sandboxPathsFor), ...Object.values(layout)];
  for (const entry of declared) {
    const actual = tmpfiles.get(entry.path);
    if (!actual) { gaps.push(`deploy/tmpfiles.d creates no ${entry.path}`); continue; }
    if (actual.owner !== entry.owner || actual.group !== entry.group || actual.mode !== entry.mode) {
      gaps.push(`deploy/tmpfiles.d creates ${entry.path} as ${actual.owner}:${actual.group} 0${actual.mode.toString(8)}, `
        + `declared ${entry.owner}:${entry.group} 0${entry.mode.toString(8)}`);
    }
  }

  // The installer: creates each runtime's account, refuses to touch its home,
  // and names the same roots.
  const installer = withoutComments(read(root, "deploy/install.sh"), "#");
  // The loop that creates the runtime accounts is the one that gives them a home.
  const accounts = shellWords(installer, /for u in ([^;]+); do\n[^\n]*useradd[^\n]*--create-home/);
  const guarded = shellList(installer, "readonly RUNTIME_HOME_PATHS=(");
  for (const adapter of adapters) {
    if (!accounts.includes(adapter.user)) gaps.push(`deploy/install.sh does not create the account ${adapter.user} for ${adapter.name}`);
    for (const { path: directory } of adapter.sandboxPaths) {
      if (!guarded.includes(directory)) gaps.push(`deploy/install.sh does not guard ${directory} in RUNTIME_HOME_PATHS`);
    }
  }
  for (const [constant, key] of [["WORKSPACE_ROOT", "workspaceRoot"], ["GATE_SMOKE_ROOT", "gateSmokeRoot"]]) {
    const value = shellConstant(installer, constant);
    if (value !== layout[key].path) gaps.push(`deploy/install.sh sets ${constant} to ${value}, the layout ${layout[key].path}`);
  }

  // The supervisor's unit: it launches every runtime, so it must let each write
  // its own state and see the roots where the layout says they are.
  const writable = unitDirectives(root, "infra-cod-runtime-supervisor", "ReadWritePaths") ?? [];
  const covers = (directory) => writable.some((entry) => directory === entry || directory.startsWith(`${entry}/`));
  for (const adapter of adapters) {
    for (const directory of adapter.writableState) {
      if (!covers(directory)) gaps.push(`infra-cod-runtime-supervisor.service does not let ${adapter.name} write ${directory}`);
    }
  }

  // Every unit that is told where a root is, is told the layout's path. Whether
  // it may write there is the unit's own business: the project provisioner is
  // told the workspace root and asks the supervisor to create under it.
  const environment = { PROJECT_WORKSPACE_ROOT: layout.workspaceRoot.path, RUNTIME_GATE_WORKSPACE_ROOT: layout.gateSmokeRoot.path };
  for (const file of readdirSync(path.join(root, "deploy/systemd")).filter((name) => name.endsWith(".service"))) {
    const unit = file.slice(0, -".service".length);
    for (const line of unitDirectives(root, unit, "Environment")) {
      const [key, value] = line.split("=");
      if (key in environment && value !== environment[key]) {
        gaps.push(`${file} sets ${key}=${value}, the layout ${environment[key]}`);
      }
    }
  }

  // The web tier's default, used when the panel's environment names no root.
  const actions = read(root, "apps/web/src/lib/control-plane-actions.ts");
  const fallback = /CONTROL_PLANE_WORKSPACE_ROOT \?\? "([^"]+)"/.exec(actions)?.[1];
  if (fallback !== layout.workspaceRoot.path) {
    gaps.push(`apps/web/src/lib/control-plane-actions.ts falls back to ${fallback}, the layout ${layout.workspaceRoot.path}`);
  }
  for (const runtime of assumedStructuralRuntimes(actions)) {
    gaps.push(`apps/web/src/lib/control-plane-actions.ts makes a ${runtime} profile whatever model was picked`);
  }

  return gaps;
}

// A project's assignment is run by the runtime its profile names, so the panel
// takes the profile's runtime from the catalog entry the operator picked. A
// runtime written into the call is the rc.44 defect: every catalog project got
// a Codex orchestrator, an OpenCode model on it.
export function assumedStructuralRuntimes(source) {
  return [...source.matchAll(/await\s+structuralProfiles?\([^()]*["']([a-z]+)["']/g)].map((match) => match[1]);
}

// -------------------------------------------------------------- the schema

// The literals a CHECK definition or a function body compares with, from
// `pg_get_constraintdef` text such as `(runtime_type = ANY (ARRAY['codex'::text, …]))`.
function literals(text) {
  return [...text.matchAll(/'([a-z][a-z0-9_:-]*)'/g)].map((match) => match[1]);
}

const sameSet = (a, b) => a.length === b.length && a.every((item) => b.includes(item));

// `checks`: [{ table, name, definition }] for the control plane's CHECK
// constraints. `functions`: [{ name, source }] for its functions. Both read from
// the migrated database by the integration test; nothing here connects to one.
export function schemaGaps({ adapters, reserved, checks, functions }) {
  const gaps = [];
  const accepted = [...adapters.map((adapter) => adapter.name), ...Object.keys(reserved)].sort();
  const known = new Set(accepted);

  // A runtime_type column accepts exactly the registry's names and the reserved
  // ones — no fewer, or a runtime cannot be recorded; no more, or the database
  // admits a runtime nothing provisions.
  for (const check of checks.filter((entry) => /\bruntime_type\b/.test(entry.definition))) {
    const values = [...new Set(literals(check.definition))].sort();
    if (!sameSet(values, accepted)) {
      gaps.push(`${check.table}.${check.name} accepts [${values.join(", ")}], the registry [${accepted.join(", ")}]`);
    }
  }

  // Function bodies. `x NOT IN (…)` followed by a refusal is how a function
  // validates a name, so such a list must be exactly the accepted set. `x IN (…)`
  // selects some runtimes for a role — which ones can execute — and only must not
  // name one that does not exist. What is compared decides which set: a
  // `provider` is a connection provider, anything else a runtime name.
  const providerSet = [...new Set(adapters.map((adapter) => adapter.dispatch.connectionProvider))].sort();
  // The operand is whatever precedes the list on its line — a name, or an
  // expression such as COALESCE(v_entry->>'runtime_type','').
  const list = /([^\n]{0,80}?)\s+(NOT\s+)?IN\s*\(((?:\s*'[a-z][a-z0-9_-]*'\s*,?)+)\)/g;
  for (const fn of functions) {
    for (const match of fn.source.matchAll(list)) {
      const values = [...new Set(literals(match[3]))].sort();
      const operand = match[1].trim().split(/\s+/).at(-1);
      const isProvider = /provider\b/.test(operand) && !/runtime_type/.test(operand);
      const expected = isProvider ? providerSet : accepted;
      const allowed = isProvider ? new Set([...providerSet, "github"]) : known;
      if (!values.some((value) => allowed.has(value) || known.has(value))) continue;
      const unknown = values.filter((value) => !allowed.has(value));
      if (unknown.length) {
        gaps.push(`${fn.name} compares ${operand} with ${unknown.join(", ")}, which is no ${isProvider ? "runtime's provider" : "runtime"}`);
      } else if (match[2] && !values.includes("github") && !sameSet(values, expected)) {
        gaps.push(`${fn.name} validates ${operand} against [${values.join(", ")}], the registry [${expected.join(", ")}]`);
      }
    }
  }

  // Provider connections: every runtime's connection provider is accepted, and
  // nothing but a runtime's or GitHub's is.
  const providers = adapters.map((adapter) => adapter.dispatch.connectionProvider);
  for (const check of checks.filter((entry) => /^\(\(provider = ANY/.test(entry.definition.replace(/^CHECK /, "")))) {
    const values = literals(check.definition);
    for (const provider of providers) {
      if (!values.includes(provider)) gaps.push(`${check.table}.${check.name} does not accept the provider ${provider}`);
    }
    for (const value of values) {
      if (value !== "github" && !providers.includes(value)) gaps.push(`${check.table}.${check.name} accepts ${value}, which no runtime connects as`);
    }
  }

  // Runtime jobs: each type is served by at least one runtime. Since 11.2 N4
  // two serve the orchestrator's types; the job's assignment chooses.
  const jobCheck = checks.find((entry) => entry.table.endsWith("runtime_jobs") && entry.name === "runtime_jobs_job_type_check");
  if (!jobCheck) gaps.push("runtime_jobs has no job_type CHECK to compare with");
  else {
    const types = literals(jobCheck.definition);
    for (const type of types) {
      const owners = adapters.filter((adapter) => adapter.dispatch.jobTypes.includes(type)).map((adapter) => adapter.name);
      if (owners.length === 0) gaps.push(`runtime_jobs.job_type ${type} is served by no runtime`);
    }
    for (const adapter of adapters) {
      for (const type of adapter.dispatch.jobTypes) {
        if (!types.includes(type)) gaps.push(`runtime_jobs_job_type_check does not accept ${type}, which ${adapter.name} serves`);
      }
    }
  }

  // Credential references name the runtime's Unix user. Every one the schema
  // writes or checks belongs to a runtime, and every connecting runtime's is
  // written somewhere.
  const references = new Map();
  for (const text of [...checks.map((entry) => [entry.name, entry.definition]), ...functions.map((fn) => [fn.name, fn.source])]) {
    for (const match of text[1].matchAll(/'([a-z][a-z0-9_-]*-home:[a-z][a-z0-9_-]*)'/g)) {
      references.set(match[1], [...(references.get(match[1]) ?? []), text[0]]);
    }
  }
  const expected = adapters.map(credentialReferenceFor);
  for (const [reference, where] of references) {
    if (!expected.includes(reference)) gaps.push(`${[...new Set(where)].join(", ")} use${where.length > 1 ? "" : "s"} the credential reference ${reference}, which is no runtime's`);
  }
  for (const reference of expected) {
    if (!references.has(reference)) gaps.push(`nothing in the schema records the credential reference ${reference}`);
  }

  return gaps;
}
