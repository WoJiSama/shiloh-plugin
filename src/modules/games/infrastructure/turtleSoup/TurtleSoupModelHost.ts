// 主持人格的模型实现:问答/全部猜测判定/MVP评选走模型,输出严格解析与关键点ID核验。
import type {TurtleSoupHost, TurtleSoupHostVerdict, TurtleSoupMvp} from '../../../../contracts/turtleSoup.js'
import type {ChatMessage} from '../../../../contracts/modelGateway.js'
import {buildGuessJudgeMessages, buildHostAnswerMessages, buildMvpMessages, parseGuessJudge, parseHostAnswer, parseMvp} from '../../domain/turtleSoup/turtleSoupPrompts.js'
import {looksLikeSolutionLeak} from '../../domain/turtleSoup/turtleSoupSimilarity.js'
import type {TurtleSoupModelCall} from './TurtleSoupGenerator.js'

export interface TurtleSoupModelHostPorts {
  callModel:TurtleSoupModelCall
  logger?:{warn?(message:string):void}
}

enum HostCallKind { Answer = 'answer', Judge = 'judge', Mvp = 'mvp' }

export function createTurtleSoupModelHost(ports:TurtleSoupModelHostPorts):TurtleSoupHost {
  const call = async (kind:HostCallKind, messages:ChatMessage[], signal?:AbortSignal) => {
    try { return await ports.callModel(messages, {temperature: kind === HostCallKind.Answer ? 0.3 : 0.2, ...(signal ? {signal} : {})}) }
    catch (error) { throw new Error(`主持${kind === HostCallKind.Answer ? '问答' : kind === HostCallKind.Judge ? '判定' : 'MVP评选'}调用失败: ${error instanceof Error ? error.message : String(error)}`) }
  }
  return {
    async answerQuestion(input) {
      const answer = parseHostAnswer(await call(HostCallKind.Answer, buildHostAnswerMessages(input), input.signal))
      if (looksLikeSolutionLeak(answer, input.solution)) return '与此无关'
      return answer
    },
    async judgeGuess(input):Promise<TurtleSoupHostVerdict> {
      const parsed = parseGuessJudge(await call(HostCallKind.Judge, buildGuessJudgeMessages(input), input.signal), input.literalScore)
      const unavailable:TurtleSoupHostVerdict = {correct: false, reason: '判题结果不完整,请重试', closeness: 0, status: 'unavailable'}
      const ids = input.keyPointIds ?? input.keyPoints.map((_, index) => `kp${index + 1}`)
      const required = input.requiredKeyPointIds?.length ? input.requiredKeyPointIds : ids
      if (!parsed || !ids.length || ids.length !== input.keyPoints.length || new Set(ids).size !== ids.length || !required.length || new Set(required).size !== required.length || required.some(id => !ids.includes(id))) return unavailable
      const validIds = (values:string[]|null):values is string[] => !!values && new Set(values).size === values.length && values.every(id => ids.includes(id))
      if (!validIds(parsed.coveredIds) || !validIds(parsed.contradictedIds)) return unavailable
      if (parsed.coveredIds.some(id => parsed.contradictedIds!.includes(id))) return unavailable
      const covered = required.filter(id => parsed.coveredIds!.includes(id)).length
      if (covered === required.length && !parsed.contradictedIds.length && !parsed.correct) return unavailable
      return {correct: parsed.correct && covered === required.length && parsed.contradictedIds.length === 0, reason: parsed.reason, closeness: Math.round(covered / required.length * 100), status: 'judged'}
    },
    async selectMvp(input):Promise<TurtleSoupMvp|null> {
      const parsed = parseMvp(await call(HostCallKind.Mvp, buildMvpMessages({brief: input.brief}), input.signal), input.brief.players.map(player => player.userId))
      return parsed
    }
  }
}
