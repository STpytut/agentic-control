// The smallest possible lint over `services/`, for one class of bug.
//
// `services/` was never linted — `npm run lint` covers `apps/web` only — and a
// use of an undeclared variable is invisible until the line runs. One reached a
// reviewer: a worker referenced a `leaseExpiresAt` that was never declared in
// that function, so it crashed after its first successful claim, and the suite
// stayed green because no test executes that entrypoint.
//
// So this enables the rules that catch exactly that, and nothing else. Style is
// not the point and would only make the gate noisy.
export default [
  {
    files: ["services/**/*.mjs", "scripts/**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: {
        process: "readonly",
        console: "readonly",
        Buffer: "readonly",
        URL: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly",
        AbortController: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        setImmediate: "readonly",
        queueMicrotask: "readonly",
        fetch: "readonly",
        structuredClone: "readonly",
        crypto: "readonly",
        globalThis: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        AbortSignal: "readonly",
        Response: "readonly",
        Request: "readonly",
        Headers: "readonly",
        performance: "readonly",
      },
    },
    rules: {
      // The rule this exists for. An undeclared identifier is a crash waiting
      // for the line to run, and two of them were living in `services/`: a
      // worker that died after its first successful claim, and a cleanup path
      // whose ReferenceError escaped its own `.catch()` and replaced the error
      // it was cleaning up after.
      "no-undef": "error",
      // A warning on purpose. There are two dozen unused imports across
      // `services/`, none of which can break anything, and removing them here
      // would bury the change this branch is actually for in unrelated diffs.
      // They are visible, and they do not fail the gate.
      "no-unused-vars": ["warn", { args: "none", varsIgnorePattern: "^_" }],
    },
  },
];
