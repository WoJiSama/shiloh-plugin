import {qqViewRecord,qqViewEvent,qqViewBot,callQqViewApi} from '../../../contracts/qqToolViews.js'
import type {QqViewEvent,QqViewMember,QqViewPorts} from '../../../contracts/qqToolViews.js'
import { AbstractTool } from '../../toolSupport/infrastructure/AbstractTool.js';

/**
 * 群成员信息查询工具类
 * 适配napcat-onebotv11版本
 */
export function createMemberInfoTool(ports:QqViewPorts = {}){
class MemberInfoTool extends AbstractTool {
  constructor() {
    super();
    this.name = 'memberInfoTool';
    this.description = '查询群成员的详细信息，包括昵称、群名片、入群时间、最后发言时间、等级、头衔、角色等';
    this.parameters = {
      type: 'object',
      required: [],
      properties: {
        user_id: {
          type: 'string',
          description: '要查询的用户QQ号，不填则查询消息发送者'
        },
        nickname: {
          type: 'string',
          description: '通过昵称或群名片查找用户，支持模糊匹配'
        }
      }
    };
  }

  /**
   * 调用OneBotv11 API
   */
  async callApi(action:string, params:Record<string,unknown> = {}, event:QqViewEvent = qqViewEvent({})) {return callQqViewApi(event,ports,action,params)}

  /**
   * 获取群成员列表
   */
  async getGroupMemberList(groupId:string, event:QqViewEvent) {
    try {
      const response = await this.callApi('get_group_member_list', {
        group_id: groupId
      },event);

      if (response.status === 'ok' && response.data) {
        return Array.isArray(response.data) ? response.data.map(qqViewRecord) : [];
      }
      return [];
    } catch (error) {
      console.error('获取群成员列表失败:', error);
      return [];
    }
  }

  /**
   * 通过昵称查找成员
   */
  findMemberByNickname(nickname:string, members:Record<string,unknown>[]) {
    const searchTarget = nickname.toLowerCase();
    return members.find(member => {
      const card = String(member.card || '').toLowerCase();
      const nick = String(member.nickname || '').toLowerCase();
      return card === searchTarget || nick === searchTarget ||
             card.includes(searchTarget) || nick.includes(searchTarget);
    });
  }

  /**
   * 格式化时间戳
   */
  formatTimestamp(timestamp:unknown) {
    if (!timestamp) return '未知';
    const date = new Date(Number(timestamp) * 1000);
    return date.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  /**
   * 格式化角色
   */
  formatRole(role:unknown) {
    const roleMap:Record<string,string> = {
      'owner': '群主',
      'admin': '管理员',
      'member': '普通成员'
    };
    return roleMap[String(role)] || String(role || "未知");
  }

  /**
   * 执行查询操作
   */
  async func(input:unknown, event:unknown) {
    const opts=qqViewRecord(input), e=qqViewEvent(event)
    const { user_id, nickname } = opts;

    if (!e.group_id) {
      return '此功能仅支持群聊使用';
    }

    let targetUserId:string|number|null = null;

    // 确定要查询的用户ID
    if (user_id) {
      targetUserId = Number(user_id);
    } else if (nickname) {
      // 通过昵称查找
      const members = await this.getGroupMemberList(e.group_id,e);
      const found = this.findMemberByNickname(String(nickname), members);
      if (found) {
        targetUserId = String(found.user_id);
      } else {
        return `未找到昵称包含 "${nickname}" 的群成员`;
      }
    } else {
      // 默认查询发送者
      targetUserId = e.user_id;
    }

    try {
      const response = await this.callApi('get_group_member_info', {
        group_id: e.group_id,
        user_id: targetUserId,
        no_cache: true
      },e);

      if (response.status !== 'ok' || !response.data) {
        return '获取成员信息失败';
      }

      const info = qqViewRecord(response.data);

      return {
        action: 'member_info',
        success: true,
        data: {
          user_id: info.user_id,
          nickname: info.nickname || '未知',
          card: info.card || '无群名片',
          role: this.formatRole(info.role),
          level: info.level || 0,
          title: info.title || '无头衔',
          join_time: this.formatTimestamp(info.join_time),
          last_sent_time: this.formatTimestamp(info.last_sent_time),
          shut_up_timestamp: Number(info.shut_up_timestamp) > 0 ? this.formatTimestamp(info.shut_up_timestamp) : '未被禁言',
          sex: info.sex === 'male' ? '男' : info.sex === 'female' ? '女' : '未知',
          age: info.age || '未知',
          area: info.area || '未知'
        }
      };
    } catch (error) {
      console.error('查询成员信息失败:', error);
      return `查询成员信息失败: ${error instanceof Error?error.message:String(error)}`;
    }
  }
}

return MemberInfoTool
}
