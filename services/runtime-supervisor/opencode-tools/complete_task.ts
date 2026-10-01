import { tool } from "@opencode-ai/plugin"
import net from "node:net"

function submit(message: object): Promise<string> {
  const socketPath = process.env.INFRA_WORKER_TOOL_SOCKET
  const capability = process.env.INFRA_WORKER_CAPABILITY
  if (!socketPath || !capability) throw new Error("platform completion channel is unavailable")
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath)
    let response = ""
    socket.setEncoding("utf8")
    socket.once("connect", () => socket.write(`${JSON.stringify({ ...message, capability })}\n`))
    socket.on("data", (chunk) => (response += chunk))
    socket.once("error", reject)
    socket.once("close", () => {
      try {
        const result = JSON.parse(response.trim())
        if (!result.ok) reject(new Error(result.error ?? "completion rejected"))
        else resolve(JSON.stringify(result.result))
      } catch (error) {
        reject(error)
      }
    })
  })
}

export default tool({
  description: "Submit the structured implementation result. Call exactly once after all edits and checks are finished.",
  args: {
    changed_files: tool.schema.array(tool.schema.string()).min(1).describe("Workspace-relative files changed"),
    checks: tool.schema.record(tool.schema.string(), tool.schema.string()).describe("Check name to result mapping"),
    summary: tool.schema.string().min(1).describe("Concise implementation summary"),
    notes: tool.schema.string().optional().describe("Optional reviewer notes"),
  },
  async execute(args, context) {
    return submit({
      type: "complete_task",
      native_session_id: context.sessionID,
      result_summary: { summary: args.summary, changed_files: args.changed_files },
      checks_summary: args.checks,
      notes: args.notes ?? null,
      idempotency_key: `complete:${process.env.INFRA_WORKER_RUN_ID}`,
    })
  },
})
