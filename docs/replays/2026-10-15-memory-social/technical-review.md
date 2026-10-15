三版真实模型回放技术复核（2026-10-15）

三版证据在输入、人格和评估协议上可比，均有完整 48 轮真实主模型返回。最终版修复了日期锚定、公开事实的人格来源和故障续问的严肃规划；不能据此宣布“所有社交行为、人设、记忆和自然度均已验收”。最终只有 **30/48 轮通过全部结构检查，另 18 轮仍有 kind 失配**。本复核不提供自然度评分，也未读取独立盲评或映射。

| 指标 | baseline 6668bd3 | 初候选 0068ba2 | 最终 ecc72ab |
|---|---:|---:|---:|
| 完整唯一轮次 | 48 | 48 | 48 |
| 全部结构检查通过 | 24/48 | 27/48 | 30/48 |
| kind 检查失败 | 21 | 21 | 18 |
| 主模型 HTTP 200 / 非空输出 | 48/48 | 48/48 | 48/48 |
| 日期检查 | 0/3 | 3/3 | 3/3 |
| 长期召回关键词检查 | 8/9 | 9/9 | 9/9 |
| 故障严肃性/推理规划检查 | 各 3/6 | 各 3/6 | 各 6/6 |
| 900ms 群知识裁决超时 | 48/48 | 48/48 | 48/48 |
| 20s 事实抽取请求 / HTTP 200 / 超时 | 72 / 56 / 16 | 77 / 66 / 11 | 80 / 78 / 2 |
| 最后观察轮仍待重试批次 | 0 | 10 | 4 |
| 实模耗尽批次 | 0 | 0 | 0 |

最终 kind 失配分别为：饼干梗后续两轮共 6 次、日期追问 3 次、切人格后第一次追问 3 次、安慰两轮共 6 次。分类失配不等于最终答错：饼干数字和年终奖梗仍接上，安慰回复没有说教。它也不能被隐藏成“社交状态全部完成”。

**协议与完整性。** 每版是 8 个场景 × 3 次独立会话、共 24 会话 / 48 轮。逐项复核了 `(id,sampleIndex,turnIndex)`，无缺轮、重轮、额外轮；三版对应轮的输入和 personaHash 一致。runner、helper、场景文件及每个场景哈希已重新计算，config、effectiveConfig、persona、personaLibrary 哈希一致。主生成均为 glm-5.3、temperature 0.7、top_p 0.9；故障续轮从 low 改用 high 是最终方案的一部分。三份文件 complete=true、平台发送和生产写入均为 0。scheduler 的 3 是场景进程工作数，不能等同峰值模型请求数。证据未附请求绝对起止时间或各进程完整 scheduler 日志，无法独立测量峰值并发，也不能证明此前没有丢弃过其他实验。三版顺序执行、每场景仅 3 次，服务波动会影响比较。

**时间记忆。** 最终 3/3 首轮事实保留原始 at=1792079990000（10 月 15 日 23:59:50），eventAt=1792166390000（10 月 16 日 23:59:50），后续 memoryOnly 召回 3/3 明示事件日期 2026-10-16。eventAt 只是保留源时刻的日期锚，尚未精确解释“上午”。三条最终追问输出都仍说“明天上午”并给出 10 月 16 日。fixture 的第二轮 at 是 10 月 16 日 00:02，但全局系统与 recall 仍用 10 月 15 日真实运行时钟，因此应结论为“日期保存和无历史召回通过”，不能结论为“跨午夜今天/明天生成已完全解决”，也不能仅据本 fixture 的双时钟直接认定生产同样出错。

**人格来源。** 两个候选版在 3/3 偏好事实中保存旧岚的 botId、personaId、personaVersion、personaName，后续切到朔及新版岚的 6/6 次召回都标旧来源；viewer 切换对应正确，memoryOnly 轮没有借旧人格上一句。朔知道热牛奶偏好，同时不冒认旧岚如何回应；新版岚也能知道公开事实。这证明本场景公开事实可共享、经历归属可区分，不能代替所有画像/反馈缓存、所有 episodic 路径或完整 PersonaSnapshot 全字段的覆盖。personaProjection 只查姓名、tone、speechStyle。

**故障条件连续性。** 最终 6/6 轮均是 serious_answer / help_request、关闭玩笑、使用 reasoning，保留 burning_odor 与 power off，规划只允许 static_observation，缺少 cooled / electrical_damage_excluded 时不放开动态动作。3/3 次“能先开机试一下吗”都答应保持断电。旧版与初候选在续轮错误切回 conversation / casual，但它们最终回复也劝不要开机，不能写成旧版真的建议危险上电。诊断措辞仍有从“大概率”到“已经烧坏”的确定化，规划通过不构成电气专业安全认证。

**记忆成功、失败与重试。** 每版 48 次 900ms glm-5.3-flash 请求全部超时，三版合计 144/144。该调用来自 `MemoryManager.interpretGroupKnowledgeInstruction()`，是群共享知识写入语义裁决，不是前置主意图模型，也不是 20 秒事实抽取全部超时。日志“超过 1 秒”是 900ms 的取整描述。证据不能单独定位供应商排队、网络、请求格式或模型吞吐中的哪一项造成超时。

