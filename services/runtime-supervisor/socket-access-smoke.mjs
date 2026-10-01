import net from "node:net";
import { RuntimeSupervisorClient } from "./client.mjs";

const mode = process.argv[2];
if (mode === "allow") {
  const client = new RuntimeSupervisorClient();
  await client.connect();
  const result = await client.ping();
  client.close();
  if (result.status !== "ok") throw new Error("supervisor ping failed");
  process.stdout.write(`${JSON.stringify(result)}\n`);
} else if (mode === "deny") {
  const socketPath = process.env.RUNTIME_SUPERVISOR_SOCKET ?? "/run/infra-cod/runtime-supervisor.sock";
  const result = await new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    socket.once("connect", () => resolve("CONNECTED"));
    socket.once("error", (error) => resolve(error.code));
  });
  process.stdout.write(`${result}\n`);
  if (result !== "EACCES") process.exitCode = 1;
} else {
  throw new Error("usage: socket-access-smoke.mjs <allow|deny>");
}
