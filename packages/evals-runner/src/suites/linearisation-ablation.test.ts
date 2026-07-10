import {
  applyVariant,
  linearisationAblationSuite,
  type SerializationVariant,
} from "./linearisation-ablation.js";

describe("linearisation-ablation suite", () => {
  it("returns a valid BenchmarkSuite with correct name", () => {
    const suite = linearisationAblationSuite();
    expect(suite.name).toBe("linearisation-ablation");
    expect(suite.title).toBe("Linearisation Format Ablation");
    expect(suite.description).toBeTruthy();
    expect(suite.items.length).toBeGreaterThan(0);
    expect(suite.scorers.length).toBeGreaterThan(0);
  });

  it("default items are multiplied by 4 variants (20 items total)", () => {
    const suite = linearisationAblationSuite();
    expect(suite.items.length).toBe(20);
  });

  it("applyVariant with native_tool_calls returns task unchanged", () => {
    const task = "Do something with tools";
    const result = applyVariant(task, "native_tool_calls");
    expect(result).toBe(task);
  });

  it("applyVariant with choice_then_args appends format instruction", () => {
    const task = "Do something with tools";
    const result = applyVariant(task, "choice_then_args");
    expect(result).not.toBe(task);
    expect(result.startsWith(task)).toBe(true);
    expect(result).toContain("choice");
    expect(result).toContain("tool_name");
  });

  it("custom variants option limits output items", () => {
    const variants: SerializationVariant[] = ["native_tool_calls", "reasoning_prefix"];
    const suite = linearisationAblationSuite({ variants });
    // 5 base items * 2 variants = 10
    expect(suite.items.length).toBe(10);
  });

  it("scorers array has expected names", () => {
    const suite = linearisationAblationSuite();
    const names = suite.scorers.map((s) => s.name);
    expect(names).toContain("variant_format_compliance");
    expect(names).toContain("state_collapse_rate");
    expect(names).toContain("recovery_success_rate");
  });
});
