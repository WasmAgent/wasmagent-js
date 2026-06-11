// F4 — AGENTS.md project-instruction loader (Codex/Cursor/Copilot/Gemini convention)
export type {
  AgentsMdLoader,
  ProjectInstructionsOptions,
  ResolvedInstructions,
} from "./agentsMd.js";
export {
  AGENTS_MD_FILENAME,
  makeKvAgentsMdLoader,
  makeNodeAgentsMdLoader,
  ProjectInstructions,
} from "./agentsMd.js";
export type {
  ActivationResult,
  Skill,
  SkillBody,
  SkillManifest,
  SkillTrigger,
} from "./Skill.js";
export { SkillRegistry } from "./Skill.js";
