import assert from "node:assert/strict"
import { test } from "node:test"
import { identifiableProviders, maskProvider, restoreProviderCredentials } from "../console/lib/providerCredentials.js"

const current = identifiableProviders("chat", [
  { name: "a", apiUrl: "https://a.invalid", model: "a", apiKey: "provider-a-secret", priority: 1 },
  { name: "b", apiUrl: "https://b.invalid", model: "b", apiKey: "provider-b-secret", priority: 2 }
])

test("AI provider identity is independent of credential contents and persists from stored IDs", () => {
  const changedKeys = identifiableProviders("chat", current.map(provider => ({ ...provider, apiKey: "changed" })))
  assert.deepEqual(changedKeys.map(provider => provider._consoleId), current.map(provider => provider._consoleId))
  const edited = identifiableProviders("chat", [{ ...current[0], name: "edited", apiKey: "new" }], [current[0]])
  assert.equal(edited[0]._consoleId, current[0]._consoleId)
  assert.equal(JSON.stringify(current.map(provider => provider._consoleId)).includes("secret"), false)
})

test("reordering redacted providers retains the key associated with each stable ID", () => {
  const submitted = current.map(maskProvider).reverse()
  const restored = restoreProviderCredentials(submitted, current)
  assert.deepEqual(restored.map(provider => provider.apiKey), ["provider-b-secret", "provider-a-secret"])
  assert.deepEqual(restored.map(provider => provider._consoleId), current.map(provider => provider._consoleId).reverse())
})

test("modern key operations keep, replace, clear and new providers cannot accidentally inherit credentials", () => {
  const initial = maskProvider(current[0])
  assert.equal(restoreProviderCredentials([{ ...initial, apiKey: "", apiKeyAction: "keep" }], current)[0].apiKey, "provider-a-secret")
  assert.equal(restoreProviderCredentials([{ ...initial, apiKey: "new-key", apiKeyAction: "replace" }], current)[0].apiKey, "new-key")
  assert.equal(restoreProviderCredentials([{ ...initial, apiKeyAction: "clear" }], current)[0].apiKey, "")
  const newProvider = restoreProviderCredentials([{ name: "a", apiUrl: "https://a.invalid", model: "a", apiKeyAction: "keep" }], current)[0]
  assert.equal(newProvider.apiKey, "")
  assert.notEqual(newProvider._consoleId, current[0]._consoleId)
})

test("unknown, duplicate IDs and unmatched key masks are rejected before writing or probing", () => {
  assert.throws(() => restoreProviderCredentials([{ ...current[0], _consoleId: "stale" }], current), { status: 409 })
  assert.throws(() => restoreProviderCredentials([current[0], current[0]], current), { status: 400 })
  assert.throws(() => restoreProviderCredentials([{ ...maskProvider(current[0]), apiKeyAction: "replace" }], current), { status: 400 })
  assert.throws(() => restoreProviderCredentials([{ name: "new", apiKey: "****" }], []), { status: 400 })
  assert.throws(() => restoreProviderCredentials([{ name: "new", apiKeyAction: "keep" }], [], { allowNew: false }), { status: 400 })
})

test("legacy providers without IDs can retain masked keys when editing", () => {
  const { _consoleId, ...legacy } = maskProvider(current[0])
  const result = restoreProviderCredentials([{ ...legacy, name: "renamed" }], current)
  assert.equal(result[0].apiKey, "provider-a-secret")
})
