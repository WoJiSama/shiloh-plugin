import {hostRecord} from './hostMessageTypes.js'
import type {HostPluginBase,HostEvent,HostBot} from './hostMessageTypes.js'
import { collectMentionTargetIds } from "../../conversation/domain/mentionTargets.js";
export function createQQinfo(Plugin:HostPluginBase,ports:{getBot():HostBot;fetchImpl?:typeof fetch;Qqinfo:new(event:unknown)=>{getData(data:Record<string,unknown>):Promise<unknown>};puppeteer:{screenshot(name:string,data:unknown,scale:number):Promise<unknown>}}){
const {Qqinfo,puppeteer}=ports
return class QQinfo extends Plugin {
    constructor() {
        super({
            name: "进群查询qq信息",
            dsc: "进群查询qq信息",
            event: "message",
            priority: 5000,
            rule: [
                {
                    reg: '#查询qq.*$',
                    fnc: "getInfo",
                }
            ]
        })
    }

    async getInfo(e:HostEvent) {
        const bot = e.bot ?? ports.getBot()
        const mentionedUserId = collectMentionTargetIds({...e,message:(e.message||[]).map(hostRecord)}, bot.uin)[0]
        let mid = mentionedUserId || e.msg.replace(/#| |查询qq/g, "")
        if (mid == "") {
            return e.reply("请输入qq号或者直接艾特再发送命令", true)
        }
        const KEY_DATA = await bot.sendApi('get_credentials', {
            domain: "vip.qq.com",
        })

        const cookies=String(hostRecord(hostRecord(KEY_DATA).data).cookies || "")
        const cookie=(name:string)=>cookies.split(';').map(part=>part.trim()).find(part=>part.startsWith(`${name}=`))?.slice(name.length+1)||''
        const params=new URLSearchParams({qq:mid,return:'json',uin:cookie('uin'),skey:cookie('skey'),pskey:cookie('p_skey')})
        const url=`https://jiuli.xiaoapi.cn/i/qq/qq_level.php?${params}`
        const DATA_JSON = hostRecord(await (ports.fetchImpl || fetch)(url).then(res => res.json()) as unknown)

        DATA_JSON.cardTitle = '信息查询成功！！！'
        
        const data = await new Qqinfo(e).getData(DATA_JSON);
        
        let img = await puppeteer.screenshot("qqinfo", data, 2);
        return e.reply(img);
    }
}

}
