import { tool } from "@opencode-ai/plugin"
import net from "node:net"

function submit(message: object): Promise<string> {
  const socketPath = process.env.INFRA_WORKER_TOOL_SOCKET
  const capability = process.env.INFRA_WORKER_CAPABILITY
  if (!socketPath || !capability) throw new Error("platform worker channel is unavailable")
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath)
    let response = ""
    socket.setEncoding("utf8")
    socket.once("connect", () => socket.write(`${JSON.stringify({ ...message, capability })}\n`))
    socket.on("data", (chunk) => (response += chunk))
    socket.once("error", reject)
    socket.once("close", () => {
      try { const result = JSON.parse(response.trim()); result.ok ? resolve(JSON.stringify(result.result)) : reject(new Error(result.error)) }
      catch (error) { reject(error) }
    })
  })
}

export default tool({
  description: "Request user input when implementation cannot continue safely without a decision.",
  args: {
    question: tool.schema.string().min(1),
    sensitivity: tool.schema.enum(["normal", "sensitive"]).default("normal"),
    context: tool.schema.string().optional(),
  },
  async execute(args, context) {
    return submit({ type: "request_user_input", native_session_id: context.sessionID, payload: args,
      idempotency_key: `input:${process.env.INFRA_WORKER_RUN_ID}` })
  },
})
