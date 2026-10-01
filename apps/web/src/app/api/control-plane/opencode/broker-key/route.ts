import { requireOperatorApi } from "@/lib/auth";
import { readBrokerPublicKey } from "@/lib/opencode-broker-key";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Serves the VPS broker's RSA public key so the browser can encrypt the
// OpenCode Go API key before it reaches the web API. The private key never
// leaves the VPS and is never exposed here.

export async function GET() {
  const operator = await requireOperatorApi();
  if (operator instanceof Response) return operator;
  const key = readBrokerPublicKey();
  if (key.publicKey === null) {
    return NextResponse.json(
      { ok: false, error: `OpenCode broker public key is not configured: ${key.reason}` },
      { status: 503 },
    );
  }
  return NextResponse.json({ ok: true, publicKey: key.publicKey });
}
