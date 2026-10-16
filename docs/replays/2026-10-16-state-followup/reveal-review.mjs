import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {fileURLToPath} from 'node:url'

const directory = process.argv[2] ? path.resolve(process.argv[2]) : path.dirname(fileURLToPath(import.meta.url))
const read = name => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'))
const mappings = new Map(read('blind-mapping.json').map(row => [row.id, row]))
const conversations = new Map(read('blind-conversations.json').cases.map(row => [row.id, row]))
const review = read('blind-review.json')
const summary = read('summary.json')
const counts = () => ({candidate: 0, baseline: 0, tie: 0})
const scores = () => ({candidate: 0, baseline: 0})
const result = {
  evaluatedCandidate: summary.candidate.commit,
  baseline: summary.baseline.commit,
  methodology: 'Independent full-conversation review; map randomized A/B labels per case before aggregation. Coarse single-reviewer scores are not a statistical quality guarantee.',
  sourceHashes: Object.fromEntries(['blind-mapping.json', 'blind-conversations.json', 'blind-review.json'].map(name =>
    [name, createHash('sha256').update(fs.readFileSync(path.join(directory, name))).digest('hex')])),
  cases: review.cases.length, preference: counts(), scoreTotals: scores(), dimensions: {},
  hardErrorFindings: scores(), hardErrorQuoteOccurrences: scores(), hardErrors: []
}
assert.equal(review.cases.length, mappings.size)
assert.equal(new Set(review.cases.map(row => row.id)).size, mappings.size)
assert.equal(new Set(review.hardErrors.map(row => row.id)).size, review.hardErrors.length)
const usedErrors = new Set()
for (const entry of review.cases) {
  const mapping = mappings.get(entry.id)
  const transcript = conversations.get(entry.id)
  assert.ok(mapping && transcript, entry.id)
  assert.notEqual(mapping.candidate, mapping.baseline)
  const version = label => {
    assert.ok(['A', 'B', 'tie'].includes(label), `${entry.id}: invalid label ${label}`)
    return label === 'tie' ? 'tie' : label === mapping.candidate ? 'candidate' : 'baseline'
  }
  result.preference[version(entry.overall.winner)]++
  for (const role of ['candidate', 'baseline']) {
    const label = mapping[role]
    const total = Object.values(entry.dimensions).reduce((sum, value) => sum + value[label], 0)
    assert.equal(entry.overall[`${label}_total`], total, `${entry.id}: ${label} total`)
    result.scoreTotals[role] += total
  }
  for (const [name, value] of Object.entries(entry.dimensions)) {
    for (const label of ['A', 'B']) assert.ok(Number.isInteger(value[label]) && value[label] >= 0 && value[label] <= 2)
    assert.equal(value.winner, value.A === value.B ? 'tie' : value.A > value.B ? 'A' : 'B')
    const dimension = result.dimensions[name] ??= {preference: counts(), scoreTotals: scores()}
    dimension.preference[version(value.winner)]++
    for (const role of ['candidate', 'baseline']) dimension.scoreTotals[role] += value[mapping[role]]
  }
  for (const id of entry.hardErrorIds) {
    assert.ok(!usedErrors.has(id), id)
    usedErrors.add(id)
    const finding = review.hardErrors.find(row => row.id === id)
    assert.equal(finding?.caseId, entry.id, id)
    assert.ok(['A', 'B'].includes(finding.candidate), id)
    assert.ok(finding.occurrences.length, id)
    for (const occurrence of finding.occurrences) {
      assert.ok(occurrence.exactQuote.length, id)
      assert.ok(transcript[finding.candidate][occurrence.turn - 1]?.assistant.includes(occurrence.exactQuote), id)
    }
    const role = version(finding.candidate)
    result.hardErrorFindings[role]++
    result.hardErrorQuoteOccurrences[role] += finding.occurrences.length
    result.hardErrors.push({...finding, anonymousCandidate: finding.candidate, candidate: role})
  }
}
assert.equal(usedErrors.size, review.hardErrors.length)
fs.writeFileSync(path.join(directory, 'blind-revealed.json'), JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify({...result, hardErrors: undefined}, null, 2))
