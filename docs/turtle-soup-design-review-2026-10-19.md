**海龟汤：新汤生成、坏汤回收与游戏设计审查（2026-10-19）**

结论：已有生成、三道审核、逻辑修复、人工待审、玩家评分和淘汰机制，但它们之间的状态与证据没有完整关联。当前最需要补齐的是最终版本的可靠审核、失败原因分流、可追踪的修复回收，以及可信的主持和评分。单纯增加生成数量或审核次数，无法解决这些问题。

范围为当前本地源码（审查时 HEAD 为 `9ec30f9`）、相关测试和本地保存的六题快照。本轮未修改业务代码或测试、未调用真实模型、未访问生产服务、未提交或部署。运行数据不足以计算真实生成合格率或修复收益。

**1. 现在实际怎么运行**

新题按“出题 → 解析/难度/去重 → 结构审核 → 可玩性审核 → 逻辑审核 → pending → 人工过审 → active”推进。

- 结构与可玩性失败：部分内容留档，整个题目重出。
- 逻辑失败：当前生成过程中最多修复两轮；仍失败则留档，再重出。
- JSON 不合法、模型调用失败、审核输出无法解析、难度不符、重复：会重试，但没有统一失败候选记录。
- 历史 rejected：最近八个不同标题的失败原因作为新题提示词；后台能查看最近三十条。
- 玩家低分：评分至少三次且均分低于三分，自动 retired。
- retired 恢复：原题直接重新设为 active，没有内容修复或新版本审核要求。

因此，当前具备的是“当次逻辑修复”和“下一次生成参考批评”，还不具备完整的“历史坏题回收再加工”。

依据：[生成器](/Users/shiqi/IdeaProjects/bl-chat-plugin/src/modules/games/infrastructure/turtleSoup/TurtleSoupGenerator.ts:97)、[退役规则](/Users/shiqi/IdeaProjects/bl-chat-plugin/src/modules/games/domain/turtleSoup/turtleSoupRules.ts:143)、[被拒记录接口](/Users/shiqi/IdeaProjects/bl-chat-plugin/src/modules/platform/infrastructure/console/consoleServer.ts:1609)、[原样恢复入口](/Users/shiqi/IdeaProjects/bl-chat-plugin/console/frontend/src/pages/GamesPage.vue:139)。

**2. 本地样本揭示了哪些质量标准缺口**

[本地题库快照](/Users/shiqi/IdeaProjects/bl-chat-plugin/.soup_batch_tmp/current.json) 文件时间为 2026-10-19 18:03:15（北京时间），有六题，五题 active、一题 retired，三题有评分。这不是当前线上状态；样本没有完整审核记录，不能据此证明当前新版三道审核放行了这些问题。

| 样本 | 具体观察 | 应如何处理 |
| --- | --- | --- |
| 双份的遗像 | 汤底先说只有一张正面照，随后又说“依据两张正面照”；快照中两票均分二分，仍 active | 数量矛盾必须修；还应核对汤面“侧脸照”与汤底“画像”的措辞是否误导玩家 |
| 雨夜的伞 | 妻子带伞失踪，却未交代伞怎么回到丈夫手中；保护痕迹的动机与淋雨、擦干伞的行为缺乏解释；快照中三票均分一分、retired | 值得尝试修复物件流转与动机，但必须检查修完是否仍保有原谜题趣味 |
| 镜中的挥手 | 第三条提示直接写出“丈夫已不在人世、风吹摆动的义肢”，暴露主要答案 | 提示应有方向、关系、关键突破的梯度；不能只检查“有三条” |
| 停摆的钟 | 汤底把逃离原因写成多个可选心理解释，包括“或害怕钟声引来注意旧案” | 主持需要唯一固定的事实和动机；作者的备选解释不应直接作为最终汤底 |

这些例子说明，审核应检查固定事实、因果动机、物件流转、措辞诚实和提示梯度，不能停留在故事读起来顺畅。

