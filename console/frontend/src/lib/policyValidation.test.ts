import { describe, expect, it } from 'vitest'
import { validatePolicyFields, type SchemaFieldDefinition } from './schemaState'

const fields = (...names: string[]): SchemaFieldDefinition[] =>
  names.map((field) => ({ field, label: field, component: 'Input' }))

describe('policy validation', () => {
  it('accepts cross-midnight ranges and rejects impossible clocks and duplicate group IDs', () => {
    expect(
      validatePolicyFields(
        'tracking',
        {
          'smartTrigger.talkValueRules': [{ range: '23:00 - 06:59', value: 0.034 }],
          'smartTrigger.groupTalkValues': [{ group: '100001', value: 0.07 }]
        },
        fields('smartTrigger.talkValueRules', 'smartTrigger.groupTalkValues')
      )
    ).toEqual([])
    expect(
      validatePolicyFields(
        'tracking',
        {
          'smartTrigger.talkValueRules': [{ range: '24:00-25:59' }],
          'smartTrigger.groupTalkValues': [{ group: '100001' }, { group: ' 100001 ' }]
        },
        fields('smartTrigger.talkValueRules', 'smartTrigger.groupTalkValues')
      )
    ).toHaveLength(2)
  })

  it('compares partial edits against the other bound without blocking unrelated saves', () => {
    const draft = {
      'smartTrigger.minDeferredMs': 120000,
      'smartTrigger.maxDeferredMs': 60000,
      'smartTrigger.repeatMinCount': 6,
      'smartTrigger.repeatDetectionWindow': 5
    }
    expect(validatePolicyFields('tracking', draft, fields('smartTrigger.talkValue'))).toEqual([])
    expect(
      validatePolicyFields(
        'tracking',
        draft,
        fields('smartTrigger.maxDeferredMs', 'smartTrigger.repeatMinCount')
      )
    ).toHaveLength(2)
    expect(
      validatePolicyFields(
        'memory',
        {
          'memorySystem.knowledgeDecisionInlineWaitMs': 600,
          'memorySystem.knowledgeDecisionTimeoutMs': 500
        },
        fields('memorySystem.knowledgeDecisionTimeoutMs')
      )
    ).toHaveLength(1)
  })

  it('validates the dice timezone and directory only when edited', () => {
    expect(
      validatePolicyFields(
        'dice',
        {
          'diceSystem.timeZone': 'Asia/Shanghai',
          'diceSystem.baseDir': 'data/dice'
        },
        fields('diceSystem.timeZone', 'diceSystem.baseDir')
      )
    ).toEqual([])
    expect(
      validatePolicyFields(
        'dice',
        {
          'diceSystem.timeZone': 'invalid/zone',
          'diceSystem.baseDir': 'bad\0path'
        },
        fields('diceSystem.timeZone', 'diceSystem.baseDir')
      )
    ).toHaveLength(2)
  })
})
