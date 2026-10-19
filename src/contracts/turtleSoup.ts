export interface TurtleSoupEvent {nickname?:string;group_id?:string|number;user_id?:string|number;msg?:string;isMaster?:boolean;sender?:{user_id?:string|number;card?:string;nickname?:string;role?:string};reply?(message:unknown):Promise<unknown>}
export interface TurtleSoupLogger {warn?(message:string):void;info?(message:string):void;error?(message:string):void}
export type TurtleSoupPuzzleStatus = 'active'|'retired'|'pending'
export type TurtleSoupPuzzleSource = 'ai'|'manual'
export interface TurtleSoupAuditRecord {domain:'structure'|'playability'|'logic';pass:boolean;reason:string;holes?:string[];at:number;model?:string}
export interface TurtleSoupPuzzle {id:string;title:string;surface:string;solution:string;keyPoints:string[];hints:string[];difficulty:string;tags:string[];source:TurtleSoupPuzzleSource;model?:string;createdAt:number;status:TurtleSoupPuzzleStatus;ratingSum:number;ratingCount:number;audits?:TurtleSoupAuditRecord[];manualScore?:number;manualScoreAt?:number}
export interface TurtleSoupRating {userId:string;score:number;comment?:string;at:number}
export type TurtleSoupEndReason = 'solved'|'manual'|'idle_timeout'|'join_timeout'|'all_surrendered'|'switched'
export interface TurtleSoupMvp {userId:string;reason:string}
export interface TurtleSoupPlay {playId:string;puzzleId:string;puzzleTitle:string;groupId:string;startedAt:number;endedAt?:number;endReason?:TurtleSoupEndReason;solved:boolean;winnerId?:string;mvp?:TurtleSoupMvp;players:string[];qaCount:number;ratings:TurtleSoupRating[]}
export interface TurtleSoupPlayer {userId:string;nickname:string;joinedAt:number}
export interface TurtleSoupQaEntry {userId:string;nickname?:string;question:string;answer:string;at:number}
export interface TurtleSoupGuessEntry {userId:string;guess:string;literalScore:number;final:'hit'|'miss';at:number}
export type TurtleSoupPhase = 'joining'|'choosing'|'playing'|'reveal'
export interface TurtleSoupRevealState {at:number;ratingDeadlineAt:number}
export interface TurtleSoupSurrenderRecord {at:number;delivered:boolean}
export interface TurtleSoupChoosingState {candidates:string[];deadlineAt:number}
export interface TurtleSoupSession {groupId:string;phase:TurtleSoupPhase;puzzleId:string;initiatorId:string;players:TurtleSoupPlayer[];createdAt:number;joinDeadlineAt:number;startedAt?:number;lastActivityAt:number;qaLog:TurtleSoupQaEntry[];guessLog:TurtleSoupGuessEntry[];usedHints:number;lastGuessAt:Record<string,number>;surrendered:Record<string,TurtleSoupSurrenderRecord>;choosing?:TurtleSoupChoosingState;reveal?:TurtleSoupRevealState}
export interface TurtleSoupHostVerdict {correct:boolean;reason:string;closeness:number}
export interface TurtleSoupQaHistoryItem {question:string;answer:string}
export interface TurtleSoupPlayerIdentity {userId:string;nickname:string}
export interface MvpPlayerBrief {userId:string;nickname:string;questions:number;yesAnswers:number;closestGuess:{guess:string;score:number}|null}
export interface MvpBrief {players:MvpPlayerBrief[];winnerId:string|null;totalQuestions:number;totalGuesses:number}
// 主持人格端口:问答/灰区判定/MVP评选由模型实现(基建层),域层与测试用确定性桩替换。
export interface TurtleSoupHost {
  answerQuestion(input:{question:string;solution:string;keyPoints:string[];history:TurtleSoupQaHistoryItem[];asker:string}):Promise<string>
  judgeGuess(input:{guess:string;solution:string;keyPoints:string[];literalScore:number}):Promise<TurtleSoupHostVerdict>
  selectMvp(input:{brief:MvpBrief}):Promise<TurtleSoupMvp|null>
}
export interface TurtleSoupPuzzleFile {puzzles:TurtleSoupPuzzle[]}
export interface TurtleSoupPlayFile {plays:TurtleSoupPlay[]}
export interface TurtleSoupSessionFile {sessions:Record<string,TurtleSoupSession>}
export interface TurtleSoupConfig {enabled:boolean;minPlayers:number;joinWindowMinutes:number;idleTimeoutMinutes:number;guessCooldownSeconds:number;similarityHitThreshold:number;similarityMissThreshold:number;freshPoolTarget:number;generationModel:string;ratingWindowMinutes:number;maxHints:number;contentPolicy:string;recapEveryQuestions:number;chooseWindowSeconds:number;baseDir:string}
