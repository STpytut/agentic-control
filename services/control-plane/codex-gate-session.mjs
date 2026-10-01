// A Codex app-server conversation over a supervisor channel: requests by id,
// notifications waited for by predicate. Shared by the capability gate
// (catalog-gate-worker.mjs) and the runtime qualification (Stage 12 W3,
// runtime-qualify-turns.mjs), which drive the same protocol.

import readline from "node:readline";

const defaultTimeoutMs = Number(process.env.CATALOG_GATE_SMOKE_TIMEOUT_MS ?? 120_000);

export class CodexGateSession {
  constructor(processHandle) {
    this.processHandle = processHandle;
    this.pending = new Map();
    this.waiters = new Set();
    this.messages = [];
    this.nextId = 1;
    this.stderr = "";
    this.lines = readline.createInterface({ input: processHandle.stdout });
    this.lines.on("line", (line) => this.handleLine(line));
    processHandle.stderr.setEncoding("utf8");
    processHandle.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-4000);
    });
    processHandle.once("close", (code, signal) => {
      this.failAll(new Error(`Codex gate app-server closed (code=${code}, signal=${signal})`));
    });
  }

  send(message) {
    this.processHandle.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params, timeoutMs = defaultTimeoutMs) {
    const id = this.nextId++;
    this.send(params === undefined ? { method, id } : { method, id, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);
      this.pending.set(String(id), { resolve, reject, timer });
    });
  }

  waitFor(predicate, description, timeoutMs = defaultTimeoutMs) {
    const existing = this.messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new Error(`Timed out waiting for ${description}`));
      }, timeoutMs);
      this.waiters.add(waiter);
    });
  }

  handleLine(line) {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    this.messages.push(message);
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(String(message.id));
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(String(message.id));
        if (message.error) pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
        else pending.resolve(message.result);
      }
    }
    for (const waiter of [...this.waiters]) {
      if (waiter.predicate(message)) {
        clearTimeout(waiter.timer);
        this.waiters.delete(waiter);
        waiter.resolve(message);
      }
    }
  }

  failAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters.clear();
  }

  close() {
    this.lines.close();
    this.processHandle.stdin.end();
  }
}
