import puppeteer from '../../../lib/puppeteer/puppeteer.js'
import Qqinfo from '../model/qqinfo.js'
import {createQQinfo} from '../dist/backend/modules/host/infrastructure/qqinfoApp.js'
export const QQinfo=createQQinfo(plugin,{getBot:()=>globalThis.Bot,puppeteer,Qqinfo})
