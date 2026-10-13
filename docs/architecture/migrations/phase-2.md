# 阶段 2：运行时接口与会话状态

基线 c5d530b；直接 main，按用户最新要求不创建阶段分支。

已接通原调用入口的迁移：turnSession、groupRuntime、sharedRuntime。时钟/定时器/上下文/日志以显式端口注入；会话字段注册表与TS接口互相检查完整性；群/私聊上下文只存序列化身份，以botId+类型+群/用户标识区分。sharedRuntime只投影记忆命令需要的11项能力和ConfigPort，保持方法this，不暴露管理器内部状态。RedisJobStore的getRaw/setRaw/delRaw通过typed TaskStore适配器执行，保留NX/EX/PX、部分Redis客户端回退、共享Map与客户端热替换；任务状态机尚未迁移，属阶段5。

发送回执区分sent/failed/unknown，100节点转发逻辑使用相同分类；缺少message_id不伪造确认。当前forward调用仍保持原有未知回执继续后续批次语义，无新增自动重试。ReplyPort定义供后续投递用例使用，完整transport替换留阶段5。

兼容与限制：群smart状态仍保持既有按群共享语义；本阶段新增上下文身份可区分机器人，但没有悄悄改成每bot各自一份群话题。复杂会话/旧记忆返回payload明确为unknown边界，所属模块阶段再收紧，未使用any或关闭strict。没有迁移完整聊天编排。

修正：epoch0时间和数字0键保留；删除/淘汰/reset清理watchdog等全部计时器，包括0句柄；重复注册不重复监听；无效能力在装配时明确报错，失败重新初始化不会覆盖旧注册表。

验证：`TZ=UTC npm run verify:phase` 通过：严格类型及负例、依赖边界、后端全量、前端34项与构建、编译产物实际加载。原有宿主/Chromium跳过仍单列，不将其算通过。新增runtime核心测试无跳过。产物测试经旧JS路径导入真实编译模块，验证会话清理和共享配置/群状态运行。

统计采用不可变a93265c基线，367个原业务JS模块剩余，当前业务JS370个；多出的configStore和两项发布辅助模块另列新发现债务。5个已审核JS兼容入口单列，组合适配入口使用确切SHA校验，防止重新塞入业务后仍计为已迁移。当前完整指标见本阶段随提交保存的phase-2-metrics.json。

本阶段仅代码提交及CI，不部署生产。回滚为恢复c5d530b并重新构建相应发布包；配置和持久任务格式没有改变。
