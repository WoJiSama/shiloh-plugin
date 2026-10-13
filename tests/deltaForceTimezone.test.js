import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

test('Delta Force timestamps remain Beijing time across host timezones', () => {
  const moduleUrl = new URL('../domains/games/deltaforce/DeltaForceClient.js', import.meta.url).href
  const script = `import { buildObjectValueReportData } from ${JSON.stringify(moduleUrl)};
    const report = buildObjectValueReportData({data:{items:[{objectName:'fixture',lastUpdated:1782745027}],pagination:{total:1}}});
    console.log(report.rows[0].updateTime);`
  for (const timezone of ['UTC', 'Asia/Shanghai', 'America/Los_Angeles']) {
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, TZ: timezone }, encoding: 'utf8'
    }).trim()
    assert.equal(output, '2026/6/29 22:57:07', timezone)
  }
})
