import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { REVIEWER_SYSTEM_PROMPT } from "../src/agent.ts"
import { installNativeReviewer, type NativeContext, type NativeEvaluation } from "../src/native.ts"
import server from "../src/server.ts"

type Model = { providerID: string; id: string; variant?: string }
type TextCall = { prompt: string; model: Model; signal: AbortSignal }
type Respond = (call: TextCall, index: number) => Promise<unknown> | unknown

const SESSION_MODEL = { providerID: "example", id: "main" }

function allow(extra: Record<string, unknown> = {}) {
  return { decision: "allow", reasonCode: "requested_action", reason: "The user requested this action.", ...extra }
}

function deny() {
  return { decision: "deny", reasonCode: "not_authorized", reason: "Not authorized." }
}

function harness(options: Record<string, unknown> = {}, config: { withHook?: boolean; experimental?: boolean; both?: boolean } = {}) {
  const calls: TextCall[] = []
  const diagnostics: string[] = []
  let respond: Respond = () => allow()
  let evaluate: ((event: NativeEvaluation) => Promise<void> | void) | undefined
  let disposed = 0
  let sessionCreates = 0
  const sessions: Record<string, { id: string; parentID?: string; model?: Model }> = {
    ses_root: { id: "ses_root" },
  }
  const messages: Record<string, unknown[]> = {}
  const assistant = {
    id: "msg_assistant",
    type: "assistant",
    time: { created: 2 },
    model: SESSION_MODEL,
    content: [{ id: "call_1", type: "tool", state: { status: "running", input: { command: "<set>" }, content: [] } }],
  }
  messages.ses_root = [{ id: "msg_user", type: "user", time: { created: 1 }, text: "Run the tests." }, assistant]

  const text = async (input: { prompt: string; model: Model }, request: { signal: AbortSignal }) => {
    const call = { prompt: input.prompt, model: input.model, signal: request.signal }
    calls.push(call)
    const result = await respond(call, calls.length - 1)
    return { text: typeof result === "string" ? result : JSON.stringify(result) }
  }

  const deprecatedCalls: unknown[] = []
  const deprecatedText = async (input: unknown) => {
    deprecatedCalls.push(input)
    return { text: JSON.stringify(allow()) }
  }

  const context: NativeContext = {
    options,
    location: { directory: "/repo" },
    ...(config.withHook === false
      ? {}
      : {
          permission: {
            async hook(_name, callback) {
              evaluate = callback
              return { dispose: () => void disposed++ }
            },
          },
        }),
    session: {
      context: async ({ sessionID }) => messages[sessionID] ?? [],
      get: async ({ sessionID }) => sessions[sessionID] ?? { id: sessionID },
      // A native review must never need a reviewer session.
      create: async () => void sessionCreates++,
    } as NativeContext["session"],
    ...(config.both
      ? { experimental: { generate: { text } }, generate: { text: deprecatedText } }
      : config.experimental
        ? { experimental: { generate: { text } } }
        : { generate: { text } }),
  }

  const event = (resource = "git push origin feature", overrides: Partial<NativeEvaluation> = {}): NativeEvaluation => {
    assistant.content[0]!.state.input = { command: resource }
    return {
      sessionID: "ses_root",
      action: "shell",
      resources: [resource],
      source: { type: "tool", messageID: "msg_assistant", id: "call_1" },
      effect: "ask",
      ...overrides,
    }
  }

  return {
    context,
    calls,
    deprecatedCalls,
    sessions,
    messages,
    event,
    diagnostics,
    setRespond: (value: Respond) => void (respond = value),
    get disposed() { return disposed },
    get sessionCreates() { return sessionCreates },
    evaluate: async (value: NativeEvaluation) => {
      await evaluate!(value)
      return value
    },
    fire: (value: NativeEvaluation) => evaluate!(value),
    install: () => installNativeReviewer(context),
  }
}

async function settle(ms = 10) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

