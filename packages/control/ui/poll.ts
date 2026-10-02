/**
 * Refreshes a view while it is on screen. Nothing pushes changes to the page,
 * so this is the only way it learns a run moved on; it pauses while the tab is
 * hidden and stops when the view is left.
 */
export function poll(intervalMs: number, tick: () => Promise<void>): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const schedule = () => {
    if (!stopped) timer = setTimeout(run, intervalMs)
  }
  const run = async () => {
    if (stopped) return
    if (document.visibilityState === "visible") {
      try {
        await tick()
      } catch {
        // The next tick retries; a failed refresh must not stop the view updating.
      }
    }
    schedule()
  }
  const onVisible = () => {
    if (document.visibilityState === "visible") {
      clearTimeout(timer)
      void run()
    }
  }
  document.addEventListener("visibilitychange", onVisible)
  schedule()
  return () => {
    stopped = true
    clearTimeout(timer)
    document.removeEventListener("visibilitychange", onVisible)
  }
}
