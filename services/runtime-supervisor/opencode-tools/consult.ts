import { tool } from "@opencode-ai/plugin"
import net from "node:net"

// The orchestrator's question to an analyst (Stage 12, 0147), carried to the
// run's own socket: the supervisor answers it with invoke_consult under the
// job's lease. Loaded in every OpenCode run and switched off by the run's
// config wherever the run is not an orchestrator's.
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
  description: "Ask one of the project's analysts to read the code and answer a question. The answer arrives later as a new message; this call only asks.",
  args: {
    member: tool.schema.string().optional().describe("The analyst's name; may be left out when the project has exactly one"),
    question: tool.schema.string().min(10).max(8000).describe("What the analyst should find out, and what to report"),
  },
  async execute(args, context) {
    return submit({
      type: "consult",
      native_session_id: context.sessionID,
      // Two questions in one message are two calls: the tool call's own id
      // where OpenCode gives one, the message's otherwise.
      call_id: `${context.messageID}:consult:${(context as { callID?: string }).callID ?? "0"}`,
      arguments: args,
    })
  },
})
