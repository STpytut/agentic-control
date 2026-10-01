// What the supervisor keeps of the OpenCode Go usage probe's output (ADR-0019).
//
// The probe runs as opencode-worker and holds the Go key; the supervisor never
// does. Its stdout is the only thing that crosses back, and it is trusted for
// nothing: one line, at most 4 KB, one JSON object whose every key and value is
// in the closed schema below. Anything else — an extra field, a string outside
// the list, a number out of range — rejects the whole line, so a probe that has
// changed or broken yields "unknown", never a leak.
//
// Pure, so it is tested without a host.

export const PROBE_OUTPUT_MAX_BYTES = 4096;

const WINDOW_MINUTES = Object.freeze({ rolling: 300, weekly: 10_080, monthly: 43_200 });
const STATUSES = new Set(["allowed", "rejected"]);
const ERROR_CLASSES = new Set(["unauthorized", "unavailable", "malformed", "timeout", "not_subscribed"]);

const plainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const onlyKeys = (value, allowed) => Object.keys(value).every((key) => allowed.includes(key));

function checkWindow(window) {
  if (!plainObject(window) || !onlyKeys(window, ["key", "used_percent", "window_minutes", "resets_at"])) return null;
  const minutes = WINDOW_MINUTES[window.key];
  if (!minutes || window.window_minutes !== minutes) return null;
  const percent = window.used_percent;
  if (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0 || percent > 100) return null;
  const checked = { key: window.key, used_percent: Math.round(percent * 10) / 10, window_minutes: minutes };
  if (window.resets_at !== undefined) {
    const at = window.resets_at;
    if (!Number.isInteger(at) || at < 1_600_000_000 || at > 4_100_000_000) return null;
    checked.resets_at = at;
  }
  return checked;
}

// The reading to record, or null when the output is not one the schema allows.
export function checkProbeOutput(stdout) {
  const text = String(stdout ?? "");
  if (Buffer.byteLength(text, "utf8") > PROBE_OUTPUT_MAX_BYTES) return null;
  const lines = text.split("\n").filter((line) => line.trim());
  if (lines.length !== 1) return null;
  let value;
  try {
    value = JSON.parse(lines[0]);
  } catch {
    return null;
  }
  if (!plainObject(value)) return null;
  if ("error_class" in value) {
    if (!onlyKeys(value, ["error_class"]) || !ERROR_CLASSES.has(value.error_class)) return null;
    return { error_class: value.error_class };
  }
  if (!onlyKeys(value, ["windows", "status"]) || !Array.isArray(value.windows)) return null;
  if (value.windows.length < 1 || value.windows.length > 3 || !STATUSES.has(value.status)) return null;
  const windows = value.windows.map(checkWindow);
  if (windows.some((window) => window === null)) return null;
  if (new Set(windows.map((window) => window.key)).size !== windows.length) return null;
  return { windows, status: value.status };
}
