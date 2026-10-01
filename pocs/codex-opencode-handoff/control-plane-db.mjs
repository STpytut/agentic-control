import { spawnSync } from "node:child_process";

const database = process.env.CONTROL_PLANE_DB ?? "infra_cod";
const databaseUser = process.env.CONTROL_PLANE_OS_USER ?? "infra-control";

export function queryControlPlane(sql, variables = {}) {
  const args = [
    "-u",
    databaseUser,
    "--",
    "psql",
    "-X",
    "-qAt",
    "-v",
    "ON_ERROR_STOP=1",
    "-d",
    database,
  ];
  for (const [name, value] of Object.entries(variables)) {
    args.push("-v", `${name}=${value}`);
  }
  const result = spawnSync("runuser", args, {
    encoding: "utf8",
    input: `SET search_path TO control_plane, public;\n${sql}\n`,
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`control-plane query failed: ${result.stderr.trim()}`);
  }
  const lines = result.stdout.split("\n").filter((line) => line.trim());
  return lines.at(-1) ?? "";
}

export function queryControlPlaneJson(sql, variables = {}) {
  const output = queryControlPlane(sql, variables);
  return output ? JSON.parse(output) : null;
}
