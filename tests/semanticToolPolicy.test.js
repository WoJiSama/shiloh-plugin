import test from 'node:test'
import assert from 'node:assert/strict'
import { hasSemanticPlannerCandidate, shouldRunSemanticToolPlanner } from '../utils/semanticToolPolicy.js'

test('does not plan ordinary direct chat without a tool signal', () => {
  assert.equal(shouldRunSemanticToolPlanner({}), false)
})

test('keeps planning for media and actionable tool requests', () => {
  assert.equal(shouldRunSemanticToolPlanner({ hasMedia: true }), true)
  assert.equal(shouldRunSemanticToolPlanner({ hasKnownToolCandidate: true }), true)
  assert.equal(shouldRunSemanticToolPlanner({ hasExplicitToolIntent: true }), true)
  assert.equal(shouldRunSemanticToolPlanner({ hasRealtimeRequest: true }), true)
  assert.equal(shouldRunSemanticToolPlanner({ hasExplicitSearchRequest: true }), true)
})

test('emoji-only candidacy does not add a semantic planner round', () => {
  assert.equal(hasSemanticPlannerCandidate(["sendLocalEmojiTool"]), false)
  assert.equal(hasSemanticPlannerCandidate(["sendLocalEmojiTool", "searchInformationTool"]), true)
})
