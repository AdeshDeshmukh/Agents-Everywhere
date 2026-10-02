import fs from "fs"
import { brand } from "./brand"

// Interactive mode hands the whole terminal to the engine's TUI, which draws
// on the alternate screen buffer. Anything this process writes to stderr lands
// on top of it, so once the TUI has the terminal the log goes to a file and the
// path is printed first.
let logFilePath: string | null = null

export function logToFile(filePath: string) {
  logFilePath = filePath
}

export function loggingToFile(): boolean {
  return logFilePath !== null
}

export function log(message: string) {
  const line = `[${brand().name}] ${message}\n`
  if (logFilePath) {
    try {
      fs.appendFileSync(logFilePath, line)
      return
    } catch {
      // A log that cannot be written is not worth failing a run over, and
      // stderr is still better than nothing.
    }
  }
  process.stderr.write(line)
}
