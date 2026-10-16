import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {fileURLToPath} from 'node:url'

const directory = path.dirname(fileURLToPath(import.meta.url))
const read = name => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'))
const mappings = new Map(read('blind-mapping.json').map(row => [row.id, row]))
const conversations = new Map(read('blind-conversations.json').cases.map(row => [row.id, row]))
const review = read('blind-review.json')
const counts = () => ({candidate: 0, baseline: 0, tie: 0})
const scores = () => ({candidate: 0, baseline: 0})
const result = {
  evaluatedCandidate: '4094d9c7aa8297dfff0de2bac06ab6829af5e155',
  baseline: '5a8a63069f014805b4194141454cbec40c15093e',
  methodology: 'Per-case random labels are mapped before aggregation. These findings do not evaluate later patches.',
  sourceHashes: Object.fromEntries(['blind-mapping.json', 'blind-conversations.json', 'blind-review.json'].map(name =>
    [name, createHash('sha256').update(fs.readFileSync(path.join(directory, name))).digest('hex')])),
  cases: review.cases.length, preference: counts(), scoreTotals: scores(), dimensions: {},
  hardErrorFindings: scores(), hardErrorQuoteOccurrences: scores(), hardErrors: []
}
assert.equal(review.cases.length, mappings.size)
for (const entry of review.cases) {
  const mapping = mappings.get(entry.id)
  const transcript = conversations.get(entry.id)
  assert.ok(mapping && transcript, entry.id)
  assert.notEqual(mapping.candidate, mapping.baseline)
  const version = label => label === 'tie' ? 'tie' : label === mapping.candidate ? 'candidate' : 'baseline'
  result.preference[version(entry.overall.winner)]++
  for (const role of ['candidate', 'baseline']) result.scoreTotals[role] += entry.overall[`${mapping[role]}_total`]
  for (const [name, value] of Object.entries(entry.dimensions)) {
    const dimension = result.dimensions[name] ??= {preference: counts(), scoreTotals: scores()}
    dimension.preference[version(value.winner)]++
    for (const role of ['candidate', 'baseline']) dimension.scoreTotals[role] += value[mapping[role]]
  }
  for (const id of entry.hardErrorIds) {
    const finding = review.hardErrors.find(row => row.id === id)
    assert.equal(finding?.caseId, entry.id, id)
    assert.ok(['A', 'B'].includes(finding.candidate), id)
    for (const occurrence of finding.occurrences) {
      assert.ok(transcript[finding.candidate][occurrence.turn - 1]?.assistant.includes(occurrence.exactQuote), id)
    }
    const role = version(finding.candidate)
    result.hardErrorFindings[role]++
    result.hardErrorQuoteOccurrences[role] += finding.occurrences.length
    result.hardErrors.push({...finding, anonymousCandidate: finding.candidate, candidate: role})
  }
}
assert.equal(result.hardErrors.length, review.hardErrors.length)
fs.writeFileSync(path.join(directory, 'blind-revealed.json'), JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify({...result, hardErrors: undefined}, null, 2))
