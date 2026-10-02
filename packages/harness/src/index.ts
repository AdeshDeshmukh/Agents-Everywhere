import { configureBrand, OPEN_SOURCE_BRAND } from "./brand"
import { log } from "./log"
import { runRunner } from "./run"

configureBrand(OPEN_SOURCE_BRAND)

runRunner(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    log(`Fatal: ${err && err.stack ? err.stack : err}`)
    process.exit(1)
  },
)
