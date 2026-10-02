import { Context } from "effect"
import type { InstanceContext } from "@/project/instance-context"
import type { WorkspaceV2 } from "@agents-everywhere/core/workspace"

export const InstanceRef = Context.Reference<InstanceContext | undefined>("~agents-everywhere/InstanceRef", {
  defaultValue: () => undefined,
})

export const WorkspaceRef = Context.Reference<WorkspaceV2.ID | undefined>("~agents-everywhere/WorkspaceRef", {
  defaultValue: () => undefined,
})
