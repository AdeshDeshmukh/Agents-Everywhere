import path from "path"

process.env.AGENTS_EVERYWHERE_DB = ":memory:"
process.env.NPM_CONFIG_AUDIT = "false"
process.env.AGENTS_EVERYWHERE_MODELS_PATH = path.join(import.meta.dir, "plugin", "fixtures", "models-dev.json")
process.env.AGENTS_EVERYWHERE_DISABLE_MODELS_FETCH = "true"
