import { Flag } from "@agents-everywhere/core/flag/flag"
import { Effect } from "effect"
import path from "path"

const preserveExerciseGlobalRoot = !!process.env.AGENTS_EVERYWHERE_HTTPAPI_EXERCISE_GLOBAL
export const exerciseGlobalRoot =
  process.env.AGENTS_EVERYWHERE_HTTPAPI_EXERCISE_GLOBAL ??
  path.join(process.env.TMPDIR ?? "/tmp", `agents-everywhere-httpapi-global-${process.pid}`)
process.env.XDG_DATA_HOME = path.join(exerciseGlobalRoot, "data")
process.env.XDG_CONFIG_HOME = path.join(exerciseGlobalRoot, "config")
process.env.XDG_STATE_HOME = path.join(exerciseGlobalRoot, "state")
process.env.XDG_CACHE_HOME = path.join(exerciseGlobalRoot, "cache")
process.env.AGENTS_EVERYWHERE_DISABLE_SHARE = "true"
export const exerciseConfigDirectory = path.join(exerciseGlobalRoot, "config", "agents-everywhere")
export const exerciseDataDirectory = path.join(exerciseGlobalRoot, "data", "agents-everywhere")

const preserveExerciseDatabase = !!process.env.AGENTS_EVERYWHERE_HTTPAPI_EXERCISE_DB
export const exerciseDatabasePath =
  process.env.AGENTS_EVERYWHERE_HTTPAPI_EXERCISE_DB ??
  path.join(process.env.TMPDIR ?? "/tmp", `agents-everywhere-httpapi-exercise-${process.pid}.db`)
process.env.AGENTS_EVERYWHERE_DB = exerciseDatabasePath
Flag.AGENTS_EVERYWHERE_DB = exerciseDatabasePath

export const original = {
  AGENTS_EVERYWHERE_SERVER_PASSWORD: Flag.AGENTS_EVERYWHERE_SERVER_PASSWORD,
  AGENTS_EVERYWHERE_SERVER_USERNAME: Flag.AGENTS_EVERYWHERE_SERVER_USERNAME,
}

export const cleanupExercisePaths = Effect.promise(async () => {
  const fs = await import("fs/promises")
  if (!preserveExerciseDatabase) {
    await Promise.all(
      [exerciseDatabasePath, `${exerciseDatabasePath}-wal`, `${exerciseDatabasePath}-shm`].map((file) =>
        fs.rm(file, { force: true }).catch(() => undefined),
      ),
    )
  }
  if (!preserveExerciseGlobalRoot)
    await fs.rm(exerciseGlobalRoot, { recursive: true, force: true }).catch(() => undefined)
})
