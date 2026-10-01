import type { Metadata } from "next";
import { readSessionCsrfToken } from "@/lib/auth";
import "./globals.css";

export const metadata: Metadata = {
  title: "Control plane · infra-cod",
  description: "AI coding control plane",
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // Rendered into the document so a client component can echo it back in the
  // `X-CSRF-Token` header without having to guess which cookie name the
  // deployment uses (the `__Host-` prefixed one or the dev-only one). Reading a
  // cookie makes the tree dynamic, which it already is everywhere that matters.
  const csrfToken = await readSessionCsrfToken();
  return (
    <html lang="en">
      <head>{csrfToken ? <meta name="csrf-token" content={csrfToken}/> : null}</head>
      <body>{children}</body>
    </html>
  );
}
