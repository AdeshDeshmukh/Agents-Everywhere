import os from "os"
import path from "path"

/**
 * Everything that differs between one distribution of the runner and another:
 * what it calls itself, where it keeps its files, and which environment
 * variables it reads. The entry file picks one before anything else runs, so
 * no module needs to know which distribution it is part of.
 */
export interface Brand {
  /** Prefix on every log line and the preflight report. */
  readonly name: string
  /** Directory under the home directory for the engine binary, run configs and logs. */
  readonly homeDirName: string
  /** Names the control plane when the install command did not pass --api-url. */
  readonly apiUrlEnv: string
  readonly defaultApiUrl: string
  /** Set to "1" to exercise the reporting loop without running the engine. */
  readonly dryRunEnv: string
  /** Read by install.sh: where to put the runner script. */
  readonly installHomeEnv: string
  /** Read by install.sh: fetch the runner from here instead of the control plane. */
  readonly runnerSourceEnv: string
}

// Its own directory rather than the engine's: a person can install the engine
// by hand as well, and the runner must never overwrite that copy.
export const OPEN_SOURCE_BRAND: Brand = {
  name: "agents-everywhere-runner",
  homeDirName: ".agents-everywhere-runner",
  apiUrlEnv: "AGENTS_EVERYWHERE_CONTROL_URL",
  defaultApiUrl: "http://localhost:4800",
  dryRunEnv: "AGENTS_EVERYWHERE_RUNNER_DRY_RUN",
  installHomeEnv: "AGENTS_EVERYWHERE_RUNNER_HOME",
  runnerSourceEnv: "AGENTS_EVERYWHERE_RUNNER_SOURCE",
}

let current: Brand = OPEN_SOURCE_BRAND

export function configureBrand(brand: Brand) {
  current = brand
}

export function brand(): Brand {
  return current
}

export function runnerHome(): string {
  return path.join(os.homedir(), current.homeDirName)
}