**3. 已确认的实现问题及影响**

**3.1 修复后没有重新通过完整准入，审核记录混用版本。**

初稿检查难度、重复和可玩性；修稿只检查标题、结构及逻辑。最终保存的是修稿，却沿用原稿的可玩性通过记录。

隔离假模型复现：要求 hard，修稿变成 easy，汤面与已有题完全相同，仍能保存为 pending；可玩性审核全程只有一次。人工待审仍在，但后台的通过记录不能证明最终稿通过了对应审核。

应让所有最终候选共用准入管线，并把每条审核绑定到内容版本或内容哈希。

依据：[修复链路](/Users/shiqi/IdeaProjects/bl-chat-plugin/src/modules/games/infrastructure/turtleSoup/TurtleSoupGenerator.ts:141)、[入库](/Users/shiqi/IdeaProjects/bl-chat-plugin/src/modules/games/infrastructure/turtleSoup/TurtleSoupGenerator.ts:173)。

**3.2 连续修复会把稿件与漏洞错配。**

初稿 A 改成 B 后，若 B 仍不通过，代码只更新漏洞、不推进稿件。第二轮拿 A 配 B 的漏洞继续修；失败留档也可能记录 A 的文字与 B 的问题。这个分支已用假模型复现。

每次合法修稿都应形成版本，后续审核和修复必须引用同一版本。修复输出格式错误时应单独处理，避免一次解析失败就中止剩余修复机会。

依据：[候选更新和漏洞更新](/Users/shiqi/IdeaProjects/bl-chat-plugin/src/modules/games/infrastructure/turtleSoup/TurtleSoupGenerator.ts:137)。

**3.3 审核结果自身缺少一致性校验。**

`{pass:true, holes:["存在矛盾"]}` 会被解析为通过，生成器只看 pass。通过结果应无阻断问题；字段缺失、相互矛盾属于审核响应异常，需要重新判定。

依据：[逻辑审核解析](/Users/shiqi/IdeaProjects/bl-chat-plugin/src/modules/games/domain/turtleSoup/turtleSoupPrompts.ts:211)。

**3.4 可修复问题能否被修，取决于在哪道审核被发现。**

可玩性审题已经检查逻辑、时间线和物件流转，但它失败就重出；只有后面的逻辑审核发现同类问题才修复。这使处理方式取决于审核顺序。

应由审核输出问题类别、严重度与可修复性，再统一决定补全、修稿、重出或淘汰。

依据：[可玩性审核要求](/Users/shiqi/IdeaProjects/bl-chat-plugin/src/modules/games/domain/turtleSoup/turtleSoupPrompts.ts:55)、[失败处理](/Users/shiqi/IdeaProjects/bl-chat-plugin/src/modules/games/infrastructure/turtleSoup/TurtleSoupGenerator.ts:128)。

**3.5 主持与判胜会破坏玩家的推理依据。**

- 主持收到汤底、关键点和最近二十条问答，没有汤面。汤面已陈述但汤底未重述的事实，主持缺少直接依据。
- 提示词要求“没写一律不是”，把未知当成事实上的否定；又把“明确未知”和“部分成立”都放进“是也不是”，语义混杂。
- 字面相似度达到阈值直接获胜。复现长答案中“是盲人”改成“不是盲人”，相似度仍约 98.6%，直接判中。
- 模型判题只数 covered 数组长度；缺少 covered 时直接相信 correct。同一关键点重复三次，也可以被视为覆盖三个不同要点。这两种响应都已复现为正确、100%。

应提供汤面与固定事实表，明确真、假、未知和无关的语义；判胜核对必需事实和矛盾。关键点使用稳定 ID，并区分核心因果与解释性细节。字面分数可以辅助判断，但不能绕过事实核验。

