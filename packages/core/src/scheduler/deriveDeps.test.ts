import { deriveDependencies } from "./deriveDeps.js";

describe("deriveDependencies", () => {
  it("returns empty deps for independent calls", () => {
    const calls = [
      { id: "a", input: { x: 1 } },
      { id: "b", input: { y: "hello" } },
    ];
    const deps = deriveDependencies(calls);
    expect(deps.get("a")).toEqual([]);
    expect(deps.get("b")).toEqual([]);
  });

  it("detects $<callId> reference and creates a dependency edge", () => {
    const calls = [
      { id: "a", input: { val: 1 } },
      { id: "b", input: { source: "$a" } },
    ];
    const deps = deriveDependencies(calls);
    expect(deps.get("a")).toEqual([]);
    expect(deps.get("b")).toContain("a");
  });

  it("chains: a → b → c are all serial", () => {
    const calls = [
      { id: "a", input: {} },
      { id: "b", input: { prev: "$a" } },
      { id: "c", input: { prev: "$b" } },
    ];
    const deps = deriveDependencies(calls);
    expect(deps.get("a")).toEqual([]);
    expect(deps.get("b")).toEqual(["a"]);
    expect(deps.get("c")).toEqual(["b"]);
  });

  it("detects refs nested inside objects", () => {
    const calls = [
      { id: "fetch", input: {} },
      { id: "transform", input: { nested: { deep: "$fetch" } } },
    ];
    const deps = deriveDependencies(calls);
    expect(deps.get("transform")).toContain("fetch");
  });

  it("detects refs inside arrays", () => {
    const calls = [
      { id: "x", input: {} },
      { id: "y", input: { items: ["$x", "static"] } },
    ];
    const deps = deriveDependencies(calls);
    expect(deps.get("y")).toContain("x");
  });

  it("ignores refs to unknown call ids", () => {
    const calls = [{ id: "a", input: { ref: "$unknown" } }];
    const deps = deriveDependencies(calls);
    expect(deps.get("a")).toEqual([]);
  });

  it("ignores self-references", () => {
    const calls = [{ id: "a", input: { self: "$a" } }];
    const deps = deriveDependencies(calls);
    expect(deps.get("a")).toEqual([]);
  });

  it("throws on circular dependency (a → b → a)", () => {
    const calls = [
      { id: "a", input: { ref: "$b" } },
      { id: "b", input: { ref: "$a" } },
    ];
    expect(() => deriveDependencies(calls)).toThrow(/[Cc]ircular/);
  });

  it("multiple dependencies: c depends on both a and b", () => {
    const calls = [
      { id: "a", input: {} },
      { id: "b", input: {} },
      { id: "c", input: { x: "$a", y: "$b" } },
    ];
    const deps = deriveDependencies(calls);
    expect(deps.get("c")).toContain("a");
    expect(deps.get("c")).toContain("b");
    expect(deps.get("c")).toHaveLength(2);
  });
});
