import { buildPuzzleGenerationMessages, buildPuzzleReviewMessages, parseGeneratedPuzzle, parsePuzzleReview } from '../../domain/turtleSoup/turtleSoupPrompts.js';
import { auditPuzzleStructure, freshPuzzleIds, pendingPuzzleIds, puzzlePlayStats } from '../../domain/turtleSoup/turtleSoupRules.js';
import { buildLogicAuditMessages, parseLogicAudit } from '../../domain/turtleSoup/turtleSoupPrompts.js';
import { literalSoupSimilarity } from '../../domain/turtleSoup/turtleSoupSimilarity.js';
export class TurtleSoupGenerator {
    ports;
    generating = false;
    sequence = 0;
    constructor(ports) { this.ports = ports; }
    get busy() { return this.generating; }
    freshCount() {
        const { puzzles } = this.ports.store.readPuzzles();
        return freshPuzzleIds(puzzles, puzzlePlayStats(this.ports.store.readPlays().plays)).length;
    }
    // 鲜汤保有量含待审:待审不算可玩,但已占生成额度,避免管理员未过审时无限生成
    readyFreshCount() {
        const { puzzles } = this.ports.store.readPuzzles();
        const played = puzzlePlayStats(this.ports.store.readPlays().plays);
        return freshPuzzleIds(puzzles, played).length + pendingPuzzleIds(puzzles).length;
    }
    // 鲜汤不足时补货到目标值;拿不到锁说明已有补货在进行,直接返回。
    async ensureFreshPool() {
        if (this.generating)
            return { added: 0, failed: 0, lastError: 'busy' };
        this.generating = true;
        try {
            let added = 0, failed = 0, lastError;
            const attemptsLimit = this.ports.config().freshPoolTarget * 3;
            let attempts = 0;
            while (this.readyFreshCount() < this.ports.config().freshPoolTarget && attempts < attemptsLimit) {
                attempts++;
                try {
                    await this.generateOne();
                    added++;
                }
                catch (error) {
                    failed++;
                    lastError = error instanceof Error ? error.message : String(error);
                }
            }
            return { added, failed, lastError };
        }
        finally {
            this.generating = false;
        }
    }
    // 手动种子生成(管理命令),同样受互斥锁保护。
    async seed(count, difficulty) {
        const total = Math.max(1, Math.min(20, Math.floor(count) || 1));
        if (this.generating)
            return { added: 0, failed: 0, lastError: 'busy' };
        this.generating = true;
        try {
            let added = 0, failed = 0, lastError;
            for (let index = 0; index < total; index++) {
                try {
                    await this.generateOne(difficulty);
                    added++;
                }
                catch (error) {
                    failed++;
                    lastError = error instanceof Error ? error.message : String(error);
                }
            }
            return { added, failed, lastError };
        }
        finally {
            this.generating = false;
        }
    }
    // 汇总评分反馈:高分解构风格、低分带玩家批评,喂给出题模型迭代质量
    buildGenerationFeedback() {
        const { store } = this.ports;
        const puzzles = store.readPuzzles().puzzles.filter(puzzle => puzzle.ratingCount > 0);
        const commentsOf = (puzzleId) => store.readPlays().plays
            .filter(play => play.puzzleId === puzzleId)
            .flatMap(play => play.ratings)
            .filter(rating => rating.comment && rating.comment.trim())
            .map(rating => String(rating.comment).trim());
        const ranked = puzzles
            .map(puzzle => ({ title: puzzle.title, score: puzzle.ratingSum / puzzle.ratingCount, comments: commentsOf(puzzle.id) }))
            .sort((left, right) => right.score - left.score);
        return {
            high: ranked.filter(item => item.score >= 4).slice(0, 5),
            low: ranked.filter(item => item.score < 3.5).reverse().slice(0, 5)
        };
    }
    async generateOne(difficulty) {
        const { store, config } = this.ports;
        const { puzzles } = store.readPuzzles();
        const settings = config();
        const avoidTitles = puzzles.map(puzzle => puzzle.title).slice(-60);
        const feedback = this.buildGenerationFeedback();
        let lastError = null;
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const text = await this.ports.callModel(buildPuzzleGenerationMessages({ contentPolicy: settings.contentPolicy, avoidTitles, feedback, ...(difficulty ? { difficulty } : {}) }), { temperature: 0.9, model: settings.generationModel || undefined });
                const puzzle = parseGeneratedPuzzle(text, { nowMs: this.now() + this.sequence++, random: this.random(), model: settings.generationModel || '主模型' });
                if (!puzzle)
                    throw new Error('生成产物不是合法汤面JSON');
                if (difficulty && puzzle.difficulty !== difficulty)
                    throw new Error(`难度不符:要求${difficulty},产出${puzzle.difficulty}`);
                if (this.duplicatesExisting(puzzle, puzzles))
                    throw new Error(`生成产物与现有汤面重复: ${puzzle.title}`);
                // 三道关全部通过才入库,且各域审核结论随题保存,供控制台展示与追溯
                const audits = [];
                const auditAt = this.now();
                // 第一关:确定性结构审核(长度/条数/关键点泄露)
                const structureIssues = auditPuzzleStructure(puzzle);
                audits.push({ domain: 'structure', pass: !structureIssues.length, reason: structureIssues.length ? '存在结构性问题' : '结构合规(长度/条数/无泄底)', ...(structureIssues.length ? { holes: structureIssues } : {}), at: auditAt });
                if (structureIssues.length)
                    throw new Error(`结构审核未通过: ${structureIssues.join(';')}`);
                // 第二关:可玩性审题
                const reviewText = await this.ports.callModel(buildPuzzleReviewMessages(puzzle), { temperature: 0.2, model: settings.generationModel || undefined });
                const review = parsePuzzleReview(reviewText);
                if (!review)
                    throw new Error('审题产物无法解析');
                audits.push({ domain: 'playability', pass: review.pass === true, reason: review.reason || (review.pass ? '可玩性通过' : '审题未通过'), at: auditAt, ...(settings.generationModel ? { model: settings.generationModel } : {}) });
                if (!review.pass)
                    throw new Error(`审题未通过: ${review.reason}`);
                // 第三关:独立逻辑审计(逐句对照/时间线/物件流转/动机链),发现漏洞直接废弃
                const auditText = await this.ports.callModel(buildLogicAuditMessages(puzzle), { temperature: 0.2, model: settings.generationModel || undefined });
                const audit = parseLogicAudit(auditText);
                if (!audit)
                    throw new Error('逻辑审计产物无法解析');
                audits.push({ domain: 'logic', pass: audit.pass === true, reason: audit.reason || (audit.pass ? '无逻辑漏洞' : '存在逻辑漏洞'), ...(audit.holes.length ? { holes: audit.holes } : {}), at: auditAt, ...(settings.generationModel ? { model: settings.generationModel } : {}) });
                if (!audit.pass)
                    throw new Error(`逻辑审计未通过: ${audit.holes.slice(0, 2).join(';') || audit.reason}`);
                // 入库即待审,管理员过审后才进入投放池
                const pending = { ...puzzle, status: 'pending', audits };
                await store.savePuzzle(pending);
                this.ports.logger?.info?.(`[海龟汤] 新汤待审: ${pending.title}(${pending.difficulty})`);
                return pending;
            }
            catch (error) {
                lastError = error;
            }
        }
        throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }
    duplicatesExisting(candidate, puzzles) {
        return puzzles.some(existing => literalSoupSimilarity(candidate.title, existing.title) >= 0.8 ||
            literalSoupSimilarity(candidate.surface, existing.surface) >= 0.9);
    }
    now() { return this.ports.now ? this.ports.now() : Date.now(); }
    random() { return this.ports.random ? this.ports.random() : Math.random(); }
}
//# sourceMappingURL=TurtleSoupGenerator.js.map