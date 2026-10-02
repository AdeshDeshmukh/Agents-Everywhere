import { AgentV2 } from "@agents-everywhere/core/agent"
import { AISDK } from "@agents-everywhere/core/aisdk"
import { Catalog } from "@agents-everywhere/core/catalog"
import { CommandV2 } from "@agents-everywhere/core/command"
import { Credential } from "@agents-everywhere/core/credential"
import { AppNodeBuilder } from "@agents-everywhere/core/effect/app-node-builder"
import { LayerNodePlatform } from "@agents-everywhere/core/effect/app-node-platform"
import { LayerNode } from "@agents-everywhere/core/effect/layer-node"
import { EventV2 } from "@agents-everywhere/core/event"
import { FileSystem } from "@agents-everywhere/core/filesystem"
import { FSUtil } from "@agents-everywhere/core/fs-util"
import { Integration } from "@agents-everywhere/core/integration"
import { Location } from "@agents-everywhere/core/location"
import { Npm } from "@agents-everywhere/core/npm"
import { PluginV2 } from "@agents-everywhere/core/plugin"
import { Reference } from "@agents-everywhere/core/reference"
import { SkillV2 } from "@agents-everywhere/core/skill"
import { Effect, Layer } from "effect"
import { tempLocationLayer } from "../fixture/location"

const npmLayer = Layer.succeed(
  Npm.Service,
  Npm.Service.of({
    add: () => Effect.succeed({ directory: "", entrypoint: undefined }),
    install: () => Effect.void,
    which: () => Effect.succeed(undefined),
  }),
)

export const PluginTestLayer = AppNodeBuilder.build(
  LayerNode.group([
    FileSystem.node,
    FSUtil.node,
    Location.node,
    Npm.node,
    Credential.node,
    EventV2.node,
    LayerNodePlatform.httpClient,
    PluginV2.node,
    AgentV2.node,
    AISDK.node,
    Catalog.node,
    CommandV2.node,
    Integration.node,
    Reference.node,
    SkillV2.node,
  ]),
  [
    [Location.node, tempLocationLayer],
    [Npm.node, npmLayer],
  ],
)
