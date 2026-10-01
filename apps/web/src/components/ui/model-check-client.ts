"use client";

// The browser half of the model checks (Stage 12 W7): the three writes through
// the action route, and one poller for the checks they start.
//
// The poller asks `get_model_check` every 2 s (the contract's pace) for every
// check it was given, until the check is ready, refused or failed. A `waiting`
// check keeps being asked: it retries by itself. Nothing here cancels a check —
// a component that goes away stops asking, and the check runs on.
import { controlPlaneActionHeaders } from "@/lib/csrf-client";
import { checkRequestFromJson, checkSettled, pinResultFromJson, type CheckRequest, type CheckTrigger, type ModelCheck, type PinResult } from "@/lib/models";
import { useCallback, useEffect, useRef, useState } from "react";

export const CHECK_POLL_MS = 2000;

async function action(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch("/api/control-plane/actions", {
    method: "POST",
    headers: controlPlaneActionHeaders(),
    body: JSON.stringify(body),
  });
  const answer = await response.json().catch(() => ({}));
  if (!response.ok || !answer.ok) throw new Error(answer.error ?? "The request failed");
  return (answer.result ?? {}) as Record<string, unknown>;
}

export async function pinModelRequest(entryId: string, pinned: boolean): Promise<PinResult> {
  return pinResultFromJson(await action({ kind: pinned ? "model_pin" : "model_unpin", entryId }));
}

export async function requestModelCheckRequest(entryId: string, trigger: CheckTrigger): Promise<CheckRequest> {
  return checkRequestFromJson(await action({ kind: "model_check", entryId, trigger }));
}

export type WatchedCheck = {
  checkId: string; entryId: string; since: number;
  check: ModelCheck | null;
  /** The last poll failed; the next one is still coming. */
  unreachable: boolean;
};

// Checks being watched, by entry. `watch` starts (or restarts) one; `onSettled`
// hears each once, when it stops moving.
export function useModelChecks(onSettled?: (check: ModelCheck) => void) {
  const [watched, setWatched] = useState<Record<string, WatchedCheck>>({});
  const current = useRef(watched);
  const settledHandler = useRef(onSettled);
  useEffect(() => { current.current = watched; }, [watched]);
  useEffect(() => { settledHandler.current = onSettled; }, [onSettled]);

  const watch = useCallback((entryId: string, checkId: string) => {
    setWatched((all) => ({ ...all, [entryId]: { checkId, entryId, since: Date.now(), check: null, unreachable: false } }));
  }, []);

  const forget = useCallback((entryId: string) => {
    setWatched((all) => {
      const next = { ...all };
      delete next[entryId];
      return next;
    });
  }, []);

  const polling = Object.values(watched).some((entry) => !entry.check || !checkSettled(entry.check.state));

  useEffect(() => {
    if (!polling) return;
    let stopped = false;
    const poll = async () => {
      const open = Object.values(current.current).filter((entry) => !entry.check || !checkSettled(entry.check.state));
      await Promise.all(open.map(async (entry) => {
        try {
          const response = await fetch(`/api/control-plane/models/checks/${entry.checkId}`, { cache: "no-store" });
          const answer = await response.json().catch(() => ({}));
          if (!response.ok || !answer.ok || !answer.check) throw new Error(answer.error ?? "unreachable");
          const check = answer.check as ModelCheck;
          if (stopped) return;
          setWatched((all) => all[entry.entryId]?.checkId === entry.checkId
            ? { ...all, [entry.entryId]: { ...all[entry.entryId], check, unreachable: false } } : all);
          if (checkSettled(check.state)) settledHandler.current?.(check);
        } catch {
          if (stopped) return;
          setWatched((all) => all[entry.entryId]?.checkId === entry.checkId
            ? { ...all, [entry.entryId]: { ...all[entry.entryId], unreachable: true } } : all);
        }
      }));
    };
    const timer = window.setInterval(poll, CHECK_POLL_MS);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [polling]);

  return { watched, watch, forget };
}

// A clock for "checking… 18 s" and "2 h ago": starts at the instant the caller
// gives (the moment the page read its data, the same on server and client) and
// ticks while mounted.
export function useClock(start: number, everyMs: number) {
  const [now, setNow] = useState(start);
  useEffect(() => {
    const first = window.setTimeout(() => setNow(Date.now()), 0);
    const timer = window.setInterval(() => setNow(Date.now()), everyMs);
    return () => { window.clearTimeout(first); window.clearInterval(timer); };
  }, [everyMs]);
  return now;
}
