import {qqViewRecord,qqViewEvent,callQqViewApi,qqViewApiSucceeded} from '../../../contracts/qqToolViews.js'
import type {QqViewEvent,QqViewPorts} from '../../../contracts/qqToolViews.js'
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
          description: '要查询的真实用户QQ号；优先使用明确的@或回复目标。只有明确询问本人信息时才可省略'
        },
        nickname: {
          type: 'string',
          description: '通过昵称或群名片查找用户，精确匹配优先；有多个同名或模糊匹配时返回候选并要求澄清'
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

      if (qqViewApiSucceeded(response) && response.data) {
        return Array.isArray(response.data) ? response.data.map(qqViewRecord) : [];
      }
      throw new Error('群成员列表接口未返回成功结果');
    } catch (error) {
      console.error('获取群成员列表失败:', error);
      throw error;
    }
  }

  /**
   * 通过昵称查找成员
   */
  findMembersByNickname(nickname:string, members:Record<string,unknown>[]) {
    const searchTarget = nickname.trim().toLowerCase();
    if (!searchTarget) return [];
    const names = (member:Record<string,unknown>) => [String(member.card || '').trim().toLowerCase(), String(member.nickname || '').trim().toLowerCase()];
    const exact = members.filter(member => names(member).some(name => name === searchTarget));
    const matches = exact.length ? exact : members.filter(member => names(member).some(name => name.includes(searchTarget)));
    return [...new Map(matches.map(member => [String(member.user_id), member])).values()];
  }

  findMemberByNickname(nickname:string, members:Record<string,unknown>[]) {
    const matches = this.findMembersByNickname(nickname, members);
    return matches.length === 1 ? matches[0] : undefined;
  }

  validUserId(value:unknown) {
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    if (typeof value === 'number' && (!Number.isSafeInteger(value) || value <= 0)) return null;
    const id = String(value).trim();
    return /^[1-9]\d{0,19}$/.test(id) ? id : null;
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
    const failure = (status:string, message:string, candidates?:Record<string,unknown>[]) => ({
      action: 'member_info', success: false, status, message,
      ...(candidates ? {candidates: candidates.slice(0, 10).map(member => ({user_id: member.user_id, nickname: member.nickname || '', card: member.card || ''})), total_candidates: candidates.length} : {})
    });

    if (!e.group_id) {
      return '此功能仅支持群聊使用';
    }

    try {
      let targetUserId:string|null = null;
      if (user_id !== undefined) {
        targetUserId = this.validUserId(user_id);
        if (!targetUserId) return failure('invalid_target', '提供的user_id不是有效QQ号，请明确要查询的成员。');
      } else if (nickname !== undefined) {
        if (typeof nickname !== 'string' || !nickname.trim()) return failure('invalid_target', '请提供有效的昵称、群名片或QQ号。');
        const members = await this.getGroupMemberList(e.group_id,e);
        const matches = this.findMembersByNickname(nickname, members);
        if (matches.length > 1) {
          const labels = matches.slice(0, 10).map(member => `${member.card || member.nickname || '群成员'}（QQ ${member.user_id}）`).join('、');
          return failure('needs_clarification', `找到多位匹配成员：${labels}。请明确@哪位或提供QQ号。`, matches);
        }
        if (!matches.length) return failure('not_found', `未找到昵称或群名片匹配“${nickname}”的群成员。`);
        targetUserId = this.validUserId(matches[0]?.user_id);
        if (!targetUserId) return failure('invalid_target', '匹配成员缺少有效QQ号，无法核实。');
      } else {
        const raw = qqViewRecord(event);
        const text = [raw.msg, raw.raw_message].find(value => typeof value === 'string' && value.trim());
        const asksForSelf = typeof text === 'string' && /我(?:是|叫)(?:谁|什么|啥)|我的(?:群)?(?:名片|昵称|资料|信息|头衔|等级|身份)|(?:查|看)(?:询|一下|下)?我(?:的)?(?:资料|信息|名片)/.test(text);
        // Legacy callers without message text retain the documented sender default.
        // A live ambiguous request must not silently turn "he" into the sender.
        if (text && !asksForSelf) return failure('needs_clarification', '要查询哪位成员？请明确@对象、QQ号或昵称。');
        targetUserId = this.validUserId(e.user_id);
        if (!targetUserId) return failure('invalid_target', '没有可确认的查询对象，请提供QQ号或明确@成员。');
      }
      const response = await this.callApi('get_group_member_info', {
        group_id: e.group_id,
        user_id: targetUserId,
        no_cache: true
      },e);

      if (!qqViewApiSucceeded(response) || !response.data) {
        return failure('unavailable', '获取成员信息失败，本次无法核实。');
      }

      const info = qqViewRecord(response.data);
      if (this.validUserId(info.user_id) !== targetUserId) return failure('unavailable', '成员接口返回的对象与查询QQ号不一致，无法核实。');

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
      return failure('unavailable', `查询成员信息失败: ${error instanceof Error?error.message:String(error)}`);
    }
  }
}

return MemberInfoTool
}
