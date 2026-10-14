import {toolRecord,type ToolSkillSource} from "../../../contracts/toolExecution.js"
function normalizeText(value:unknown = "", maxLength = 480) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength)
}

function summarizeParameters(parameters:unknown = {}) {
  parameters = toolRecord(parameters)
  const schemaRoot=toolRecord(parameters)
  const properties = schemaRoot.properties && typeof schemaRoot.properties === "object"
    ? schemaRoot.properties
    : {}
  const required = new Set(Array.isArray(schemaRoot.required) ? schemaRoot.required : [])
  return Object.entries(toolRecord(properties)).map(([name, raw]) => {
    const schema=toolRecord(raw)
    const type = schema?.type || "value"
    const requiredText = required.has(name) ? " required" : ""
    const choices = Array.isArray(schema?.enum) && schema.enum.length
      ? ` choices=${schema.enum.join("|")}`
      : ""
    return `${name}:${type}${requiredText}${choices}`
  }).join(", ")
}

export function resolveToolSkill(tool:ToolSkillSource = {}) {
  const declared = typeof tool?.getSkill === "function" ? tool.getSkill() : tool?.skill
  const skill = toolRecord(declared)
  return {
    name: String(skill.name || tool?.name || "").trim(),
    purpose: normalizeText(skill.purpose || tool?.description, 600),
    whenToUse: normalizeText(skill.whenToUse, 420),
    boundaries: normalizeText(skill.boundaries, 420),
    instructions: normalizeText(skill.instructions, 900),
    examples: Array.isArray(skill.examples)
      ? skill.examples.map(item => normalizeText(item, 260)).filter(Boolean).slice(0, 4)
      : [],
    parameters: tool?.parameters || { type: "object", properties: {}, required: [] }
  }
}

export function buildToolSkillCatalog(toolInstances:Record<string,ToolSkillSource> = {}, availableToolNames:string[] = []) {
  const allowed = new Set(availableToolNames)
  return Object.values(toolInstances)
    .filter(tool => tool?.name && allowed.has(tool.name))
    .map(tool => {
      const skill = resolveToolSkill(tool)
      return [
        `- ${skill.name}: ${skill.purpose || "执行已注册能力"}`,
        skill.whenToUse ? `  use: ${skill.whenToUse}` : "",
        skill.boundaries ? `  boundary: ${skill.boundaries}` : "",
        skill.instructions ? `  instructions: ${skill.instructions}` : "",
        `  parameters: ${summarizeParameters(skill.parameters) || "none"}`,
        ...skill.examples.map(example => `  example: ${example}`)
      ].filter(Boolean).join("\n")
    })
    .join("\n")
}

export function normalizeToolSkillParams(tool:ToolSkillSource|undefined, params:Record<string,unknown> = {}, context:Record<string,unknown> = {}) {
  const input = params && typeof params === "object" ? { ...params } : {}
  if (typeof tool?.normalizeParameters !== "function") return input
  const normalized = tool.normalizeParameters(input, context)
  return normalized && typeof normalized === "object" ? toolRecord(normalized) : input
}