依据：[主持输入](/Users/shiqi/IdeaProjects/bl-chat-plugin/src/modules/games/infrastructure/turtleSoup/TurtleSoupManager.ts:539)、[主持规则](/Users/shiqi/IdeaProjects/bl-chat-plugin/src/modules/games/domain/turtleSoup/turtleSoupPrompts.ts:120)、[直接判胜](/Users/shiqi/IdeaProjects/bl-chat-plugin/src/modules/games/infrastructure/turtleSoup/TurtleSoupManager.ts:293)、[覆盖校验](/Users/shiqi/IdeaProjects/bl-chat-plugin/src/modules/games/infrastructure/turtleSoup/TurtleSoupModelHost.ts:29)。主持实际误答频率没有真实模型验证；输入缺失、规则和判胜分支是已核实的代码事实。

**3.6 并发会丢题、丢评分，慢模型结果还能覆盖新局。**

文件写入采用原子替换，但读取、修改、写入不是一个事务。复现同一个 store 并发存两题，只剩后一题；两位玩家同时评分，双方均收到成功，最终只有一票。评分明细与题目聚合还分两次保存。

控制台重审在等模型前读题，结束后用旧对象整体保存，能覆盖等待期间的出池和评分。对局也没有在模型返回后校验局次；复现旧题问答等待期间换汤，旧回复返回后把当前会话覆盖回旧题。

应优先建立可靠的更新事务、版本比较和局次标识。可选单一写入服务或 SQLite；完整更新必须串行/事务化，仅给文件替换加锁不够。异步结果只能落到原局次，过期结果应失效。

依据：[Store 更新](/Users/shiqi/IdeaProjects/bl-chat-plugin/src/modules/games/infrastructure/turtleSoup/TurtleSoupStore.ts:53)、[文件写队列](/Users/shiqi/IdeaProjects/bl-chat-plugin/src/modules/games/infrastructure/gameFiles.ts:19)、[评分保存](/Users/shiqi/IdeaProjects/bl-chat-plugin/src/modules/games/infrastructure/turtleSoup/TurtleSoupManager.ts:451)、[重审保存](/Users/shiqi/IdeaProjects/bl-chat-plugin/src/modules/platform/infrastructure/console/consoleServer.ts:1606)、[问答返回落地](/Users/shiqi/IdeaProjects/bl-chat-plugin/src/modules/games/infrastructure/turtleSoup/TurtleSoupManager.ts:539)。

**3.7 后台配置和运行时读取不一致。**

表单使用 turtleSoup.*，运行时读取 miniGames.turtleSoup；通用配置适配器按字段原样读写，没有补上这一层。控制台还把插件根传给需要宿主根的配置读取器，导致配置路径再次拼入 plugins/shiloh-plugin。隔离复现目标库存九，从宿主根读为九，从插件根读成默认二。

管理端多个接口固定访问 data/turtle_soup，也没有统一使用可配置 baseDir。修复这些契约后，配置调优与后台观察才有可靠依据。

依据：[表单字段](/Users/shiqi/IdeaProjects/bl-chat-plugin/src/modules/config/domain/schemas/shared/games.ts:6)、[配置适配器](/Users/shiqi/IdeaProjects/bl-chat-plugin/src/adapters/config/schemaConfig.ts:163)、[运行读取](/Users/shiqi/IdeaProjects/bl-chat-plugin/src/modules/games/infrastructure/gameFiles.ts:39)、[控制台读取](/Users/shiqi/IdeaProjects/bl-chat-plugin/src/modules/platform/infrastructure/console/consoleServer.ts:1671)。

**4. 坏汤与生成失败应该怎样再利用**

