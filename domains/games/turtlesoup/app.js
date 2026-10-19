// 海龟汤组合根:装配store/生成器/主持模型/播报端口,创建插件与单例管理器。
// 模型调用走 utils/apiClient 的 YTapi,端口按阶段选择模型并传播取消信号。
import {createTurtleSoupPlugin} from '../../../dist/backend/modules/games/infrastructure/turtleSoup/app.js'
import {TurtleSoupManager} from '../../../dist/backend/modules/games/infrastructure/turtleSoup/TurtleSoupManager.js'
import {TurtleSoupStore, readTurtleSoupConfig} from '../../../dist/backend/modules/games/infrastructure/turtleSoup/TurtleSoupStore.js'
import {TurtleSoupGenerator} from '../../../dist/backend/modules/games/infrastructure/turtleSoup/TurtleSoupGenerator.js'
import {createTurtleSoupModelHost} from '../../../dist/backend/modules/games/infrastructure/turtleSoup/TurtleSoupModelHost.js'
import {createTurtleSoupModelCall} from '../../../dist/backend/modules/games/infrastructure/turtleSoup/turtleSoupModelCall.js'
import {publishActiveGameGroups} from '../../../dist/backend/modules/games/infrastructure/gameSessionRegistry.js'
import {sendSmartReply} from '../../../utils/SmartReply.js'
import {YTapi} from '../../../utils/apiClient.js'
import {umaRaceManager} from '../uma/UmaRaceManager.js'

const cwd = process.cwd()

const callModel = createTurtleSoupModelCall({cwd, executeModel: YTapi})

const turtleSoupConfig = () => readTurtleSoupConfig(cwd)
const store = new TurtleSoupStore({cwd, baseDir: turtleSoupConfig().baseDir})
const generator = new TurtleSoupGenerator({store, config: turtleSoupConfig, callModel, logger: globalThis.logger})
const host = createTurtleSoupModelHost({callModel, logger: globalThis.logger})
const turtleSoupManager = new TurtleSoupManager({
  sendSmartReply, host, generator, logger: globalThis.logger, cwd, config: turtleSoupConfig,
  isOtherGameActive: groupId => umaRaceManager.rooms?.has(groupId),
  sendPrivate: async (userId, message, groupId) => {
    const bot = globalThis.Bot
    // 未加好友也能收:NapCat 对带 group_id 的 send_private_msg 走群临时会话;失败再退回好友私聊
    if (bot?.sendApi && groupId) {
      try {
        await bot.sendApi('send_private_msg', { user_id: Number(userId), group_id: Number(groupId), message: String(message) })
        return
      } catch (error) {
        globalThis.logger?.warn?.(`[海龟汤] 临时会话私发失败,回退好友私聊: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const target = bot?.pickUser?.(Number(userId)) ?? bot?.pickFriend?.(Number(userId))
    if (!target?.sendMsg) throw new Error('私聊通道不可用')
    await target.sendMsg(String(message))
  },
  replyGroup: async (groupId, message) => {
    const group = globalThis.Bot?.pickGroup?.(Number(groupId))
    if (!group?.sendMsg) throw new Error('群播报通道不可用')
    await group.sendMsg(String(message))
  }
})
turtleSoupManager.start()
// 海龟汤问答进行中的群,主聊天人格(希洛)整体静默:局内玩家由游戏主持人应答
publishActiveGameGroups(() => turtleSoupManager.playingGroupIds())
// 启动即检查鲜汤保有量(重启后补偿此前失败的补货);补货失败不抛出,但必须留下日志
void generator.ensureFreshPool()
  .then(outcome => {
    if (outcome.failed || outcome.added) {
      globalThis.logger?.[outcome.failed ? 'warn' : 'info']?.(`[海龟汤] 启动补货:成功${outcome.added}道,失败${outcome.failed}道${outcome.failed ? `,最后错误:${outcome.lastError ?? '未知'}` : ''}`)
    }
  })
  .catch(error => {
    globalThis.logger?.warn?.(`[海龟汤] 启动补货异常: ${error instanceof Error ? error.message : String(error)}`)
  })
// 定时兜底:即使开局触发点全部错过,鲜汤池每30分钟也会被检查补足(池满时零开销)
setInterval(() => {
  void generator.ensureFreshPool()
    .then(outcome => {
      if (outcome.failed) globalThis.logger?.warn?.(`[海龟汤] 定时补货失败${outcome.failed}次:${outcome.lastError ?? '未知'}`)
    })
    .catch(() => {})
}, 30 * 60_000)
export {turtleSoupManager}
export const TurtleSoupPlugin = createTurtleSoupPlugin(plugin, {turtleSoupManager, sendSmartReply})
