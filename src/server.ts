import { Plugin as V2Plugin } from "@opencode-ai/plugin"
import { buildReviewerSystemPrompt, REVIEWER_AGENT_ID } from "./agent.ts"
import { parseConfig } from "./config.ts"
import { installNativeReviewer } from "./native.ts"
import { installReviewer } from "./reviewer.ts"
import { createStableRuntime, protocolForVersion } from "./stable.ts"

const v2Plugin = V2Plugin.define({
  id: "opencode.auto-permissions.server",
  async setup(context) {
    const config = parseConfig(context.options)
    const systemPrompt = buildReviewerSystemPrompt(config.reviewerInstructions)
    await context.agent.transform((draft) => {
      draft.update(REVIEWER_AGENT_ID, (agent) => {
        if (config.model) agent.model = config.model as unknown as typeof agent.model
        agent.system = systemPrompt
        agent.description = "Hidden, no-tool permission reviewer used by OpenCode Auto Permissions."
        agent.mode = "subagent"
        agent.hidden = true
        agent.steps = 1
        agent.permissions = [{ action: "*", resource: "*", effect: "deny" }]
      })
    })
    // Current V2 runtimes let the server resolve "ask" requests before any
    // client sees them. Older V2 betas lack the hook; there this returns
    // undefined and the TUI plugin remains the reviewer.
    return await installNativeReviewer(context)
  },
})

/**
 * Structural types for the stable v1 server plugin API. The current plugin
 * package dropped the v1 declarations, so the shapes the stable runtime
 * validates and calls are kept locally.
 */
export interface LegacyPluginInput {
  readonly client: unknown
  readonly directory: string
}

export interface LegacyPluginConfig {
  agent?: Record<string, Record<string, unknown>>
}

export interface LegacyChatMessageInput {
  sessionID: string
  agent?: string
  [key: string]: unknown
}

export interface LegacySystemTransformInput {
  sessionID?: string
  [key: string]: unknown
}

export interface LegacyEventInput {
  event: unknown
  [key: string]: unknown
}

export interface LegacyPluginHooks {
  config?(value: LegacyPluginConfig, ...args: unknown[]): Promise<void> | void
  "chat.message"?(input: LegacyChatMessageInput, ...args: unknown[]): Promise<void> | void
  "experimental.chat.system.transform"?(
    input: LegacySystemTransformInput,
    output: { system: string[] },
    ...args: unknown[]
  ): Promise<void> | void
  event?(input: LegacyEventInput, ...args: unknown[]): Promise<void> | void
  dispose?(...args: unknown[]): Promise<void> | void
}

export type LegacyPlugin = (
  input: LegacyPluginInput,
  options?: Readonly<Record<string, unknown>>,
) => Promise<LegacyPluginHooks>

export interface PluginModule {
  id?: string
  setup?: unknown
  server: LegacyPlugin
}

const legacyPlugin: LegacyPlugin = async (input, options = {}) => {
  const config = parseConfig(options)
  const systemPrompt = buildReviewerSystemPrompt(config.reviewerInstructions)
  const reviewerSessions = new Map<string, ReturnType<typeof setTimeout>>()
  const stable = createStableRuntime(input.client, options, input.directory)
  let stopStableReviewer: (() => void) | undefined
  let detectedProtocol: "stable" | "v2" | undefined
  const ownsStable = async () => {
    if (config.runtime !== "auto") return config.runtime === "stable"
    if (detectedProtocol) return detectedProtocol === "stable"
    const detected = protocolForVersion(await stable.version())
    if (detected) detectedProtocol = detected
    return detected === "stable"
  }
  const startStableReviewer = async () => {
    if (!(await ownsStable())) return false
    stopStableReviewer ??= installReviewer(stable.context, { protocols: ["stable"] })
    return true
  }
  return {
    async config(value: LegacyPluginConfig) {
      value.agent ??= {}
      const reviewer = {
        ...(config.model ? { model: `${config.model.providerID}/${config.model.id}` } : {}),
        ...(config.model?.variant ? { variant: config.model.variant } : {}),
        prompt: systemPrompt,
        description: "Hidden, no-tool permission reviewer used by OpenCode Auto Permissions.",
        mode: "subagent",
        hidden: true,
        steps: 1,
        tools: { "*": false },
        permission: { "*": "deny" },
      }
      // The beta runtime accepts wildcard permission keys through its rest
      // schema, but the generated AgentConfig declaration omits that index.
      value.agent[REVIEWER_AGENT_ID] = reviewer
    },
    async "chat.message"(input: LegacyChatMessageInput) {
      if (input.agent !== REVIEWER_AGENT_ID) return
      clearTimeout(reviewerSessions.get(input.sessionID))
      const expiry = setTimeout(() => reviewerSessions.delete(input.sessionID), 60_000)
      expiry.unref()
      reviewerSessions.set(input.sessionID, expiry)
    },
    async "experimental.chat.system.transform"(
      input: LegacySystemTransformInput,
      output: { system: string[] },
    ) {
      if (!input.sessionID || !reviewerSessions.has(input.sessionID)) return
      output.system.splice(0, output.system.length, systemPrompt)
    },
    async event(input: LegacyEventInput) {
      detectedProtocol ??= protocolForVersion(eventVersion(input.event))
      if (!(await startStableReviewer())) return
      stable.emit(input.event)
    },
    async dispose() {
      stopStableReviewer?.()
      stable.dispose()
      for (const expiry of reviewerSessions.values()) clearTimeout(expiry)
      reviewerSessions.clear()
    },
  }
}

function eventVersion(event: unknown): string | undefined {
  if (typeof event !== "object" || event === null) return undefined
  const payload = Reflect.get(event, "properties") ?? Reflect.get(event, "data")
  if (typeof payload !== "object" || payload === null) return undefined
  const info = Reflect.get(payload, "info")
  return typeof info === "object" && info !== null && typeof Reflect.get(info, "version") === "string"
    ? Reflect.get(info, "version")
    : undefined
}

const serverPlugin = {
  ...v2Plugin,
  server: legacyPlugin,
} as typeof v2Plugin & PluginModule

export { legacyPlugin }
export default serverPlugin
