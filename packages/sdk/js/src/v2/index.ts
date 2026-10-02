export * from "./client.js"
export * from "./server.js"

import { createAgentsEverywhereClient } from "./client.js"
import { createAgentsEverywhereServer } from "./server.js"
import type { ServerOptions } from "./server.js"

export * as data from "./data.js"

export async function createAgentsEverywhere(options?: ServerOptions) {
  const server = await createAgentsEverywhereServer({
    ...options,
  })

  const client = createAgentsEverywhereClient({
    baseUrl: server.url,
  })

  return {
    client,
    server,
  }
}
