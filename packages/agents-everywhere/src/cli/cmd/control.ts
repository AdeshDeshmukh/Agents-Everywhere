import { Effect } from "effect"
import { effectCmd } from "../effect-cmd"

export const ControlCommand = effectCmd({
  command: "control",
  describe: "run a control plane: create agents, install them on other machines, and watch and steer their runs",
  builder: (yargs) =>
    yargs
      .option("port", { type: "number", describe: "port to listen on", default: 4800 })
      .option("hostname", { type: "string", describe: "address to listen on", default: "127.0.0.1" })
      .option("data", {
        type: "string",
        describe: "directory for the database and key (default ~/.local/share/agents-everywhere-control)",
      })
      .option("public-url", {
        type: "string",
        describe: "the URL machines use to reach this server; install commands point here",
      })
      .option("binaries", { type: "string", describe: "serve engine builds from <dir>/<platform>/agents-everywhere" })
      .option("tls-cert", { type: "string", describe: "TLS certificate file" })
      .option("tls-key", { type: "string", describe: "TLS private key file" })
      .option("insecure", {
        type: "boolean",
        describe: "allow plain HTTP beyond localhost, for use behind a TLS-terminating proxy",
      })
      .option("rotate-admin-token", {
        type: "boolean",
        describe: "issue a new admin token and sign out every session",
      }),
  // Nothing here runs an agent session, so no project instance is needed.
  instance: false,
  handler: Effect.fn("Cli.control")(function* (args) {
    const { runControl } = yield* Effect.promise(() => import("@agents-everywhere/control"))
    yield* Effect.promise(() =>
      runControl({
        port: args.port,
        hostname: args.hostname,
        data: args.data,
        publicUrl: args["public-url"],
        binaries: args.binaries,
        tlsCert: args["tls-cert"],
        tlsKey: args["tls-key"],
        insecure: args.insecure,
        rotateAdminToken: args["rotate-admin-token"],
      }),
    )
    yield* Effect.never
  }),
})
