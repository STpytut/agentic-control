import { executeJson } from "@/lib/database";

// The Notifications page's state (0140): the operator's Telegram bot, never
// its token — the panel holds that only as the envelope it sent.
export type TelegramConnection = {
  status: "none" | "verifying" | "awaiting_chat" | "connected" | "failed" | "disconnected";
  botUsername: string;
  linkCode: string;
  chatLabel: string;
  failureMessage: string;
  lastSentAt: string;
};

export async function getTelegramConnection(operatorId: string): Promise<TelegramConnection> {
  const row = await executeJson(`SELECT get_telegram_connection(:'owner_id'::uuid)::text;`, { owner_id: operatorId }) as Record<string, unknown> | null;
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  return {
    status: (text(row?.status) || "none") as TelegramConnection["status"],
    botUsername: text(row?.bot_username), linkCode: text(row?.link_code), chatLabel: text(row?.chat_label),
    failureMessage: text(row?.failure_message), lastSentAt: text(row?.last_sent_at),
  };
}
