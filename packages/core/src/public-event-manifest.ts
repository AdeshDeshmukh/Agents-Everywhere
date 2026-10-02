export * as PublicEventManifest from "./public-event-manifest"

import { Event } from "@agents-everywhere/schema/event"
import { EventManifest } from "@agents-everywhere/schema/event-manifest"

export const Definitions = EventManifest.ServerDefinitions
export const Latest = Event.latest(Definitions)
