import { describe, expect, it, mock } from "bun:test";
import { createRolloutPlugin } from "./index.js";
import type { ElizaAction, ElizaCallback, ElizaMessage, ElizaRuntime, ElizaState } from "./index.js";

// Minimal runtime stub
function makeRuntime(agentId = "test-agent"): ElizaRuntime & {
  registerAction: (a: ElizaAction) => void;
  registeredActions: ElizaAction[];
} {
  const registeredActions: ElizaAction[] = [];
  return {
    agentId,
    registerAction(action: ElizaAction) {
      registeredActions.push(action);
    },
    registeredActions,
  };
}

const message: ElizaMessage = { content: { text: "What is 2+2?" } };
const state: ElizaState = {};

describe("createRolloutPlugin", () => {
  it("returns a plugin with the correct name", () => {
    const plugin = createRolloutPlugin();
    expect(plugin.name).toBe("@wasmagent/eliza-rollout-plugin");
  });

  it("exposes an init hook", () => {
    const plugin = createRolloutPlugin();
    expect(typeof (plugin as { init?: unknown }).init).toBe("function");
  });

  it("wraps registerAction when init is called", () => {
    const plugin = createRolloutPlugin({ sink: { type: "console" } });
    const runtime = makeRuntime();
    const originalRegister = runtime.registerAction.bind(runtime);

    (plugin as { init: (p: { runtime: typeof runtime }) => void }).init({ runtime });

    // registerAction should now be a different function (the wrapped version)
    expect(runtime.registerAction).not.toBe(originalRegister);
  });

  it("single-run mode: invokes original handler and passes through the answer", async () => {
    const plugin = createRolloutPlugin({ sink: { type: "console" }, format: "ppo", branches: 1 });
    const runtime = makeRuntime();
    (plugin as { init: (p: { runtime: typeof runtime }) => void }).init({ runtime });

    const originalHandler = mock(
      async (
        _rt: ElizaRuntime,
        _msg: ElizaMessage,
        _st: ElizaState | undefined,
        _opts: Record<string, unknown> | undefined,
        cb: ElizaCallback | undefined
      ) => {
        await cb?.({ text: "four" });
        return "four";
      }
    );

    const action: ElizaAction = { name: "TEST_ACTION", handler: originalHandler };
    runtime.registerAction(action);

    const registered = runtime.registeredActions[0];
    expect(registered).toBeDefined();

    const responses: string[] = [];
    const cb: ElizaCallback = async (r) => {
      responses.push(r.text);
    };

    await registered!.handler(runtime, message, state, {}, cb);

    expect(originalHandler).toHaveBeenCalledTimes(1);
    expect(responses).toEqual(["four"]);
  });

  it("single-run mode: does not wrap actions excluded by includeActions", async () => {
    const plugin = createRolloutPlugin({
      sink: { type: "console" },
      includeActions: ["ALLOWED_ACTION"],
    });
    const runtime = makeRuntime();
    (plugin as { init: (p: { runtime: typeof runtime }) => void }).init({ runtime });

    const handler = mock(async () => "result");
    runtime.registerAction({ name: "OTHER_ACTION", handler });
    runtime.registerAction({ name: "ALLOWED_ACTION", handler });

    // Both actions should be registered
    expect(runtime.registeredActions.length).toBe(2);

    // ALLOWED_ACTION is wrapped (different function reference), OTHER_ACTION is not
    expect(runtime.registeredActions[1]?.handler).not.toBe(handler);
    expect(runtime.registeredActions[0]?.handler).toBe(handler);
  });

  it("scores empty answer as 0", async () => {
    let capturedReward: number | undefined;
    const plugin = createRolloutPlugin({
      sink: { type: "console" },
      format: "ppo",
      branches: 1,
      scorer: (answer) => {
        const score = answer.trim() ? 1 : 0;
        capturedReward = score;
        return score;
      },
    });
    const runtime = makeRuntime();
    (plugin as { init: (p: { runtime: typeof runtime }) => void }).init({ runtime });

    const handler = mock(async () => "");
    runtime.registerAction({ name: "ACT", handler });

    await runtime.registeredActions[0]!.handler(runtime, message, state, {}, undefined);
    expect(capturedReward).toBe(0);
  });

  it("fork mode: runs branches concurrently and returns top answer", async () => {
    let callCount = 0;
    const plugin = createRolloutPlugin({
      sink: { type: "console" },
      format: "ppo",
      branches: 3,
      scorer: (answer) => answer.length / 100,
    });
    const runtime = makeRuntime();
    (plugin as { init: (p: { runtime: typeof runtime }) => void }).init({ runtime });

    const handler: ElizaAction["handler"] = async (_rt, _msg, _st, _opts, cb) => {
      callCount++;
      const answer = `answer-${callCount}`;
      await cb?.({ text: answer });
      return answer;
    };
    runtime.registerAction({ name: "FORK_ACTION", handler });

    const result = await runtime.registeredActions[0]!.handler(
      runtime,
      message,
      state,
      {},
      undefined
    );

    expect(callCount).toBe(3);
    // Should return a non-empty string (the top-ranked answer)
    expect(typeof result).toBe("string");
    expect((result as string).startsWith("answer-")).toBe(true);
  });
});
