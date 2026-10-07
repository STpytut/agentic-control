"use client";

import { controlPlaneActionHeaders } from "@/lib/csrf-client";
import type { TelegramConnection } from "@/lib/telegram-connection";
import { encryptOpenCodeApiKey } from "@/lib/opencode-crypto";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Badge, Button, Card, TextInput } from "@agentic/design-system";
import { connection as ui } from "@/components/ui/connection-card";
import { dangerOutlineClasses } from "@/components/ui/danger-button";
import { Notice } from "@/components/ui/notice";

async function action(body: Record<string, unknown>) {
  const response = await fetch("/api/control-plane/actions", { method: "POST", headers: controlPlaneActionHeaders(), body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.error ?? "Telegram action failed");
  return data.result as Record<string, unknown>;
}

// The broker's public key, as the OpenCode card fetches it: the token is
// encrypted for the VPS before it leaves the browser.
async function brokerKey() {
  const response = await fetch("/api/control-plane/opencode/broker-key", { cache: "no-store" });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.error ?? "The server's encryption key is unavailable");
  return String(data.publicKey);
}

const STATUS: Record<TelegramConnection["status"], { label: string; tone: "success" | "info" | "warning" | "danger" | "neutral" }> = {
  none: { label: "Not set up", tone: "neutral" },
  disconnected: { label: "Not set up", tone: "neutral" },
  verifying: { label: "Checking the bot", tone: "info" },
  awaiting_chat: { label: "Waiting for your chat", tone: "warning" },
  connected: { label: "Connected", tone: "success" },
  failed: { label: "Needs a new token", tone: "danger" },
};

// Settings → Notifications (0140): your own bot, made with @BotFather, sends
// you a message when a task waits for you.
export function TelegramCard({ initial }: { initial: TelegramConnection }) {
  const router = useRouter();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [token, setToken] = useState("");
  const status = initial.status;
  const settingUp = status === "verifying" || status === "awaiting_chat";
  const showTokenForm = status === "none" || status === "disconnected" || status === "failed";

  useEffect(() => {
    if (!settingUp) return;
    const timer = window.setInterval(() => router.refresh(), 3000);
    return () => window.clearInterval(timer);
  }, [settingUp, router]);

  async function run(kind: string, work: () => Promise<unknown>, done = "") {
    setBusy(kind);
    setError("");
    setNotice("");
    try {
      await work();
      if (done) setNotice(done);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Telegram action failed");
    } finally {
      setBusy("");
    }
  }

  function saveToken() {
    const value = token.trim();
    if (!/^\d{5,15}:[A-Za-z0-9_-]{30,64}$/.test(value)) {
      setError("Paste the token exactly as @BotFather shows it: digits, a colon, then the key.");
      return;
    }
    void run("telegram_set", async () => {
      const envelope = await encryptOpenCodeApiKey(value, await brokerKey());
      await action({ kind: "telegram_set", ciphertext: envelope.ciphertext, iv: envelope.iv, tag: envelope.tag, keyWrap: envelope.keyWrap });
      setToken("");
    });
  }

  const link = initial.botUsername && initial.linkCode ? `https://t.me/${initial.botUsername}?start=${initial.linkCode}` : "";

  return <Card as="section" className="min-w-0">
    <div className={ui.heading}>
      <div>
        <p className="type-eyebrow text-muted">NOTIFICATIONS</p>
        <h2 className="type-section-title mt-1.5">Telegram</h2>
        <p className={ui.owner}>A message when a task needs your approval, an agent asks you something, a job stops, or a pull request opens.</p>
      </div>
      <Badge tone={STATUS[status].tone} className="shrink-0">{STATUS[status].label}</Badge>
    </div>

    {error && <Notice tone="danger" className="mt-3.5">{error}</Notice>}
    {notice && <Notice tone="success" className="mt-3.5">{notice}</Notice>}
    {status === "failed" && initial.failureMessage && <Notice tone="danger" className="mt-3.5">{initial.failureMessage}</Notice>}

    {showTokenForm && <div className="mt-4 grid gap-2.5">
      <ol className="type-app-body m-0 grid gap-1 pl-5 text-ink/85">
        <li>In Telegram, open <a className="font-medium underline underline-offset-2" href="https://t.me/BotFather" target="_blank" rel="noreferrer">@BotFather</a> and send <code>/newbot</code>.</li>
        <li>Pick a name; it answers with a token.</li>
        <li>Paste the token here. It is encrypted in your browser for the server; the panel never shows it again.</li>
      </ol>
      <form className="flex flex-wrap gap-2" onSubmit={(event) => { event.preventDefault(); saveToken(); }}>
        <TextInput value={token} onChange={(event) => setToken(event.target.value)} className="min-w-0 flex-1 font-mono" type="password" placeholder="123456789:AA…" aria-label="Bot token"
          autoComplete="off" spellCheck={false} disabled={Boolean(busy)}/>
        <Button size="sm" type="submit" disabled={Boolean(busy)}>{busy === "telegram_set" ? "Saving…" : "Save token"}</Button>
      </form>
    </div>}

    {status === "verifying" && <Notice tone="info" className="mt-3.5">Checking the token with Telegram…</Notice>}
    {status === "awaiting_chat" && link && <Notice tone="info" className="mt-3.5 grid gap-2">
      <strong className="font-medium">Last step: open your bot and press Start</strong>
      <a className="inline-flex min-h-8 w-fit items-center font-medium underline underline-offset-2" href={link} target="_blank" rel="noreferrer">Open @{initial.botUsername}</a>
      <span>This page updates once the bot has your chat.</span>
    </Notice>}

    {(status === "connected" || status === "awaiting_chat") && <dl className={ui.meta}>
      <div className={ui.metaItem}><dt className={ui.metaTerm}>Bot</dt><dd className={ui.metaValue}>@{initial.botUsername}</dd></div>
      <div className={ui.metaItem}><dt className={ui.metaTerm}>Chat</dt><dd className={ui.metaValue}>{initial.chatLabel || "not linked yet"}</dd></div>
    </dl>}

    {(status === "connected" || settingUp) && <div className={ui.actions}>
      {status === "connected" && <Button size="sm" variant="secondary" disabled={Boolean(busy)}
        onClick={() => void run("telegram_test", () => action({ kind: "telegram_test" }), "Sent. It arrives within a few seconds.")}>
        {busy === "telegram_test" ? "Sending…" : "Send a test message"}
      </Button>}
      <button className={dangerOutlineClasses} disabled={Boolean(busy)}
        onClick={() => { if (window.confirm("Stop Telegram notifications and forget this bot's token?")) void run("telegram_disconnect", () => action({ kind: "telegram_disconnect" })); }}>
        {busy === "telegram_disconnect" ? "Disconnecting…" : "Disconnect"}
      </button>
    </div>}
  </Card>;
}
