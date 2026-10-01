import { readSessionCsrfToken, requireOperatorApi } from "@/lib/auth";
import { readBrokerPublicKey } from "@/lib/opencode-broker-key";

export const dynamic = "force-dynamic";

const htmlTemplate = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>OpenCode Go enrollment</title>
  <style>
    :root{color-scheme:light;font:16px/1.45 system-ui,sans-serif;color:#182230;background:#f7f8fa}
    *{box-sizing:border-box}body{margin:0;padding:32px 16px}.card{max-width:680px;margin:auto;padding:28px;border:1px solid #d0d5dd;border-radius:14px;background:#fff;box-shadow:0 12px 30px #10182812}
    h1{margin:0 0 8px;font-size:25px}p{color:#475467}.stack{display:grid;gap:12px;margin-top:22px}input,button,a{font:inherit;border-radius:8px}input{width:100%;padding:12px;border:1px solid #98a2b3}button{padding:12px 16px;border:0;background:#475fd0;color:#fff;font-weight:700;cursor:pointer}button[disabled]{opacity:.55;cursor:wait}a{color:#3448b5}.status{min-height:52px;padding:12px;border-radius:8px;background:#eef2ff;color:#293056;white-space:pre-wrap}.error{background:#fff1f0;color:#b42318}.ok{background:#ecfdf3;color:#067647}.hidden{display:none}.note{font-size:13px;color:#667085}
  </style>
</head>
<body>
  <main class="card">
    <a href="/settings/connections">← Connections</a>
    <h1>OpenCode Go enrollment</h1>
    <p>This isolated page avoids the React settings UI. The key is encrypted here with RSA-OAEP + AES-256-GCM; only the encrypted envelope is sent to the control plane.</p>
    <div class="stack">
      <div id="status" class="status" role="status" aria-live="polite">Loading current enrollment…</div>
      <button id="start" class="hidden" type="button">Start new enrollment</button>
      <div id="keyPanel" class="stack hidden">
        <label for="apiKey"><strong>OpenCode Go API key</strong></label>
        <input id="apiKey" type="password" autocomplete="off" spellcheck="false">
        <button id="install" type="button">Encrypt and install key</button>
      </div>
      <p class="note">Do not paste the key into chat. This page never places it in a URL, log, cookie, database row, or server-rendered HTML.</p>
    </div>
  </main>
  <script>
    (() => {
      const status = document.getElementById('status');
      const start = document.getElementById('start');
      const panel = document.getElementById('keyPanel');
      const input = document.getElementById('apiKey');
      const install = document.getElementById('install');
      const brokerPublicKey = atob('__BROKER_PUBLIC_KEY_B64__');
      let state = null;
      let timer = 0;

      const show = (message, kind = '') => {
        status.textContent = message;
        status.className = 'status' + (kind ? ' ' + kind : '');
      };
      const api = async (url, options = {}) => {
        const response = await fetch(url, { cache: 'no-store', ...options });
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error(data.error || 'Request failed');
        return data;
      };
      const post = (body) => api('/api/control-plane/actions', {
        method: 'POST',
        headers: {'Content-Type':'application/json','X-Control-Plane-Action':'confirmed','X-CSRF-Token':'__CSRF_TOKEN__'},
        body: JSON.stringify(body),
      });
      const b64 = (bytes) => {
        let binary = '';
        for (const byte of bytes) binary += String.fromCharCode(byte);
        return btoa(binary);
      };
      const pemBytes = (pem) => {
        const raw = atob(pem.replace(/-----(BEGIN|END) PUBLIC KEY-----/g, '').replace(/\\s+/g, ''));
        const bytes = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
        return bytes.buffer;
      };
      const errorDetails = (error) => {
        const name = error && typeof error.name === 'string' ? error.name.trim() : '';
        const message = error && typeof error.message === 'string' ? error.message.trim() : '';
        return [name, message].filter(Boolean).join(': ') || 'Unknown browser crypto error';
      };
      const cryptoStep = async (label, operation) => {
        try {
          return await operation();
        } catch (error) {
          const details = errorDetails(error);
          console.error('[opencode-enroll] ' + label + ' failed: ' + details);
          throw new Error(label + ' failed: ' + details);
        }
      };
      const encrypt = async (secret, pem) => {
        if (!window.isSecureContext) throw new Error('WebCrypto unavailable: this page is not in a secure context');
        if (!window.crypto || !window.crypto.subtle) throw new Error('WebCrypto unavailable in this browser');
        const rsa = await cryptoStep('RSA public-key import', () => crypto.subtle.importKey(
          'spki', pemBytes(pem), {name:'RSA-OAEP',hash:'SHA-256'}, false, ['encrypt'],
        ));
        const aes = await cryptoStep('AES-256 key generation', () => crypto.subtle.generateKey(
          {name:'AES-GCM',length:256}, true, ['encrypt'],
        ));
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const sealed = new Uint8Array(await cryptoStep('API key encryption', () => crypto.subtle.encrypt(
          {name:'AES-GCM',iv}, aes, new TextEncoder().encode(secret),
        )));
        const rawKey = new Uint8Array(await cryptoStep('AES key export', () => crypto.subtle.exportKey('raw', aes)));
        const keyWrap = new Uint8Array(await cryptoStep('RSA key wrapping', () => crypto.subtle.encrypt(
          {name:'RSA-OAEP'}, rsa, rawKey,
        )));
        return {
          ciphertext: b64(sealed.slice(0, -16)),
          tag: b64(sealed.slice(-16)),
          iv: b64(iv),
          keyWrap: b64(keyWrap),
        };
      };
      const refresh = async () => {
        state = await api('/api/control-plane/opencode/status');
        const enrollment = state.enrollment;
        const connected = state.go && state.go.status === 'connected';
        start.classList.toggle('hidden', connected || Boolean(enrollment && ['pending','provisioned','claimed'].includes(enrollment.status)));
        panel.classList.toggle('hidden', !(enrollment && enrollment.status === 'pending'));
        if (connected) show('OpenCode Go is connected and verified.', 'ok');
        else if (enrollment && enrollment.status === 'pending') show('Enrollment ready. Enter the key, then press “Encrypt and install key”.');
        else if (enrollment && ['provisioned','claimed'].includes(enrollment.status)) {
          show('Encrypted envelope accepted. The VPS broker is installing and verifying the key…');
          clearTimeout(timer); timer = setTimeout(() => refresh().catch(fail), 2000);
        } else show('No active enrollment. Start a new one.');
      };
      const fail = (error) => {
        const details = errorDetails(error);
        console.error('[opencode-enroll] Enrollment failed: ' + details);
        show(details === 'Unknown browser crypto error' ? 'Enrollment failed: ' + details : details, 'error');
      };

      start.addEventListener('click', async () => {
        start.disabled = true; show('Starting enrollment…');
        try {
          await post({kind: state && state.go ? 'opencode_reconnect' : 'opencode_connect'});
          await refresh();
        } catch (error) { fail(error); }
        finally { start.disabled = false; }
      });
      install.addEventListener('click', async () => {
        const secret = input.value.trim();
        if (!secret) { show('Enter the OpenCode Go API key.', 'error'); input.focus(); return; }
        install.disabled = true;
        try {
          show('1/2 Encrypting locally in this browser…');
          const envelope = await encrypt(secret, brokerPublicKey);
          input.value = '';
          show('2/2 Sending only the encrypted envelope…');
          await post({kind:'opencode_store_enrollment',enrollmentId:state.enrollment.enrollmentId,...envelope,keyFingerprint:'browser-v1'});
          show('Encrypted envelope accepted. Waiting for the VPS broker…');
          await refresh();
        } catch (error) { fail(error); }
        finally { install.disabled = false; }
      });
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') { event.preventDefault(); install.click(); }
      });
      refresh().catch(fail);
    })();
  </script>
</body>
</html>`;

export async function GET(request: Request) {
  const operator = await requireOperatorApi();
  if (operator instanceof Response) return Response.redirect(new URL("/login", request.url), 303);
  const key = readBrokerPublicKey();
  if (key.publicKey === null) {
    return new Response(`OpenCode broker public key is not configured: ${key.reason}`, { status: 503 });
  }
  const csrfToken = await readSessionCsrfToken();
  const html = htmlTemplate
    .replace("__BROKER_PUBLIC_KEY_B64__", Buffer.from(key.publicKey, "utf8").toString("base64"))
    .replace("__CSRF_TOKEN__", csrfToken);
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "private, no-store, max-age=0",
      "Content-Security-Policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
