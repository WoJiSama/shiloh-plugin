import type { QqToolEvent, QqToolBot, QqToolGroup, QqMember, QqToolPorts, PbObject, PbValue } from '../../../contracts/qqTools.js'
import { apiOk, asRecord, errorText, eventBot } from './qqToolRuntime.js'
import { AbstractTool } from '../../toolSupport/infrastructure/AbstractTool.js';

// ChangeCardTool.js
export function createChangeCardTool(ports: QqToolPorts) {
class ChangeCardTool extends AbstractTool {
  constructor() {
    super();
    this.name = 'changeCardTool';
    this.description = '这是一个实现修改名称(名字)功能的工具，当你想改自己的名称(名字)或者想改其他人的名称(名字)时，调用此工具。';
    this.parameters = {
      type: "object",
      properties: {
        target: {
          type: 'string',
          description: '目标用户或自己的QQ号、群名片、昵称'
        },
        senderRole: {
          type: 'string',
          description: '发送者角色(owner/admin/member)'
        },
        cardName: {
          type: 'string',
          description: '具体要修改的群聊名称'
        }
      },
      required: ['senderRole', 'target', 'cardName']
    };

  }

  /**
   * 查找群成员
   * @param {string} target - 目标用户的QQ号或名称
   * @param {Map} members - 群成员Map
   * @returns {Object|null} - 找到的成员信息或null
   */
  findMember(target: string, members: Map<number,QqMember>) {
    // 首先尝试作为QQ号查找
    if (/^\d+$/.test(target)) {
      const member = members.get(Number(target));
      if (member) return { qq: Number(target), info: member };
    }

    // 按群名片或昵称查找
    for (const [qq, info] of members.entries()) {
      const card = info.card?.toLowerCase();
      const nickname = info.nickname?.toLowerCase();
      const searchTarget = target.toLowerCase();

      if (card === searchTarget || nickname === searchTarget ||
        card?.includes(searchTarget) || nickname?.includes(searchTarget)) {
        return { qq, info };
      }
    }
    return null;
  }

  async func(opts: Record<string, unknown>, e: QqToolEvent) {
    const target = typeof opts.target==='string'?opts.target:'';
    const cardName = typeof opts.cardName==='string'?opts.cardName:'';
    const bot = eventBot(e,ports);
    if (!target) {
      return '无法获取到要修改的目标qq号';
    }
    const groupId = e.group_id;
    if (!groupId) return '此功能仅支持群聊使用';
    // 权限检查
    // if (!['owner', 'admin'].includes(senderRole)) {
    //   return '不能修改群主和管理员的群聊名称';
    // }
    // 获取群对象
    let group;
    try {
      group = e.group || await bot.pickGroup(groupId);
    } catch (error) {
      console.error('获取群信息失败:', error);
      return `未找到群 ${groupId}`;
    }

    try {
      const members = await group.getMemberMap();

      const foundMember = this.findMember(target, members);

      if (!foundMember) {
        return `失败了，'无法获取到要修改的目标qq号';`;
      }

      if (String(foundMember.qq) !== String(e.sender?.user_id ?? e.user_id) && !['owner','admin'].includes(e.sender?.role ?? '')) return '只有群主或管理员可以修改其他成员的群名片';
      // 检查机器人权限
      const botMember = members.get(bot.uin);
      if (!['owner','admin'].includes(botMember?.role ?? '') && foundMember.qq !== bot.uin) {
        return `失败了，我在这个群聊 ${groupId} 没有权限修改别人的群聊名称`;
      }

      const resData = await bot.sendApi('set_group_card', {
        "group_id": groupId,
        "user_id": Number(foundMember.qq),
        "card": cardName
      });

      if (apiOk(resData)) {
        return `修改目标用户${target}群聊昵称成功`;
      } else {
        return `修改目标用户${target}群聊昵称失败`;
      }

    } catch (error) {
      console.error(`修改群聊名称操作失败:`, error);
      return `修改群聊名称操作失败: ${errorText(error)}`;
    }
  }
}
return { ChangeCardTool }
}
