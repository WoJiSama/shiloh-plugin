import test from "node:test"
import assert from "node:assert/strict"
import { resolveChatCompletionUrl } from "../utils/chatCompletionUrl.js"

test("normalizes OpenAI SDK base URLs for direct chat completion requests", () => {
  assert.equal(
    resolveChatCompletionUrl("https://api.krill-ai.com/codex/v1"),
    "https://api.krill-ai.com/codex/v1/chat/completions"
  )
  assert.equal(
    resolveChatCompletionUrl("https://api.example.com/v1/"),
    "https://api.example.com/v1/chat/completions"
  )
  assert.equal(
    resolveChatCompletionUrl("https://api.example.com/v1/chat/completions"),
    "https://api.example.com/v1/chat/completions"
  )
  assert.equal(
    resolveChatCompletionUrl("https://api.example.com/gateway"),
    "https://api.example.com/gateway/v1/chat/completions"
  )
})
