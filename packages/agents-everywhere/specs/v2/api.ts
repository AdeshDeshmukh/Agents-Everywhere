// @ts-nocheck

import { AgentsEverywhere } from "@agentsEverywhere/core"
import { ReadTool } from "@agentsEverywhere/core/tools"

const agentsEverywhere = AgentsEverywhere.make({})

agentsEverywhere.tool.add(ReadTool)

agentsEverywhere.tool.add({
  name: "bash",
  schema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The command to run.",
      },
    },
    required: ["command"],
  },
  execute(input, ctx) {},
})

agentsEverywhere.auth.add({
  provider: "openai",
  type: "api",
  value: process.env.OPENAI_API_KEY,
})

agentsEverywhere.agent.add({
  name: "build",
  permissions: [],
  model: {
    id: "gpt-5-5",
    provider: "openai",
    variant: "xhigh",
  },
})

const sessionID = await agentsEverywhere.session.create({
  agent: "build",
})

agentsEverywhere.subscribe((event) => {
  console.log(event)
})

await agentsEverywhere.session.prompt({
  sessionID,
  text: "hey what is up",
})

await agentsEverywhere.session.prompt({
  sessionID,
  text: "what is up with this",
  files: [
    {
      mime: "image/png",
      uri: "data:image/png;base64,xxxx",
    },
  ],
})

await agentsEverywhere.session.wait()

console.log(await agentsEverywhere.session.messages(sessionID))
