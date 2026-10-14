import type {CardRenderer} from '../../../contracts/mediaCards.js';
import {pixivRecord as record} from '../../../contracts/pixiv.js';
export function createModrinthCardRenderer(puppeteer:CardRenderer,ModrinthCard:new(e:unknown)=>{getData(data:Record<string,unknown>,scale:number):Promise<Record<string,unknown>>}){
async function prewarmModrinthCardRenderer() {
  if (typeof puppeteer?.browserInit !== "function") return true
  const browser = await puppeteer.browserInit()
  if (!browser) throw new Error("Chromium 渲染器未就绪")
  return true
}

async function renderModrinthCard(e:unknown, card:Record<string,unknown> = {}) {
  const data = await new ModrinthCard(e).getData({
    ...record(card.view),
    projectId: card.projectId || record(card.view).projectId || ""
  }, 1)
  return await puppeteer.screenshot("modrinthCard", data, 2)
}

return {prewarmModrinthCardRenderer,renderModrinthCard};
}
