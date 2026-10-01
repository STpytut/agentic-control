// What a launch says about itself, for record_runtime_dispatch (WP-9c, 0071).
//
// Only what the launcher knows and the database cannot: the driver's name and
// executable, the adapter version it was verified at, the runtime version this
// host runs, whether that is the verified pair, and every capability the driver
// declares. The assignment, the access mode, the grant and the session the
// database takes from the run's grant and the run itself — a launcher does not
// get to say them.
//
// The capability list is the driver's declaration, whole: it is what the panel
// reads to decide whether a running job can be stopped, so trimming it here
// would hide a Stop button the driver promises (rc.38's Codex turn).

// The reasoning level is the one the launch sends (Stage 12, 0111): recorded
// beside the model, and absent when none is sent.
export function launchProvenance(driver, verification, { surface, model = null, nativeSessionId = null, reasoningEffort = null } = {}) {
  return {
    runtime: driver.name,
    executable: driver.executable,
    surface,
    adapter_version: verification?.adapter_version ?? driver.verified.adapterVersion,
    runtime_version: verification?.runtime_version ?? null,
    verified_runtime_version: verification?.verified_runtime_version ?? driver.verified.runtimeVersion,
    capability_verification: verification?.status === "verified" ? "verified" : "unverified",
    capabilities: Object.keys(driver.capabilities).sort(),
    model,
    native_session_id: nativeSessionId,
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
  };
}
