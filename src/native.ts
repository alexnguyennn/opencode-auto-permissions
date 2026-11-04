import { parseConfig } from "./config.ts"
import { collectReviewInput, latestUserModel } from "./context.ts"
import { writeDiagnostic } from "./diagnostics.ts"
import { generateStatelessDecision, type TextGenerator } from "./opencode-client.ts"
import {
  blockedMessage,
  createReviewState,
  decideReview,
  disposeReviewState,
  failureReason,
  rememberApproval,
  writeDecision,
  writeFailure,
  writeReceived,
} from "./reviewer.ts"
import type { PermissionRequest, ReviewModel, ReviewerClient, RuntimeContext } from "./types.ts"

/**
 * Structural types for the parts of the V2 server plugin context the native
 * path uses. The `permission.hook("evaluate")` seam and stateless
 * `generate.text` are newer than many installed plugin typings, and older
 * runtimes lack them entirely, so everything is feature-detected at setup.
 */
export interface NativeEvaluation {
  readonly sessionID: string
  readonly action: string
  readonly resources: ReadonlyArray<string>
  readonly metadata?: Record<string, unknown> | undefined
  readonly source?: { readonly type: string; readonly messageID: string; readonly id: string } | undefined
  effect: "allow" | "deny" | "ask"
  message?: string | undefined
}

interface NativeSessionInfo {
  readonly id: string
  readonly parentID?: string | undefined
  readonly model?: ReviewModel | undefined
}

type TextApi = { text?(input: { prompt: string; model: ReviewModel }, options: { signal: AbortSignal }): Promise<unknown> }

export interface NativeContext {
  readonly options: Readonly<Record<string, unknown>>
  readonly location?: { readonly directory?: string | undefined } | undefined
  readonly permission?: {
    hook?(
      name: "evaluate",
      callback: (event: NativeEvaluation) => Promise<void> | void,
    ): Promise<{ dispose(): Promise<void> | void }>
  } | undefined
  readonly session?: {
    context?(input: { sessionID: string }, options?: { signal?: AbortSignal }): Promise<readonly unknown[]>
    get?(input: { sessionID: string }, options?: { signal?: AbortSignal }): Promise<NativeSessionInfo>
  } | undefined
  readonly generate?: TextApi | undefined
  readonly experimental?: { readonly generate?: TextApi | undefined; readonly [key: string]: unknown } | undefined
}

const MAX_SESSION_DEPTH = 16

/**
 * Installs permission review as a server-side `evaluate` hook. The hook runs
 * before OpenCode broadcasts a pending permission, so an allow or deny set
 * here resolves the request without any TUI, web, or remote client having to
 * review it, and without a reviewer session. Returns `undefined` when the
 * runtime lacks the hook (or the APIs it needs) so callers can fall back to
 * the client-side reviewer.
 */
export async function installNativeReviewer(
  context: NativeContext,
): Promise<(() => Promise<void>) | undefined> {
  const hook = context.permission?.hook
  const generateText = resolveTextGenerator(context)
  if (typeof hook !== "function" || !generateText) return undefined
  if (typeof context.session?.context !== "function" || typeof context.session.get !== "function") return undefined

  const config = parseConfig(context.options)
  const state = createReviewState()
  const client: Pick<ReviewerClient, "generate"> = {
    generate: (input) => generateStatelessDecision(generateText, input),
  }
  let counter = 0
  writeDiagnostic(config.diagnosticsPath, {
    timestamp: new Date().toISOString(),
    event: "plugin_started",
  })

  const registration = await hook.call(context.permission, "evaluate", async (event) => {
    // Rules already allowed or denied this request; there is nothing to review.
    if (event.effect !== "ask") return

    const signal = state.controller.signal
    const startedAt = performance.now()
    const request: PermissionRequest = {
      id: `native_${++counter}`,
      sessionID: event.sessionID,
      action: event.action,
      resources: [...event.resources],
      // OpenCode offers no reusable pattern to the hook, so a session-scoped
      // approval is limited to repeats of exactly these resources.
      always: [...event.resources],
      ...(event.source?.type === "tool"
        ? { source: { type: "tool" as const, messageID: event.source.messageID, callID: event.source.id } }
        : {}),
      protocol: "v2",
    }
    writeReceived(config, request)

    try {
      const input = await collectNativeInput(context, config.userMessageCount, request, event, signal)
      if (signal.aborted) return
      const { decision, source, approvalKey } = await decideReview(client, config, request, input, state)
      if (signal.aborted) return
      rememberApproval(state, approvalKey, decision)

      if (config.shadow) {
        // Shadow mode only observes: the request keeps its "ask" effect.
        writeDecision(config, request, startedAt, decision, source)
        return
      }
      if (decision.kind === "deny") {
        event.effect = "deny"
        event.message = blockedMessage(decision.reason)
      } else {
        event.effect = "allow"
      }
      writeDecision(
        config,
        request,
        startedAt,
        decision,
        source,
        "replied",
        decision.kind === "allow_session" && approvalKey ? "session" : "once",
      )
    } catch (error) {
      // Disposal or cancellation leaves the request to the normal prompt.
      if (signal.aborted) return
      writeFailure(config, request, startedAt, error)
      if (config.shadow) return
      event.effect = "deny"
      event.message = blockedMessage(failureReason(error))
    }
  })

  return async () => {
    disposeReviewState(state)
    await registration.dispose()
  }
}