最终 96 个记忆入口结果为：69 次 success 且 written=0，7 次 success 有写入，4 次 failed，16 次 group throttled。4 次失败均在安慰场景首轮：sample2 的 group invalid-output / user transport，sample3 的 user invalid-output / group transport。两次 invalid-output 对应 HTTP 200，但未保留原始抽取正文，不能进一步判断缺 content、结构或 sourceIndex。success written=0 仅说明没有写入可用操作，不表示已存事实，也不一定能还原模型原文恰好为 `[]`。基线没有 status，不能把其 written=0 统一叫“成功无事实”。

最终最后观察时保留 4 批失败原文、at 与 personaSource，全部 attempts=1、retryExhausted=false、running=false；同会话后续独立新消息继续成功。初候选最后有 10 批，其中 1 批 running=true，不能说其队列已完全稳定。helper 的 drain 只等待当前任务，不等未来 retry timer，dispose 会清 timer，snapshot 导出 manager 内存 buffer 而非 Redis pending 文档。故本次实模验证了失败可见与原文保留，**没有实模覆盖三次重试耗尽、崩溃重启或持久文档恢复**；这些有单独确定性单测，应分开报告。pending 存在时 meta 可被新结果写为 success/failureCount=0，也不能仅据 meta 宣布队列健康。

**结构检查的实际边界。** 最终 third-person sample2 几乎原样重复用户问句“是 小林 在问 阿青，不是在叫你。你觉得是撒娇还是认真埋怨？”，仍通过其全部结构检查。基线三条 forward 回答把第 80 条当完整末句，也通过原结构检查；最终三条正确披露只展开 80 条、至少缺 5 条，未冒认完整末句。longTermRecall 只查 prompt 关键词，memoryEventDate 只查任一事实匹配日期；两者都不等于完整语义质量。guardChanged 全为 0，无法直接覆盖用户此前两个正常语义被出口替换破坏的例子。

| 延迟 ms（p50 / p95 / max） | baseline | 初候选 | 最终 |
|---|---:|---:|---:|
| 回复 | 2101 / 12739 / 28026 | 2859 / 12458 / 20580 | 2294 / 31425 / 34295 |
| 后台记忆 drain | 13808 / 20001 / 20001 | 14568 / 20005 / 20013 | 9273 / 18718 / 20003 |
| 离线整轮 | 16199 / 32733 / 41714 | 17348 / 32291 / 40584 | 13129 / 44723 / 47335 |

最终 low 42 轮回复 p50/p95/max 为 2046/7148/10519ms；high 6 轮为 27166/34295/34295ms。故障续轮因为保留严肃推理增加高推理请求，整体回复 p95 变慢，不能称整体提速。后台记忆 drain 发生在回复返回后，不能当成用户等回复的延迟；离线整轮还包含等记忆稳定的时间。事实抽取超时降低和 drain 缩短受服务波动与顺序实验影响，不能全归因代码。

**真实调用覆盖。** 主回复和事实抽取是实模请求，memory store / retriever 在隔离存储中运行；history 与 send 是 fixture。前置主意图 resolver 被 stub，shouldSkipIntentModel=true，144 轮 understanding 捕获均为空；没有从真实 Gate 主入口走全链路。工具、主动 episodic、embedding 与画像学习关闭；memoryOnly 轮清 history 并禁用 continuity / episode 召回。故不能用此批数据证明真实门控、理解模型、工具选择、画像学习或所有第一人称记忆已验收。

**测试门禁更新。** 初次全量日志 `final-verify-phase.log` 为 2213 项、2206 pass、5 fail、2 skip，应保留这一历史。5 项失败分别是视频事实问句的两处旧 kind 预期、group/private compiled host 缺 resolveUnderstandingPrompt、以及过时“普通闲聊全部跳理解”的源码字符串断言。71812bc 只修验收并增加普通/歧义/任务理解行为覆盖，不修改业务源文件，也未放宽冻结的 8 场景 48 轮数据。`test-repair-runtime-equivalence.json` 记录 477 个后端 JS 与 ecc72ab 逐字节一致，runtimeTreeHash 为 d8b10a9cdbc61588ffef1d3b9f3bb6dc9b4c2c7aa2365507749db80cf67779ca。最终 `final-deploy-phase-tests.log:2298-2303` 为后端 2216 项、2214 pass、0 fail、2 skip；2346-2347 为前端 11 文件、34/34 pass。这是修测试后的全量门禁通过，**没有重新运行一批实模数据**。本复核未访问生产，部署状态由父任务另行验证。

逐轮失败 tuple、各版请求/状态/延迟统计、pending 原文来源、哈希和门禁证据详见 `technical-review.json`。本次仅写两份报告，未改业务源码或 planning，未执行 build、commit、生产命令。
