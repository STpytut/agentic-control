// What one model check found, from what the runtime said (Stage 12 W6;
// docs/RUNTIMES_AND_MODELS_DESIGN.md §2.4, P19).
//
// A check is one short turn: "Reply with exactly the word PARITY_OK". Its
// verdict carries a class, because the four ways it can go wrong mean four
// different things to the operator:
//
//   passed        the model answered
//   rejected      class model — the provider or runtime said no to this model
//                 (not found, not in the plan, unsupported): not eligible
//   inconclusive  class infrastructure — a limit, the network: eligibility
//                 does not move, and the check is retried later
//   failed        class runtime or harness — the runtime crashed or its stream
//                 did not parse, or our code failed: it points at the runtime's
//                 qualification, not at the model
//
// The two text patterns are the database's too (model_failure_class, 0100),
// which reads a task run's failure with them; the two lists are kept alike.
// Pure, so the classification is tested without a runtime.

import { redactError } from "./worker-loop.mjs";

export const CHECK_PROMPT = "Reply with exactly the word PARITY_OK and nothing else.";
export const CHECK_ANSWER = "PARITY_OK";

export const LIMIT_PATTERN = /usage limit|rate.?limit|quota|too many requests|\b429\b|insufficient credit|out of credits|runtime_capacity|no memory for another/i;
export const MODEL_PATTERN = /model not available|model.?not.?found|unknown model|invalid model|unsupported model|model is not supported|not supported (when|with|by|for)|does not exist|not in your plan|no endpoints found|no allowed providers|not a valid model/i;
// What a runtime that fell over says about itself, as opposed to our own code
// throwing: its process went away, or it panicked on the way.
const RUNTIME_PATTERN = /app-server closed|exited with|\bsignal\b|panicked|crash|segmentation fault|ECONNRESET|EPIPE|stream did not parse|not JSON/i;

export function failureClassOf(text) {
  const value = String(text ?? "");
  if (LIMIT_PATTERN.test(value)) return "infrastructure";
  if (MODEL_PATTERN.test(value)) return "model";
  return null;
}

function detail(text, fallback) {
  return redactError(String(text ?? "").trim() || fallback, fallback, [], { maxLength: 450 });
}

// The verdict of a turn that ran to its end, one way or another.
//   answer   the text the model gave, if any
//   failure  what the runtime or provider said went wrong, if anything
//   exited   the turn's process ended abnormally (a non-zero exit, a closed
//            app-server) — distinct from a turn that completed with an error
export function judgeTurn({ answer = "", failure = "", exited = false } = {}) {
  const text = String(answer ?? "");
  if (text.includes(CHECK_ANSWER)) return { result: "passed", failureClass: null, detail: CHECK_ANSWER };
  const said = [failure, text].filter(Boolean).join(" — ");
  const cls = failureClassOf(said);
  if (cls === "infrastructure") {
    return { result: "inconclusive", failureClass: "infrastructure", detail: detail(said, "the provider answered with a limit") };
  }
  if (cls === "model") return { result: "rejected", failureClass: "model", detail: detail(said, "the provider refused the model") };
  if (exited) return { result: "failed", failureClass: "runtime", detail: detail(said, "the runtime ended the turn abnormally") };
  // The model answered, but not what it was asked: it runs, and does not
  // follow a one-word instruction — not a model to hand a task to.
  if (text.trim()) {
    return { result: "rejected", failureClass: "model", detail: detail(`answered without ${CHECK_ANSWER}: ${text}`, "answered something else") };
  }
  return { result: "failed", failureClass: "runtime", detail: detail(said, "the turn ended without an answer") };
}

// The verdict when the check threw instead. `wait` is a refusal raised before
// anything ran (no memory, a runtime being installed): nothing was spent, and
// the check waits for its turn again.
export function judgeError(error) {
  const message = redactError(error, "The model check failed.", [], { maxLength: 450 });
  if (error?.code === "runtime_capacity") return { result: "wait", detail: "waiting: memory for a background run", retryMs: 60_000 };
  if (error?.code === "runtime_paused") return { result: "wait", detail: "waiting: the runtime is being installed", retryMs: 60_000 };
  // The lease ran out mid-call and the turn could not be confirmed stopped: it
  // may have been sent. Nothing is known about the model, so it is
  // inconclusive, and it is counted.
  if (error?.outcomeUnknown === true || error?.cancelled === true) {
    return { result: "inconclusive", failureClass: "infrastructure", detail: `the outcome is unknown: ${message}` };
  }
  const cls = failureClassOf(message);
  if (cls === "infrastructure") return { result: "inconclusive", failureClass: "infrastructure", detail: message };
  if (cls === "model") return { result: "rejected", failureClass: "model", detail: message };
  if (RUNTIME_PATTERN.test(message)) return { result: "failed", failureClass: "runtime", detail: message };
  return { result: "failed", failureClass: "harness", detail: message };
}

// Codex's subscription windows, from the app-server's account/rateLimits/read
// (the Paperclip survey's P17): the primary window's used percentage and when
// it resets. Read defensively — the shape is the app-server's, not ours — and
// null when it says nothing usable.
export function parseRateLimits(result) {
  const limits = result?.rateLimits ?? result?.rate_limits ?? result;
  const primary = limits?.primary ?? limits?.primaryWindow ?? null;
  if (!primary || typeof primary !== "object") return null;
  const used = Number(primary.usedPercent ?? primary.used_percent);
  if (!Number.isFinite(used)) return null;
  const reset = primary.resetsAt ?? primary.resets_at ?? null;
  let resetsAt = null;
  if (typeof reset === "number" && Number.isFinite(reset)) {
    // Seconds since the epoch, or milliseconds: a number below 10^12 is seconds.
    resetsAt = new Date(reset < 1e12 ? reset * 1000 : reset);
  } else if (typeof reset === "string" && !Number.isNaN(Date.parse(reset))) {
    resetsAt = new Date(reset);
  }
  return { usedPercent: used, resetsAt };
}

// Whether an automatic Codex check should wait for the window (§2.6), and
// until when: its reset if known and in the future, else half an hour.
export function windowDeferral(window, { limitPercent = 80, now = Date.now() } = {}) {
  if (!window || window.usedPercent <= limitPercent) return null;
  const reset = window.resetsAt?.getTime?.();
  const until = Number.isFinite(reset) && reset > now ? reset : now + 30 * 60_000;
  return {
    retryAt: new Date(until).toISOString(),
    detail: `waiting: the Codex usage window is ${Math.round(window.usedPercent)} % used`,
  };
}