describe("native server review", () => {
  test("does not install without the evaluate hook or stateless generation", async () => {
    expect(await installNativeReviewer(harness({}, { withHook: false }).context)).toBeUndefined()
    const app = harness({})
    const stripped = { ...app.context, generate: undefined }
    expect(await installNativeReviewer(stripped)).toBeUndefined()
  })

  test("is registered by the server plugin setup and cleaned up on dispose", async () => {
    const app = harness({})
    const registered: Array<() => Promise<void> | void> = []
    const agentContext = {
      ...app.context,
      agent: { transform: async () => ({ dispose() {} }) },
    }
    const cleanup = await (server.setup as (context: unknown) => Promise<(() => Promise<void>) | undefined>)(agentContext)
    expect(typeof cleanup).toBe("function")
    registered.push(cleanup!)
    await cleanup!()
    expect(app.disposed).toBe(1)
  })

  test("allows with one stateless review and creates no reviewer session", async () => {
    const app = harness({ model: "reviewer/fast", variant: "low" })
    await app.install()
    const event = await app.evaluate(app.event())

    expect(event.effect).toBe("allow")
    expect(app.calls).toHaveLength(1)
    expect(app.calls[0]!.model).toEqual({ providerID: "reviewer", id: "fast", variant: "low" })
    expect(app.calls[0]!.prompt).toContain(REVIEWER_SYSTEM_PROMPT)
    expect(app.calls[0]!.prompt).toContain("git push origin feature")
    expect(app.sessionCreates).toBe(0)
  })

  test("denies with an actionable message", async () => {
    const app = harness({ model: "reviewer/fast" })
    app.setRespond(() => deny())
    await app.install()
    const event = await app.evaluate(app.event())

    expect(event.effect).toBe("deny")
    expect(event.message).toBe("Auto Permissions blocked this action: Not authorized.")
  })

  test.each(["allow", "deny"] as const)("skips requests rules already resolved as %s", async (effect) => {
    const app = harness({ model: "reviewer/fast" })
    await app.install()
    const event = await app.evaluate(app.event("git push origin feature", { effect }))

    expect(event.effect).toBe(effect)
    expect(app.calls).toHaveLength(0)
  })

  test("prefers the experimental stateless alias when present", async () => {
    const app = harness({ model: "reviewer/fast" }, { experimental: true })
    await app.install()
    expect((await app.evaluate(app.event())).effect).toBe("allow")
    expect(app.calls).toHaveLength(1)
  })

  test("prefers the experimental alias when both aliases exist", async () => {
    const app = harness({ model: "reviewer/fast" }, { both: true })
    await app.install()
    expect((await app.evaluate(app.event())).effect).toBe("allow")
    expect(app.calls).toHaveLength(1)
    expect(app.deprecatedCalls).toHaveLength(0)
  })

  test("a child session uses its own model, never its parent's", async () => {
    const parent = { providerID: "parent-provider", id: "parent-model", variant: "parent-variant" }
    const child = { providerID: "child-provider", id: "child-model", variant: "child-variant" }
    const setup = async (options: Record<string, unknown>) => {
      const app = harness(options)
      app.messages.ses_root = [
        { id: "msg_user", type: "user", text: "Run the tests." },
        { id: "msg_parent", type: "assistant", model: parent, content: [] },
      ]
      app.sessions.ses_child = { id: "ses_child", parentID: "ses_root", model: child }
      app.messages.ses_child = [{ id: "m1", type: "user", text: "Subagent task." }]
      await app.install()
      return app
    }
    const request = (app: Awaited<ReturnType<typeof setup>>) =>
      app.event("git push origin feature", { sessionID: "ses_child", source: undefined })

    // No model-bearing child message: the child's selected model beats the parent's.
    const selected = await setup({})
    await selected.evaluate(request(selected))
    expect(selected.calls.map((call) => call.model)).toEqual([child])

    // A configured variant replaces the selected model's variant only.
    const varied = await setup({ variant: "reviewer-variant" })
    await varied.evaluate(request(varied))
    expect(varied.calls.map((call) => call.model)).toEqual([{ ...child, variant: "reviewer-variant" }])

    // The child's own running message outranks its session's selected model.
    const running = await setup({})
    running.messages.ses_child!.push({
      id: "m2",
      type: "assistant",
      model: { providerID: "running-provider", id: "running-model", variant: "running-variant" },
      content: [],
    })
    await running.evaluate(request(running))
    expect(running.calls.map((call) => call.model)).toEqual([
      { providerID: "running-provider", id: "running-model", variant: "running-variant" },
    ])

    // Only when the child has no model at all does the root fallback apply.
    const inherited = await setup({})
    delete inherited.sessions.ses_child!.model
    await inherited.evaluate(request(inherited))
    expect(inherited.calls.map((call) => call.model)).toEqual([parent])

    // A configured reviewer model keeps precedence and falls back to the child's model.
    const configured = await setup({ model: "reviewer/fast", variant: "reviewer-only" })
    configured.setRespond((_call, index) => {
      if (index === 0) throw new Error("provider unavailable")
      return allow()
    })
    await configured.evaluate(request(configured))
    expect(configured.calls.map((call) => call.model)).toEqual([
      { providerID: "reviewer", id: "fast", variant: "reviewer-only" },
      child,
    ])
  })

  test("uses the model running the request, then the session model", async () => {
    const running = harness({})
    await running.install()
    await running.evaluate(running.event())
    expect(running.calls[0]!.model).toEqual(SESSION_MODEL)

    const selected = harness({ variant: "high" })
    selected.messages.ses_root = []
    selected.sessions.ses_root = { id: "ses_root", model: { providerID: "chosen", id: "model", variant: "mid" } }
    await selected.install()
    await selected.evaluate(selected.event())
    expect(selected.calls[0]!.model).toEqual({ providerID: "chosen", id: "model", variant: "high" })
  })

  test("fails closed when no model can be determined", async () => {
    const app = harness({})
    app.messages.ses_root = []
    await app.install()
    const event = await app.evaluate(app.event())

    expect(event.effect).toBe("deny")
    expect(event.message).toContain("Permission review failed")
    expect(app.calls).toHaveLength(0)
  })

  test("reviews subagent requests against the root session's human messages", async () => {
    const app = harness({ model: "reviewer/fast" })
    app.sessions.ses_child = { id: "ses_child", parentID: "ses_root" }
    app.messages.ses_child = [{ id: "m1", type: "user", text: "Subagent task from parent agent." }]
    await app.install()
    const event = app.event("git push origin feature", { sessionID: "ses_child", source: undefined })
    await app.evaluate(event)

    expect(app.calls[0]!.prompt).toContain('"rootSessionID":"ses_root"')
    expect(app.calls[0]!.prompt).toContain("Run the tests.")
  })

  test("excludes plugin-authored denial continuations from human context", async () => {
    const app = harness({ model: "reviewer/fast" })
    app.messages.ses_root!.unshift({
      id: "msg_denial",
      type: "user",
      text: "[Auto Permissions] The requested action was blocked: nope",
    })
    await app.install()
    await app.evaluate(app.event())

    expect(app.calls[0]!.prompt).not.toContain("The requested action was blocked")
    expect(app.calls[0]!.prompt).toContain("Run the tests.")
  })

  describe("deterministic policy", () => {
    test("denies catastrophic deletes without a model call", async () => {
      const app = harness({ model: "reviewer/fast" })
      await app.install()
      const event = await app.evaluate(app.event("rm -rf /"))

      expect(event.effect).toBe("deny")
      expect(event.message).toContain("catastrophic data loss")
      expect(app.calls).toHaveLength(0)
    })

    test("denies an explicitly prohibited command without a model call", async () => {
      const app = harness({ model: "reviewer/fast" })
      app.messages.ses_root!.push({ id: "msg_stop", type: "user", text: "You must not run git push origin feature." })
      await app.install()
      const event = await app.evaluate(app.event("git push origin feature"))

      expect(event.effect).toBe("deny")
      expect(app.calls).toHaveLength(0)
    })

    test("allows routine local commands without a model call", async () => {
      const app = harness({ model: "reviewer/fast" })
      await app.install()
      expect((await app.evaluate(app.event("git status"))).effect).toBe("allow")
      expect(app.calls).toHaveLength(0)
    })
  })

  describe("shadow mode", () => {
    test("observes a decision but leaves the request pending", async () => {
      const app = harness({ model: "reviewer/fast", shadow: true })
      app.setRespond(() => deny())
      await app.install()
      const event = await app.evaluate(app.event())

      expect(event.effect).toBe("ask")
      expect(event.message).toBeUndefined()
      expect(app.calls).toHaveLength(1)
    })

    test("also leaves the request pending when the review fails", async () => {
      const app = harness({ model: "reviewer/fast", shadow: true })
      app.setRespond(() => {
        throw new Error("provider unavailable")
      })
      await app.install()
      const event = await app.evaluate(app.event())

      expect(event.effect).toBe("ask")
      expect(event.message).toBeUndefined()
    })
  })

  describe("failure handling", () => {
    test("fails closed on an invalid decision after trying the session model", async () => {
      const app = harness({ model: "reviewer/fast" })
      app.setRespond(() => ({ decision: "allow" }))
      await app.install()
      const event = await app.evaluate(app.event())

      expect(event.effect).toBe("deny")
      expect(event.message).toContain("Permission review failed")
      expect(app.calls.map((call) => call.model.providerID)).toEqual(["reviewer", "example"])
    })

    test("tolerates a fenced JSON answer", async () => {
      const app = harness({ model: "reviewer/fast" })
      app.setRespond(() => "```json\n" + JSON.stringify(allow()) + "\n```")
      await app.install()
      expect((await app.evaluate(app.event())).effect).toBe("allow")
    })

    test("retries the session model once after a timeout and keeps variants scoped", async () => {
      const app = harness({ model: "reviewer/fast", variant: "reviewer-only", timeoutMs: 100 })
      app.setRespond(async (call, index) => {
        if (index > 0) return allow()
        await new Promise<void>((_resolve, reject) => {
          call.signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true })
        })
      })
      await app.install()
      const event = await app.evaluate(app.event())

      expect(event.effect).toBe("allow")
      expect(app.calls.map((call) => call.model)).toEqual([
        { providerID: "reviewer", id: "fast", variant: "reviewer-only" },
        SESSION_MODEL,
      ])
      expect(app.calls[1]!.signal).not.toBe(app.calls[0]!.signal)
      expect(app.calls[1]!.signal.aborted).toBe(false)
    })

    test("keeps the configured variant when inheriting the session model", async () => {
      const app = harness({ variant: "none" })
      await app.install()
      await app.evaluate(app.event())
      expect(app.calls.map((call) => call.model)).toEqual([{ ...SESSION_MODEL, variant: "none" }])
    })

    test("falls back past a provider error", async () => {
      const app = harness({ model: "reviewer/fast" })
      app.setRespond((_call, index) => {
        if (index === 0) throw new Error("provider unavailable")
        return allow()
      })
      await app.install()
      expect((await app.evaluate(app.event())).effect).toBe("allow")
      expect(app.calls).toHaveLength(2)
    })

    test("reports a timeout with timeout guidance when every model times out", async () => {
      const app = harness({ model: "example/main", timeoutMs: 100 })
      app.setRespond(
        (call) => new Promise((_resolve, reject) => call.signal.addEventListener("abort", () => reject(new Error("Aborted")))),
      )
      await app.install()
      const event = await app.evaluate(app.event())

      expect(event.effect).toBe("deny")
      expect(event.message).toContain("timed out")
    })

    test("does not retry the same model", async () => {
      const app = harness({ model: "example/main" })
      app.setRespond(() => {
        throw new Error("provider unavailable")
      })
      await app.install()
      const event = await app.evaluate(app.event())

      expect(event.effect).toBe("deny")
      expect(app.calls).toHaveLength(1)
    })

    test("does not retry after a valid denial", async () => {
      const app = harness({ model: "reviewer/fast" })
      app.setRespond(() => deny())
      await app.install()
      expect((await app.evaluate(app.event())).effect).toBe("deny")
      expect(app.calls).toHaveLength(1)
    })
  })

  describe("lifecycle", () => {
    test("disposes the hook registration", async () => {
      const app = harness({ model: "reviewer/fast" })
      const cleanup = await app.install()
      await cleanup!()
      expect(app.disposed).toBe(1)
    })

    test("cancels an in-flight review on dispose without resolving the request", async () => {
      const app = harness({ model: "reviewer/fast" })
      let fail!: () => void
      app.setRespond(
        () =>
          new Promise((_resolve, reject) => {
            fail = () => reject(new Error("cancelled"))
          }),
      )
      const cleanup = await app.install()
      const event = app.event()
      const pending = app.fire(event)
      await settle()

      await cleanup!()
      expect(app.calls[0]!.signal.aborted).toBe(true)
      fail()
      await pending

      expect(event.effect).toBe("ask")
      expect(app.calls).toHaveLength(1)
    })
  })

  describe("concurrency and session approvals", () => {
    test("shares one model review between identical concurrent requests", async () => {
      const app = harness({ model: "reviewer/fast" })
      let release!: () => void
      app.setRespond(
        () =>
          new Promise((resolve) => {
            release = () => resolve(allow())
          }),
      )
      await app.install()
      const first = app.event()
      const second = app.event()
      const running = [app.fire(first), app.fire(second)]
      await settle()
      release()
      await Promise.all(running)

      expect(app.calls).toHaveLength(1)
      expect([first.effect, second.effect]).toEqual(["allow", "allow"])
    })

    test("reuses an exact narrow approval within the root session", async () => {
      const app = harness({ model: "reviewer/fast" })
      app.setRespond(() => allow({ decision: "allow_session" }))
      await app.install()
      const target = "README.md"
      const read = (resource: string) => app.event(resource, { action: "read" })

      expect((await app.evaluate(read(target))).effect).toBe("allow")
      expect((await app.evaluate(read(target))).effect).toBe("allow")
      expect(app.calls).toHaveLength(1)

      await app.evaluate(read("package.json"))
      expect(app.calls).toHaveLength(2)
    })

    test("does not reuse approvals when session approvals are disabled", async () => {
      const app = harness({ model: "reviewer/fast", sessionApprovals: false })
      await app.install()
      await app.evaluate(app.event("README.md", { action: "read" }))
      await app.evaluate(app.event("README.md", { action: "read" }))
      expect(app.calls).toHaveLength(2)
    })

    test.each([
      ["sensitive file", "read", "/home/me/.ssh/id_rsa"],
      ["env file", "read", "/repo/.env.local"],
      ["broad glob", "read", "/tmp/*"],
      ["destructive command", "shell", "rm -r build"],
      ["publish", "shell", "npm publish"],
      ["write action", "edit", "src/index.ts"],
      ["external directory", "external_directory", "/data/project/*"],
    ])("never reuses an approval for a %s", async (_name, action, resource) => {
      const app = harness({ model: "reviewer/fast" })
      app.setRespond(() => allow({ decision: "allow_session" }))
      await app.install()
      await app.evaluate(app.event(resource, { action }))
      await app.evaluate(app.event(resource, { action }))
      expect(app.calls).toHaveLength(2)
    })

    test("never reuses an approval across root sessions", async () => {
      const app = harness({ model: "reviewer/fast" })
      app.setRespond(() => allow({ decision: "allow_session" }))
      app.sessions.ses_other = { id: "ses_other" }
      app.messages.ses_other = [{ id: "m", type: "user", text: "Read the docs." }]
      await app.install()
      await app.evaluate(app.event("README.md", { action: "read" }))
      await app.evaluate(app.event("README.md", { action: "read", sessionID: "ses_other", source: undefined }))
      expect(app.calls).toHaveLength(2)
    })

    test("a denial is never remembered", async () => {
      const app = harness({ model: "reviewer/fast" })
      let verdict: unknown = deny()
      app.setRespond(() => verdict)
      await app.install()
      expect((await app.evaluate(app.event("README.md", { action: "read" }))).effect).toBe("deny")
      verdict = allow()
      expect((await app.evaluate(app.event("README.md", { action: "read" }))).effect).toBe("allow")
      expect(app.calls).toHaveLength(2)
    })
  })

  test("records privacy-minimized diagnostics for decisions and failures", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-diagnostics-"))
    const path = join(directory, "decisions.jsonl")
    try {
      const app = harness({ model: "example/main", debug: path })
      app.setRespond((_call, index) => {
        if (index === 0) return allow()
        throw new Error("provider unavailable")
      })
      await app.install()
      await app.evaluate(app.event("git push origin feature"))
      await app.evaluate(app.event("git push origin other"))
      await settle(100)

      const records = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
      expect(records.map((record) => record.event)).toEqual([
        "plugin_started",
        "request_received",
        "model_attempt",
        "model_decision",
        "decision",
        "request_received",
        "model_attempt",
        "model_failure",
        "failure",
      ])
      expect(records.find((record) => record.event === "decision")).toMatchObject({
        source: "model",
        decision: "allow",
        shadow: false,
        replyResult: "replied",
        approvalScope: "once",
        resourceCount: 1,
      })
      expect(JSON.stringify(records)).not.toContain("git push origin")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("falls back to evaluation metadata when the tool call is not in session context", async () => {
    const app = harness({ model: "reviewer/fast" })
    await app.install()
    const event = app.event("git push origin feature", { source: undefined, metadata: { input: { command: "git push -f" } } })
    await app.evaluate(event)
    expect(app.calls[0]!.prompt).toContain("git push -f")
  })
})
