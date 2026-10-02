import { defineConfig } from "drizzle-kit"
import os from "os"
import path from "path"

export default defineConfig({
  dialect: "sqlite",
  schema: ["./src/**/*.sql.ts", "./src/**/sql.ts"],
  out: "./migration",
  dbCredentials: {
    url: path.join(os.homedir(), ".local/share/agents-everywhere/agents-everywhere.db"),
  },
})