function resolveTextGenerator(context: NativeContext): TextGenerator | undefined {
  // Prefer the newer experimental alias; the top-level one is the older name.
  for (const api of [context.experimental?.generate, context.generate]) {
    if (api && typeof api.text === "function") return (input, options) => api.text!(input, options)
  }
  return undefined
}

async function collectNativeInput(
  context: NativeContext,
  userMessageCount: number,
  request: PermissionRequest,
  event: NativeEvaluation,
  signal: AbortSignal,
) {
  const contextFn = context.session!.context!.bind(context.session)
  const getFn = context.session!.get!.bind(context.session)
  const sessions = new Map<string, NativeSessionInfo>()
  const messages = new Map<string, unknown[]>()
  const fetchSession = async (sessionID: string) => {
    const known = sessions.get(sessionID)
    if (known) return known
    const info = await getFn({ sessionID }, { signal })
    sessions.set(sessionID, info)
    return info
  }

  // Adapts the server context to the shape the legacy collector reads. Each
  // read is fresh because `sync` always fetches the session context again.
  const runtime: RuntimeContext = {
    options: context.options,
    client: {},
    ...(context.location?.directory ? { location: { directory: context.location.directory } } : {}),
    data: {
      on: () => () => {},
      session: {
        async root(sessionID) {
          let current = sessionID
          for (let depth = 0; depth < MAX_SESSION_DEPTH; depth++) {
            const info = await fetchSession(current)
            if (!info.parentID) return current
            current = info.parentID
          }
          return current
        },
        get(sessionID) {
          const info = sessions.get(sessionID)
          return info ? { id: info.id, ...(info.parentID ? { parentID: info.parentID } : {}) } : undefined
        },
        message: {
          list: (sessionID) => messages.get(sessionID) ?? [],
          get: (sessionID, messageID) =>
            messages.get(sessionID)?.find((message) => isRecord(message) && message.id === messageID),
          async sync(sessionID) {
            messages.set(sessionID, [...(await contextFn({ sessionID }, { signal }))])
          },
        },
        permission: { list: () => undefined, sync: async () => {} },
      },
    },
  }

  const input = await collectReviewInput(runtime, request, userMessageCount)
  // The requesting session's own running model (including per-prompt
  // overrides) wins, then its selected model; the root session's model, which
  // the collector falls back to, is last so a child never inherits its parent's.
  const model = latestUserModel(messages.get(request.sessionID) ?? [])
    ?? sessionModel((await fetchSession(request.sessionID)).model)
    ?? input.context.model
  const toolInput = input.request.toolInput ?? metadataInput(event.metadata)
  return {
    request: {
      ...input.request,
      ...(toolInput !== undefined ? { toolInput } : {}),
    },
    context: {
      ...input.context,
      ...(model ? { model } : {}),
    },
  }
}

function sessionModel(model: ReviewModel | undefined): ReviewModel | undefined {
  if (!model || typeof model.providerID !== "string" || typeof model.id !== "string") return undefined
  return { providerID: model.providerID, id: model.id, ...(model.variant ? { variant: model.variant } : {}) }
}

/** Falls back to the evaluation's own metadata when the tool call is not in session context. */
function metadataInput(metadata: Record<string, unknown> | undefined): unknown {
  if (!metadata) return undefined
  return isRecord(metadata.input) ? metadata.input : metadata
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
