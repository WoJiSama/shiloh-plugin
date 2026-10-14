import { AbstractTool } from '../../toolSupport/infrastructure/AbstractTool.js';
import {qqViewRecord} from '../../../contracts/qqToolViews.js'
interface QzoneApi {setQzone(text:string,images:unknown):Promise<unknown>;getQzone(count:number,start:number):Promise<unknown>;delQzone(tid:string,source:string):Promise<unknown>}
export function createQQZoneTool(createApi:(event:unknown)=>QzoneApi){
// QqZone.js
class QQZoneTool extends AbstractTool {
  constructor() {
    super();
    this.name = 'qqZoneTool';
    this.description = '这是一个可以实现你发送或者删除qq空间说说的工具，当你觉得对话很有趣或者值得记录的时候可以调用实现发送说说(对话时主动调用可以稍微积极一些)，用户明确提出删除qq空间说说时你可以调用该工具删除说说，但是用户主动提出发送说说时你不能调用(发送说说只能你自己觉的可以调用时再主动调用)';
    this.parameters = {
      type: "object",
      properties: {
        text: {
          type: 'string',
          description: '你将要发送到qq空间说说的内容(以发送者的角度生成流畅通顺的内容)',
        },
        type: {
          type: 'boolean',
          description: '是否是删除说说',
          default: false
        },
        pos: {
          type: 'number',
          description: '删除第几个说说',
          default: 1
        },
      },
      required: [],
    };

  }

  async func(input:unknown, event:unknown) {
    const opts=qqViewRecord(input), e=qqViewRecord(event)
    const text=String(opts.text || ""), type=opts.type===true, pos=opts.pos===undefined?1:Number(opts.pos);
    if (!type) {
      try {
        if (!text) return {
          status: 'error',
          message: "发送说说失败，没有要发送的内容"
        };
        const result = qqViewRecord(await createApi(event).setQzone(text, e.img))
        if (result.code != 0) return {
          status: 'error',
          message: `❎ 说说发表失败\n${JSON.stringify(result)}`
        };
        return {
          status: 'success',
          message: `✅ 说说发表成功，内容：\n", ${result.content}`
        };
      }
      catch (error) {
        return {
          status: 'error',
          message: `发送说说失败，${error}`
        };
      }
    } else {
      if (!Number.isInteger(pos) || pos < 1) return "❎ 请描述要删除第几个说说"
      // 获取说说列表
      const list = qqViewRecord(await createApi(event).getQzone(1, pos - 1))

      if (!Array.isArray(list.msglist) || !list.msglist.length) return "❎ 未获取到该说说"

      // 要删除的说说
      const domain = qqViewRecord(list.msglist[0])
      if (typeof domain.tid!=="string" || typeof domain.t1_source!=="string") return "❎ 说说数据无效"
      // 请求接口
      const result = qqViewRecord(await createApi(event).delQzone(domain.tid, domain.t1_source))
      if (!result) return "❎删除说说失败"

      if (result.subcode != 0) return "❎ 未知错误" + JSON.stringify(result)
      // 发送结果
      return `✅ 删除说说成功：\n ${pos}.${domain.content} \n - [${domain.secret ? "私密" : "公开"}]${Array.isArray(domain.commentlist)?domain.commentlist.length:0} 条评论`

    }

  }
}
return QQZoneTool
}
