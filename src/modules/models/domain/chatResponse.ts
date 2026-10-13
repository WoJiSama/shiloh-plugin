import type { ChatResponse } from '../../../contracts/modelGateway.js'
function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function optionalString(value: unknown): boolean { return value === undefined || typeof value === 'string' }
/** Validate fields consumed by the gateway; retain opaque provider extension fields. */
export function parseChatResponse(input: unknown): ChatResponse {
  if (Array.isArray(input) && input.length > 0) return parseChatResponse(input[0])
  if (!object(input)) return { error: 'Invalid response format: expected response object' }
  if (input.choices !== undefined) {
    if (!Array.isArray(input.choices)) return { error: 'Invalid response format: choices must be an array' }
    for (const choice of input.choices) {
      if (!object(choice)) return { error: 'Invalid response format: choice must be an object' }
      if (choice.message === undefined) continue
      if (!object(choice.message)) return { error: 'Invalid response format: message must be an object' }
      const message = choice.message
      if (!optionalString(message.role) || !optionalString(message.name)) return { error: 'Invalid response format: message identity must be a string' }
      if (message.tool_calls === undefined) continue
      if (!Array.isArray(message.tool_calls)) return { error: 'Invalid response format: tool_calls must be an array' }
      for (const call of message.tool_calls) {
        if (!object(call)) return { error: 'Invalid response format: tool call must be an object' }
        if (call.function === undefined) continue
        if (!object(call.function) || !optionalString(call.function.name) || !optionalString(call.function.arguments)) {
          return { error: 'Invalid response format: tool function name and arguments must be strings' }
        }
      }
    }
  }
  // The declared nested shape has been checked; unconsumed extensions intentionally stay unknown.
  return input as ChatResponse
}