| 原因 | 建议动作 | 需要保留的内容 |
| --- | --- | --- |
| 超时、限流、模型/审核输出格式错误 | 从失败阶段恢复；有限重试与退避，保留此前有效候选 | 阶段、错误类型、原始响应、已有内容、重试次数 |
| 事实矛盾、缺少物件流转、提示过度泄底 | 修复原题，生成新版本，再完整审核 | 原稿、修稿、每版问题及审核、父版本 |
| 核心反转牵强、依赖任意脑补、缺乏可推理路径 | 淘汰或提取创意重新设计，限制修复预算 | 淘汰原因、可复用创意、明确的设计教训 |
| 玩家低分、频繁换汤或投降 | 先诊断题目、主持、难度或技术原因，再决定修题/修主持/调整难度 | 评价维度、换汤理由、必要且限量的问答轨迹 |
| 优质旧汤 | 向未见过该题的群/玩家再投放 | 题目家族、版本、参与与已曝光历史 |

当前 rejected 留档缺少稳定 ID、hints、完整 audits、失败阶段、模型与版本关系，不能直接当成完整修复队列。建议增加候选记录和修复任务，再提供“查看问题 → 发起修复 → 对照版本 → 审核 → 重新投放”的管理路径。

修复不应覆盖旧题和旧评分；新旧版本保留关联。改写题面、换名字或修好同一核心诡计，都不能把已见过答案的玩家重新当成新玩家。必须用题目家族或核心机制来继承曝光历史。

可修题建议先试最多一到两轮，并给调用数/费用预算；这是初始策略，后续用实际修复成功率调整。当前补库外层最多 3×库存目标次、每次两次生成、每次最多七次模型调用，内容全失败的理论上限为 42×目标；默认目标二即最多八十四次，不含网关自身重试。服务不可用应尽早暂停重试，避免持续空耗。

**5. 评分、库存与生成反馈还需要形成闭环**

最强的负面信号之一是玩家直接换汤，但换汤会立即归档旧局并开新局；评分只允许当前局的 reveal 阶段，所以旧题无法再评。归档只留问题数量等统计，问答过程随会话移除，难以复盘是题坏还是主持误导。

建议评分绑定 playId，允许开始下一局后补评上一局；换汤可选原因，但不要自动折算成一星。低分至少区分“逻辑矛盾、猜不到入口、提示不好、主持答错、题材不喜欢”。三票低分更适合作为暂停投放待复核的信号；是否永久淘汰应结合问题证据、独立玩家与群数量。

生成反馈也需要改进：高分目前只提供标题和分数，模型不知道好在哪里；低分收集的前三条评论并不按其评分过滤，好评也可能被当成“批评”。管理员分直接覆盖玩家均分，却没有管理员理由字段。建议保留两类评价，形成有例证的结构摘要与缺陷类型，再按相关性选择少量经验进入生成提示。

库存目前把 active 未玩题和全部 pending 相加。复现“可玩鲜汤零、待审二、目标二”时补库停止，这是控制生成成本的取舍，需要分别显示可玩库存与待审积压，并安排审核处理。正常三选一又直接从全部候选随机抽取，绕过已有的鲜汤优先、最少游玩策略，应共用同一套候选排序。

依据：[换汤](/Users/shiqi/IdeaProjects/bl-chat-plugin/src/modules/games/infrastructure/turtleSoup/TurtleSoupManager.ts:356)、[评分窗口](/Users/shiqi/IdeaProjects/bl-chat-plugin/src/modules/games/infrastructure/turtleSoup/TurtleSoupManager.ts:444)、[反馈选择](/Users/shiqi/IdeaProjects/bl-chat-plugin/src/modules/games/infrastructure/turtleSoup/TurtleSoupGenerator.ts:79)、[反馈提示](/Users/shiqi/IdeaProjects/bl-chat-plugin/src/modules/games/domain/turtleSoup/turtleSoupPrompts.ts:24)、[库存口径](/Users/shiqi/IdeaProjects/bl-chat-plugin/src/modules/games/infrastructure/turtleSoup/TurtleSoupGenerator.ts:40)、[三选一](/Users/shiqi/IdeaProjects/bl-chat-plugin/src/modules/games/infrastructure/turtleSoup/TurtleSoupManager.ts:192)。

