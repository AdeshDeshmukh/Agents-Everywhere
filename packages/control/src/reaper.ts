/**
 * Ends runs that can no longer end themselves. Only a run's own token may
 * finish it, so a runner that is killed, loses its network or has its machine
 * switched off leaves its run "running" for good; an install command that was
 * never used leaves a "pending" run behind in the same way.
 *
 * A backstop, not a signal: nothing says a machine went away, so the only
 * evidence is silence, and the sweep interval is set against the silence it
 * waits for rather than for promptness. Do not speed it up to make runs end
 * sooner; nothing is lost until the window has passed.
 */
import { BOOTSTRAP_TOKEN_SECONDS } from "./crypto"
import type { Store } from "./store"

// A runner beats every 10 seconds from before it downloads the agent until it
// exits, so five minutes is thirty missed beats: a machine that is gone, not a
// network that hiccupped.
export const LOST_AFTER_MS = 5 * 60_000
// A single-use install command lives five minutes; past that its run can never be claimed.
const UNCLAIMED_AFTER_MS = BOOTSTRAP_TOKEN_SECONDS * 1000 + 5 * 60_000
const SWEEP_INTERVAL_MS = 60_000

const LOST_MESSAGE =
  `Lost contact with this machine: it stopped checking in for ${LOST_AFTER_MS / 60_000} minutes, so the run was ended. ` +
  "If the agent is somehow still running there, it will stop when it next tries to report."

export function sweep(store: Store, now = Date.now()) {
  const lost = store.reapSilentRuns(new Date(now - LOST_AFTER_MS), LOST_MESSAGE)
  const unclaimed = store.reapUnclaimedRuns(new Date(now - UNCLAIMED_AFTER_MS))
  store.purgeExpiredSessions()
  return { lost, unclaimed }
}

/** Starts the sweep on its own timer. The returned function stops it. */
export function startReaper(store: Store, log: (line: string) => void): () => void {
  const timer = setInterval(() => {
    try {
      const { lost, unclaimed } = sweep(store)
      if (lost || unclaimed)
        log(`Ended ${lost} run(s) that lost contact and removed ${unclaimed} unused install command(s).`)
    } catch (err) {
      // A failed sweep is retried on the next tick; housekeeping must not take the server down.
      log(`Run sweep failed: ${err}`)
    }
  }, SWEEP_INTERVAL_MS)
  timer.unref()
  return () => clearInterval(timer)
}
