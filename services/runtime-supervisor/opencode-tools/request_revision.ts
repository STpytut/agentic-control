import { tool } from "@opencode-ai/plugin"
import net from "node:net"

// The orchestrator's request for a revision (11.2 N4). The same command Codex receives as a
// dynamic tool, carried to the run's own socket: the supervisor answers it with
// invoke_request_revision under the job's lease. Loaded in every OpenCode run and
// switched off by the run's config wherever the run is not an orchestrator's.
function submit(message: object): Promise<string> {
  const socketPath = process.env.INFRA_WORKER_TOOL_SOCKET
  const capability = process.env.INFRA_WORKER_CAPABILITY
  if (!socketPath || !capability) throw new Error("platform command channel is unavailable")
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
        if (!result.ok) reject(new Error(result.error ?? "platform command rejected"))
        else resolve(JSON.stringify(result.result))
      } catch (error) {
        reject(error)
      }
    })
  })
}

export default tool({
  description: "Return the active completed implementation to the same executor with concrete required changes.",
  args: {
    changes_required: tool.schema.array(tool.schema.string().min(1)).min(1).describe("Each change the executor must make"),
  },
  async execute(args, context) {
    return submit({
      type: "request_revision",
      native_session_id: context.sessionID,
      call_id: `${context.messageID}:request_revision`,
      arguments: args,
    })
  },
})
