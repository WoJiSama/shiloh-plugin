import {createDeltaForceReportRenderer} from '../../../dist/backend/modules/games/infrastructure/DeltaForceReportRenderer.js'
export {buildDeltaForceReportView} from '../../../dist/backend/modules/games/infrastructure/DeltaForceReportRenderer.js'
// 云崽 puppeteer 与 Base(依赖云崽 cwd 的 model/base.js)只在真正渲染报表时才需要;
// 独立控制台进程没有云崽运行环境,静态导入会在装配期失败
let renderer = null
export async function renderDeltaForceReport(...args) {
  if (!renderer) {
    const [{ default: puppeteer }, { default: DeltaForceReport }] = await Promise.all([
      import("../../../../../lib/puppeteer/puppeteer.js"),
      import("./model/DeltaForceReport.js")
    ])
    renderer = createDeltaForceReportRenderer(puppeteer, DeltaForceReport)
  }
  return renderer.renderDeltaForceReport(...args)
}
