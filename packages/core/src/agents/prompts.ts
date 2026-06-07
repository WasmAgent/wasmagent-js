/**
 * Shared prompt constants used by CodeAgent and ToolCallingAgent.
 */

export const PLANNING_PROMPT = `Based on the task and observations so far, provide:
1. A structured plan for remaining steps (inside <plan>...</plan> tags)
2. Key facts established so far (inside <facts>...</facts> tags)`;
