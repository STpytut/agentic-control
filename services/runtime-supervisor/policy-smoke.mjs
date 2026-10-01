import { RuntimeSupervisorClient } from "./client.mjs";

const projectId = process.argv[2];
if (!projectId) throw new Error("usage: policy-smoke.mjs <project-id>");

const client = new RuntimeSupervisorClient();
await client.connect();
const processHandle = await client.open({ runtime: "codex", surface: "project", projectId });
const denied = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("write-policy denial timed out")), 5000);
  client.once("protocol_error", (error) => {
    clearTimeout(timer);
    resolve(error.message);
  });
});
processHandle.stdin.write(
  `${JSON.stringify({
    id: 1,
    method: "thread/start",
    params: { cwd: "/tmp", sandbox: "workspace-write", approvalPolicy: "never" },
  })}\n`,
);
const message = await denied;
processHandle.kill();
client.close();
process.stdout.write(`${message}\n`);
if (message !== "Codex channel only permits read-only threads") process.exitCode = 1;