**6. 游戏设计上最值得调整的方向**

好海龟汤应当让玩家通过提问逐渐建立正确事实，最后理解一个有说服力的反转。当前提示要求“汤面不强烈暗示答案”，同时要求“汤底是唯一可能解释”，审核又要求拿不准也算漏洞。这容易挤压可玩的悬念，或逼模型在汤底堆砌解释。

更合适的标准是：事实固定、题面诚实、核心因果自洽、存在合理提问入口、答案揭晓后能解释异常、提示逐级帮助收敛。汤面本身通常不必排除所有可能世界；经过问答后，预设真相应能被公平发现。

建议生成时先形成固定事实与因果链，再生成汤面、必需判胜点和提示。审核分别负责硬矛盾、线索公平、提示梯度和主持可答性；可以用少量模拟问题验证关键事实是否可发现、主持是否前后一致。生成、审题和逻辑审计现在共用所配置模型，三次调用并不构成三份独立质量证据。

以下是后续体验优化，优先级低于正确性与回收闭环：

- 核心反转与因果已猜中时，不应强制复述所有装饰性细节；关键点区分必需与可选。
- 提示是全局配额，任何玩家可以连续消耗；根据群玩法考虑冷却或确认。中途加入时应补发已使用提示，目前只显示用过几条。
- MVP 目前只获得问题数量、“是”的数量和字面最接近猜测，缺少关键问答内容，难以评出真正推动推理的人。可以按首次发现关键事实的贡献提供证据。
- 评分期占用游戏会话，会阻止下一局开始；可把评价窗口与对局会话解耦。
- 最后一人投降后私发失败，重试成功仍可能停在零人 playing；应由活跃人数决定收局，将汤底投递和对局结束分开。
- 跨群防重复目前主要在初始选题时检查，中途加入和未结束对局的曝光信息不完整；如果要严格防剧透，应记录已看过，而不只记录已完成。

**7. 建议实施顺序与验收**

| 顺序 | 范围 | 关键验收 |
| --- | --- | --- |
| 第一批 | 修复稿件推进/完整重审、主持事实与判胜、存储事务/局次、配置读取 | 修稿不能带过期审核；相反关键事实不能判胜；并发不丢记录；旧回复不覆盖新局；后台配置被实际读取 |
| 第二批 | 候选/版本记录、失败分流、修复入口、上一局评价和换汤原因 | 任一失败可追溯到阶段及版本；技术失败可续跑；坏汤可修复重审；同题修稿继承已曝光历史 |
| 第三批 | 题材/诡计多样性、分层提示、模拟提问、试投放反馈 | 观察可玩题生成成本、修复后合格率、重复率、主持一致性、按难度的完局/提示数据及玩家评价 |

指标应共同判断，不能把猜中率越高、淘汰率越低或生成数量越大单独作为成功。难汤可能低猜中率但高满意度，主持误答也会导致低评分。

**8. 验证边界**

- 当前目标 TS 源码隔离转译，复制并运行 Generator、Manager、ModelHost、Rules、Similarity、Store 六份现有测试：74 通过、0 失败、0 跳过。未更新共享 dist；这不是整仓类型检查或生产集成测试。
- 额外定向探针确认：修复漏审、两轮稿件错配、审核字段矛盾、待审占满库存、相反事实高相似度判胜、缺失/重复覆盖条目被接受、并发保存丢记录。子代理另外复现旧局覆盖新局、并发丢评分、配置错层及最后玩家私发重试问题。
- 主代理在验证结束时比对416个范围内源文件/测试/入口文件，与本轮初始哈希一致；16个隔离验证输入也保持一致。本轮初始测试 dirty 后续消失，但文件字节未变，本轮没有执行提交。
- 六题快照只用于举例制定质量标准；没有真实模型回放，不能声称新版出题质量、审核准确率或线上成功率已被测定。
