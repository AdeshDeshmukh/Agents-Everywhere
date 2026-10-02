export * as ServerAuth from "./auth"

import { ConfigService } from "@/effect/config-service"
import { Flag } from "@agents-everywhere/core/flag/flag"
import { Config as EffectConfig, Context, Option, Redacted } from "effect"

export type Credentials = {
  password?: string
  username?: string
}

export type DecodedCredentials = {
  readonly username: string
  readonly password: Redacted.Redacted
}

export class Config extends ConfigService.Service<Config>()("@agents-everywhere/ServerAuthConfig", {
  password: EffectConfig.string("AGENTS_EVERYWHERE_SERVER_PASSWORD").pipe(EffectConfig.option),
  username: EffectConfig.string("AGENTS_EVERYWHERE_SERVER_USERNAME").pipe(EffectConfig.withDefault("agents-everywhere")),
}) {}

export type Info = Context.Service.Shape<typeof Config>

export function required(config: Info) {
  return Option.isSome(config.password) && config.password.value !== ""
}

export function authorized(credentials: DecodedCredentials, config: Info) {
  return (
    Option.isSome(config.password) &&
    credentials.username === config.username &&
    Redacted.value(credentials.password) === config.password.value
  )
}

export function header(credentials?: Credentials) {
  const password = credentials?.password ?? Flag.AGENTS_EVERYWHERE_SERVER_PASSWORD
  if (!password) return undefined

  const username = credentials?.username ?? Flag.AGENTS_EVERYWHERE_SERVER_USERNAME ?? "agents-everywhere"
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
}

export function headers(credentials?: Credentials) {
  const authorization = header(credentials)
  if (!authorization) return undefined
  return { Authorization: authorization }
}
