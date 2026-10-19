import type {TurtleSoupPuzzle} from '../../../../contracts/turtleSoup.js'
import {literalSoupSimilarity, normalizeSoupText} from './turtleSoupSimilarity.js'

export const TURTLE_SOUP_AUDIT_DOMAINS = ['structure', 'playability', 'logic', 'simulation'] as const

/** All player-visible facts and judging rules belong to the reviewed revision. */
export function puzzleContentHash(puzzle:TurtleSoupPuzzle):string {
  const text = JSON.stringify({title: puzzle.title, surface: puzzle.surface, solution: puzzle.solution,
    keyPoints: puzzle.keyPoints, hints: puzzle.hints, difficulty: puzzle.difficulty, tags: puzzle.tags,
    mechanism: puzzle.mechanism || '', facts: puzzle.facts || [], keyPointIds: puzzle.keyPointIds || [], requiredKeyPointIds: puzzle.requiredKeyPointIds || []})
  // A stable 128-bit content fingerprint, independent of platform/runtime APIs.
  const hashes = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35]
  for (let index = 0; index < text.length; index++) {
    for (let word = 0; word < hashes.length; word++) hashes[word] = Math.imul((hashes[word]! ^ (text.charCodeAt(index) + word * 257)), 0x01000193 + word * 2) >>> 0
  }
  return `soup-v1-${hashes.map(value => value.toString(16).padStart(8, '0')).join('')}`
}

export function hasCurrentPassingAudits(puzzle:TurtleSoupPuzzle):boolean {
  const hash = puzzleContentHash(puzzle)
  return TURTLE_SOUP_AUDIT_DOMAINS.every(domain => {
    const latest = (puzzle.audits || []).filter(audit => audit.domain === domain && audit.contentHash === hash).at(-1)
    return latest?.pass === true && !(latest.holes?.length)
  })
}

export function puzzleFamilyId(puzzle:TurtleSoupPuzzle):string { return puzzle.familyId || puzzle.parentPuzzleId || puzzle.id }

export function comparablePuzzles(candidate:TurtleSoupPuzzle, puzzles:TurtleSoupPuzzle[], limit = 12):TurtleSoupPuzzle[] {
  const others = puzzles.filter(puzzle => puzzle.id !== candidate.id && puzzleFamilyId(puzzle) !== puzzleFamilyId(candidate))
  const scored = others.map(puzzle => ({puzzle, score: Math.max(literalSoupSimilarity(candidate.solution, puzzle.solution),
    literalSoupSimilarity(candidate.mechanism || '', puzzle.mechanism || ''), literalSoupSimilarity(candidate.keyPoints.join(';'), puzzle.keyPoints.join(';')))}))
    .sort((left, right) => right.score - left.score)
  const nearest = scored.slice(0, limit).map(item => item.puzzle)
  for (const puzzle of others.slice(-4)) if (!nearest.some(item => item.id === puzzle.id)) nearest.push(puzzle)
  return nearest
}

export function duplicatePuzzle(candidate:TurtleSoupPuzzle, puzzles:TurtleSoupPuzzle[]):TurtleSoupPuzzle|undefined {
  return puzzles.find(existing => existing.id !== candidate.id && puzzleFamilyId(existing) !== puzzleFamilyId(candidate) && (
    normalizeSoupText(candidate.title) === normalizeSoupText(existing.title) ||
    literalSoupSimilarity(candidate.surface, existing.surface) >= 0.9 ||
    literalSoupSimilarity(candidate.solution, existing.solution) >= 0.9 ||
    (!!candidate.mechanism && !!existing.mechanism && normalizeSoupText(candidate.mechanism) === normalizeSoupText(existing.mechanism))
  ))
}
