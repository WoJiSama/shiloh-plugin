

interface RequestOptions {headers?:Record<string,string>;params?:Record<string,unknown>;data?:unknown;responseType?:'json'}
export interface QQBot {uin?:string|number;cookies?:Record<string,string>;sendApi?(name:string,params:Record<string,unknown>):Promise<unknown>}
interface QQEvent {bot?:QQBot}
interface Cookie {name:string;value:string;domain:string;path:string;expires:number}
function record(value:unknown):Record<string,unknown>{return value && typeof value==='object' && !Array.isArray(value)?value as Record<string,unknown>:{}}
export function createQQApi(ports:{bot():QQBot;request:{get(url:string,options:RequestOptions):Promise<unknown>;post(url:string,options:RequestOptions):Promise<unknown>}}) {
const request=ports.request
/** QQ接口 */
class QQApi {
 e:QQEvent;Bot:QQBot;headers:Record<string,string>
  constructor(e:QQEvent) {
    this.e = e
    this.Bot = e.bot ?? ports.bot()
    this.headers = {
      "Content-type": "application/json;charset=UTF-8",
      "Cookie": this.Bot.cookies?.["qun.qq.com"] || "",
      "qname-service": "976321:131072",
      "qname-space": "Production"
    }
  }

  getGtk(data:string) {
    let ck = this.getck(data, this.Bot)
    // eslint-disable-next-line no-var
    for (var e = ck.p_skey || "", n = 5381, r = 0, o = e.length; r < o; ++r) {
      n += (n << 5) + e.charAt(r).charCodeAt(0)
    }
    return 2147483647 & n
  }

  /**
   * 取cookie
   * @param {string} data 如：qun.qq.com
   * @param {object} [bot] Bot对象适配e.bot
   * @param {boolean} [transformation] 转换为Puppeteer浏览器使用的ck
   * @returns {object}
   */
  getck(data:string,bot?:QQBot,transformation?:false):Record<string,string>
  getck(data:string,bot:QQBot|undefined,transformation:true):Cookie[]
  getck(data:string,bot:QQBot=ports.bot(),transformation=false):Record<string,string>|Cookie[] {
    let cookie = bot.cookies?.[data] || ""
    function parseCkString(str:string) {
      // 使用分号和等号分割字符串
      const pairs = str.split(";")
      const obj:Record<string,string> = {}

      pairs.forEach(pair => {
        // 分割键和值，注意去除两侧的空格
        const normalized=pair.trim()
        const separator=normalized.indexOf("=")
        const key=separator<0?normalized:normalized.slice(0,separator)
        const value=separator<0?"":normalized.slice(separator+1)
        if (key) {
          // 将键值对添加到对象中
          try {obj[key] = decodeURIComponent(value)} catch {obj[key]=value} // 解码URL编码的值
        }
      })

      return obj
    }

    const ck = parseCkString(cookie)
    if (transformation) {
      let arr = []
      for (let i in ck) {
        arr.push({
          name: i,
          value: ck[i] || "",
          domain: data,
          path: "/",
          expires: Math.floor(Date.now()/1000) + 3600
        })
      }
      return arr
    } else return ck
  }

  async getToken():Promise<{cookies:string;token:string|number}> {
    if(!this.Bot.sendApi)throw new Error('当前机器人不支持 QQ 凭据查询')
    const response=record(await this.Bot.sendApi('get_credentials',{domain:'qzone.qq.com'}))
    const data=record(response.data)
    if(typeof data.cookies !== 'string'|| !data.cookies || (typeof data.token !== 'string' && typeof data.token !== 'number'))throw new Error('QQ 凭据响应无效')
    return {cookies:data.cookies,token:data.token}
  }

  /**
   * 取说说列表
   * @param {number} num 数量
   * @param {number} pos 偏移量
   * @returns {object} QQ空间数据
   */
  async getQzone(num = 20, pos = 0) {
    const url = "https://user.qzone.qq.com/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_msglist_v6"
    const tokenInfo = await this.getToken()
    return await request.get(url, {
      headers: {
        Cookie: tokenInfo.cookies
      },
      params: {
        uin: this.Bot.uin,
        ftype: 0,
        sort: 0,
        pos,
        num,
        replynum: 100,
        g_tk: tokenInfo.token,
        code_version: 1,
        format: "json",
        need_private_comment: 1
      },
      responseType: "json"
    })
  }

  /**
   * 删除说说
   * @param {string} tid tid参数
   * @param {string} t1_source t1_source参数
   */
  async delQzone(tid:string, t1_source:string) {
    const url = "https://user.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_delete_v6"
    const tokenInfo = await this.getToken()
    // 发送请求
    return await request.post(url, {
      headers: {
        "Cookie": tokenInfo.cookies,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      params: {
        g_tk: tokenInfo.token
      },
      data: {
        hostuin: this.Bot.uin,
        tid,
        t1_source,
        code_version: 1,
        format: "json"
      },
      responseType: "json"
    })
  }

  /**
   * 发送说说
   * @param con
   * @param img
   */
  async setQzone(con:string, img?:unknown) {
    const url = "https://user.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_publish_v6"
    const tokenInfo = await this.getToken()
    return request.post(url, {
      headers: {
        "Cookie": tokenInfo.cookies,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      params: {
        g_tk: tokenInfo.token
      },
      data: {
        syn_tweet_verson: 1,
        paramstr: 1,
        con,
        feedversion: 1,
        ver: 1,
        ugc_right: 1,
        to_sign: 1,
        hostuin: this.Bot.uin,
        code_version: 1,
        format: "json"
      },
      responseType: "json"
    })
  }

  /**
   * 获取留言
   * @param {number} num 数量为0时返回为全部
   * @param {number} start 偏移量/开始的位置
   * @returns {*}
   */
  async getQzoneMsgb(num = 0, start = 0) {
    const url = "https://user.qzone.qq.com/proxy/domain/m.qzone.qq.com/cgi-bin/new/get_msgb"
    const tokenInfo = await this.getToken()
    return await request.get(url, {
      params: {
        uin: this.Bot.uin,
        hostUin: this.Bot.uin,
        start,
        s: 0.45779069937151884,
        format: "json",
        num,
        inCharset: "utf-8",
        outCharset: "utf-8",
        g_tk: tokenInfo.token
      },
      headers: {
        cookie: tokenInfo.cookies
      },
      responseType: "json"
    })
  }

  /**
   * 删除留言
   * @param {*} id 留言id
   * @param {*} uinId
   * @returns {*}
   */
  async delQzoneMsgb(id:string|number, uinId:string|number) {
    const url = "https://h5.qzone.qq.com/proxy/domain/m.qzone.qq.com/cgi-bin/new/del_msgb"
    const tokenInfo = await this.getToken()
    return await request.post(url, {
      headers: {
        "Cookie": tokenInfo.cookies,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      params: {
        g_tk: tokenInfo.token
      },
      data: {
        hostUin: this.Bot.uin,
        idList: id,
        uinList: uinId,
        format: "json",
        iNotice: 1,
        inCharset: "utf-8",
        outCharset: "utf-8",
        ref: "qzone",
        g_tk: tokenInfo.token,
        json: 1
      },
      responseType: "json"
    })
  }
}

return QQApi
}
