import { buildGuessJudgeMessages, buildHostAnswerMessages, buildMvpMessages, parseGuessJudge, parseHostAnswer, parseMvp } from '../../domain/turtleSoup/turtleSoupPrompts.js';
import { looksLikeSolutionLeak } from '../../domain/turtleSoup/turtleSoupSimilarity.js';
var HostCallKind;
(function (HostCallKind) {
    HostCallKind["Answer"] = "answer";
    HostCallKind["Judge"] = "judge";
    HostCallKind["Mvp"] = "mvp";
})(HostCallKind || (HostCallKind = {}));
export function createTurtleSoupModelHost(ports) {
    const call = async (kind, messages) => {
        try {
            return await ports.callModel(messages, { temperature: kind === HostCallKind.Answer ? 0.3 : 0.2 });
        }
        catch (error) {
            throw new Error(`主持${kind === HostCallKind.Answer ? '问答' : kind === HostCallKind.Judge ? '判定' : 'MVP评选'}调用失败: ${error instanceof Error ? error.message : String(error)}`);
        }
    };
    return {
        async answerQuestion(input) {
            const answer = parseHostAnswer(await call(HostCallKind.Answer, buildHostAnswerMessages(input)));
            if (looksLikeSolutionLeak(answer, input.solution))
                return '与此无关';
            return answer;
        },
        async judgeGuess(input) {
            const parsed = parseGuessJudge(await call(HostCallKind.Judge, buildGuessJudgeMessages(input)), input.literalScore);
            if (!parsed)
                return { correct: false, reason: '', closeness: Math.round(input.literalScore * 100) };
            // 不信任模型的一刀切correct:有关键点清单时,代码强制"全覆盖才算中",关联度=覆盖率
            const total = input.keyPoints.length;
            if (parsed.covered && total > 0) {
                const covered = Math.min(parsed.covered.length, total);
                const allCovered = covered >= total;
                return { correct: parsed.correct && allCovered, reason: parsed.reason, closeness: allCovered ? 100 : Math.round((covered / total) * 100) };
            }
            return { correct: parsed.correct, reason: parsed.reason, closeness: parsed.correct ? 100 : parsed.closeness };
        },
        async selectMvp(input) {
            const parsed = parseMvp(await call(HostCallKind.Mvp, buildMvpMessages({ brief: input.brief })), input.brief.players.map(player => player.userId));
            return parsed;
        }
    };
}
//# sourceMappingURL=TurtleSoupModelHost.js.map