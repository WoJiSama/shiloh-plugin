import { test } from "node:test"
import assert from "node:assert/strict"
import {
  DeltaForceClient,
  buildPriceHistoryReportData,
  buildObjectValueReportData,
  buildDeltaForceUrl,
  buildSolutionListReportData,
  formatDailyKeywordResponse,
  formatObjectValueSearchResponse,
  formatPlaceProfitResponse,
  formatPriceHistoryResponse,
  formatProfitRankResponse,
  formatSolutionListResponse,
  getDeltaForceHelp,
  getDeltaForcePlaceHelp,
  normalizeHistoryDays,
  normalizeDeltaForcePlace,
  normalizeRankLimit
} from "../domains/games/deltaforce/DeltaForceClient.js"

test("buildDeltaForceUrl joins base url and api path", () => {
  assert.equal(
    buildDeltaForceUrl("https://api.example.com/", "/api/v1/df/tools/dailykeyword"),
    "https://api.example.com/api/v1/df/tools/dailykeyword"
  )
  assert.equal(
    buildDeltaForceUrl("https://api.example.com/", "/api/v1/df/place/profit/rank", { place: "workbench", limit: 3 }),
    "https://api.example.com/api/v1/df/place/profit/rank?place=workbench&limit=3"
  )
})

test("DeltaForceClient sends X-API-Key header for daily keyword", async () => {
  let seenUrl = ""
  let seenHeaders = {}
  const client = new DeltaForceClient({
    deltaForceSystem: {
      enabled: true,
      apiBaseUrl: "https://api.example.com",
      apiKey: "secret",
      timeoutMs: 1000
    }
  }, {
    fetchImpl: async (url, options) => {
      seenUrl = url
      seenHeaders = options.headers
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: { keyword: "零号大坝", password: "1234" } })
      }
    }
  })

  const result = await client.getDailyKeyword()
  assert.equal(seenUrl, "https://api.example.com/api/v1/df/tools/dailykeyword")
  assert.equal(seenHeaders["X-API-Key"], "secret")
  assert.equal(result.data.password, "1234")
})

test("DeltaForceClient requests place profit rank with place enum and limit", async () => {
  let seenUrl = ""
  const client = new DeltaForceClient({
    deltaForceSystem: {
      enabled: true,
      apiBaseUrl: "https://api.example.com",
      apiKey: "secret"
    }
  }, {
    fetchImpl: async (url) => {
      seenUrl = url
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: { items: [] } })
      }
    }
  })

  await client.getPlaceProfitRank({ placeType: "workbench", limit: 3 })
  assert.equal(seenUrl, "https://api.example.com/api/v1/df/place/profit/rank?place=workbench&limit=3")

  await client.getPlaceProfitRank({ placeType: "workbench", limit: 99 })
  assert.equal(seenUrl, "https://api.example.com/api/v1/df/place/profit/rank?place=workbench&limit=20")
})

test("DeltaForceClient requests object list endpoint", async () => {
  let seenUrl = ""
  const client = new DeltaForceClient({
    deltaForceSystem: {
      enabled: true,
      apiBaseUrl: "https://api.example.com",
      apiKey: "secret"
    }
  }, {
    fetchImpl: async (url) => {
      seenUrl = url
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: { list: [] } })
      }
    }
  })

  await client.getObjectList()
  assert.equal(seenUrl, "https://api.example.com/api/v1/df/object/list?page=1&limit=1000")
})

test("DeltaForceClient fetches all object list pages", async () => {
  const seenUrls = []
  const client = new DeltaForceClient({
    deltaForceSystem: {
      enabled: true,
      apiBaseUrl: "https://api.example.com",
      apiKey: "secret"
    }
  }, {
    fetchImpl: async (url) => {
      seenUrls.push(url)
      const page = Number(new URL(url).searchParams.get("page"))
      const list = page === 1
        ? [{ objectID: 1, objectName: "A" }, { objectID: 2, objectName: "B" }]
        : [{ objectID: 3, objectName: "C" }]
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: { list, total: 3, page, limit: 2 } })
      }
    }
  })

  const body = await client.getAllObjectList({ limit: 2 })
  assert.equal(body.data.list.length, 3)
  assert.deepEqual(seenUrls.map(url => new URL(url).searchParams.get("page")), ["1", "2"])
})

test("DeltaForceClient searches object value by name or id", async () => {
  const seenUrls = []
  const client = new DeltaForceClient({
    deltaForceSystem: {
      enabled: true,
      apiBaseUrl: "https://api.example.com",
      apiKey: "secret"
    }
  }, {
    fetchImpl: async (url) => {
      seenUrls.push(url)
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: { list: [], total: 0 } })
      }
    }
  })

  await client.searchObjectValue({ keyword: "H70", limit: 99 })
  await client.searchObjectValue({ keyword: "11010006002-c1" })
  assert.equal(seenUrls[0], "https://api.example.com/api/v1/df/price/ocr/latest?page=1&limit=20&objectName=H70")
  assert.equal(seenUrls[1], "https://api.example.com/api/v1/df/price/ocr/latest?page=1&limit=10&objectID=11010006002-c1")
})

test("DeltaForceClient requests price history and fetches pages", async () => {
  const seenUrls = []
  const client = new DeltaForceClient({
    deltaForceSystem: {
      enabled: true,
      apiBaseUrl: "https://api.example.com",
      apiKey: "secret"
    }
  }, {
    fetchImpl: async (url) => {
      seenUrls.push(url)
      const page = Number(new URL(url).searchParams.get("page"))
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          data: {
            items: page === 1
              ? [{ objectID: "110-c1", objectName: "显卡", price: 100, timestamp: 1782740000 }]
              : [{ objectID: "110-c1", objectName: "显卡", price: 120, timestamp: 1782826400 }],
            pagination: { page, limit: 1, total: 2, hasMore: page === 1 },
            stats: { days: 30 }
          }
        })
      }
    }
  })

  const body = await client.getAllPriceHistory({ objectID: "110-c1", days: 30, limit: 1 })
  assert.equal(seenUrls[0], "https://api.example.com/api/v1/df/price/ocr/history?objectID=110-c1&days=30&page=1&limit=1")
  assert.equal(seenUrls[1], "https://api.example.com/api/v1/df/price/ocr/history?objectID=110-c1&days=30&page=2&limit=1")
  assert.equal(body.data.items.length, 2)
})

test("price history report groups daily prices into chart rows", () => {
  const body = {
    data: {
      keyword: "显卡",
      days: 30,
      items: [
        {
          latest: { objectID: "110-c1", objectName: "显卡", condition: "全新" },
          history: {
            data: {
              items: [
                { objectID: "110-c1", objectName: "显卡", condition: "全新", price: 100, timestamp: 1782740000 },
                { objectID: "110-c1", objectName: "显卡", condition: "全新", price: 200, timestamp: 1782743600 },
                { objectID: "110-c1", objectName: "显卡", condition: "全新", price: 300, timestamp: 1782826400 }
              ]
            }
          }
        }
      ]
    }
  }

  const report = buildPriceHistoryReportData(body, { keyword: "显卡" })
  assert.equal(report.kind, "price-history")
  assert.equal(report.rows.length, 1)
  assert.equal(report.rows[0].name, "显卡")
  assert.equal(report.rows[0].pointCount, 2)
  assert.match(report.rows[0].chartSvg, /<svg/)
  assert.match(formatPriceHistoryResponse(body, { keyword: "显卡" }), /显卡/)
  assert.equal(normalizeHistoryDays(999), 90)
})

test("DeltaForceClient requests solution list with page and bounded limit", async () => {
  const seenUrls = []
  const client = new DeltaForceClient({
    deltaForceSystem: {
      enabled: true,
      apiBaseUrl: "https://api.example.com",
      apiKey: "secret"
    }
  }, {
    fetchImpl: async (url) => {
      seenUrls.push(url)
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: { list: [], total: 0 } })
      }
    }
  })

  await client.getSolutionList({ keyword: "M4", limit: 99 })
  assert.equal(seenUrls[0], "https://api.example.com/api/v1/df/tools/solution/list?page=1&limit=20&keyword=M4")
})

test("formatDailyKeywordResponse supports common response shapes", () => {
  assert.equal(
    formatDailyKeywordResponse({ data: { keyword: "行政楼", password: "0420" } }),
    "三角洲今日密码\n口令：行政楼\n密码：0420"
  )
  assert.equal(
    formatDailyKeywordResponse({ data: ["0420", "7788"] }),
    "三角洲今日密码\n1. 0420\n2. 7788"
  )
})

test("formatDailyKeywordResponse renders map secrets for daily keyword list", () => {
  assert.equal(
    formatDailyKeywordResponse({
      data: {
        list: [
          { mapID: 1, mapName: "零号大坝", secret: "2859" },
          { mapID: 4, mapName: "航天基地", secret: "4152" }
        ]
      }
    }),
    "三角洲今日密码\n零号大坝：2859\n航天基地：4152"
  )
})

test("formatPlaceProfitResponse renders top profit per place level", () => {
  const body = {
    data: {
      manufacturingPlaces: [
        {
          level: 1,
          manufacturingItems: [
            { objectName: "低利润", placeType: "workbench", level: 1, hourProfit: 10, totalProfit: 20 },
            {
              objectName: "高利润",
              placeType: "workbench",
              level: 1,
              hourProfit: 50,
              totalProfit: 100,
              required: [{ objectID: 1001, count: 2 }]
            }
          ]
        },
        {
          level: 2,
          manufacturingItems: [
            { objectName: "技术物品", placeType: "tech", level: 2, hourProfit: 30, totalProfit: 90 }
          ]
        }
      ]
    }
  }

  assert.equal(
    formatPlaceProfitResponse(body, { objectNameResolver: { getName: id => String(id) === "1001" ? "测试材料" : "" } }),
    "三角洲特勤处利润（Top 2）\n工作台\n高利润｜Lv1｜时利 50｜总利 100\n材料：测试材料*2\n技术中心\n技术物品｜Lv2｜时利 30｜总利 90"
  )
  assert.equal(
    formatPlaceProfitResponse(body, { placeType: "workbench" }),
    "三角洲特勤处利润（Top 1）\n工作台\n高利润｜Lv1｜时利 50｜总利 100"
  )
  assert.equal(normalizeRankLimit(99), 20)
})

test("formatProfitRankResponse renders ranked profit items", () => {
  assert.equal(
    formatProfitRankResponse({
      data: {
        items: [
          { rank: 1, objectName: "5.56*45mm M855A1 APC+", placeName: "工作台", placeType: "workbench", level: 2, hourProfit: 42789.43, totalProfit: 299526 },
          { rank: 2, objectName: "5.45x39mm BS", placeName: "工作台", placeType: "workbench", level: 3, hourProfit: 35850, totalProfit: 286800 }
        ]
      }
    }, { placeType: "workbench", limit: 10 }),
    "三角洲利润排行（工作台 Top 2）\n1. 5.56*45mm M855A1 APC+｜工作台｜Lv2｜时利 42,789.43｜总利 299,526\n2. 5.45x39mm BS｜工作台｜Lv3｜时利 35,850｜总利 286,800"
  )
})

test("formatObjectValueSearchResponse renders item value results", () => {
  assert.equal(
    formatObjectValueSearchResponse({
      data: {
        keyword: "H70",
        items: [
          {
            objectID: "11010006002-c1",
            objectName: "H70 精英头盔",
            condition: "全新",
            latestPrice: 2327481,
            avgPrice: 2525680.1460494814,
            minPrice: 224781,
            maxPrice: 3431381,
            count: 1253,
            change: 1.74420053322702,
            lastUpdated: 1782745027
          },
          {
            objectID: "11010006002-c2",
            objectName: "H70 精英头盔",
            condition: "几乎全新",
            latestPrice: 723504,
            avgPrice: 812687.2362330407,
            minPrice: 100619,
            maxPrice: 1028739,
            count: 1253,
            change: -3.030368013467111,
            lastUpdated: 1782745027
          }
        ],
        pagination: { total: 3 }
      }
    }, { keyword: "H70", limit: 10 }),
    "三角洲物品价值：H70（Top 2 / 共 3 条）\n1. H70 精英头盔｜全新｜现价 2,327,481｜均价 2,525,680｜最低 224,781｜最高 3,431,381｜涨跌 +1.74%｜样本 1,253｜2026/6/29 22:57:07\n2. H70 精英头盔｜几乎全新｜现价 723,504｜均价 812,687｜最低 100,619｜最高 1,028,739｜涨跌 -3.03%｜样本 1,253｜2026/6/29 22:57:07"
  )

  assert.equal(
    formatObjectValueSearchResponse({ data: { keyword: "燃油", list: [], total: 0 } }),
    "没有找到「燃油」的物品价值数据，可能价格库暂时未覆盖这个物品"
  )
})

test("buildObjectValueReportData maps object value rows for image report", () => {
  const report = buildObjectValueReportData({
    data: {
      keyword: "H70",
      items: [
        {
          objectID: "11010006002-c1",
          objectName: "H70 精英头盔",
          condition: "全新",
          latestPrice: 2327481,
          avgPrice: 2525680.1460494814,
          minPrice: 224781,
          maxPrice: 3431381,
          count: 1253,
          change: 1.74420053322702,
          lastUpdated: 1782745027
        }
      ],
      pagination: { total: 3 }
    }
  }, { keyword: "H70", limit: 10 })

  assert.equal(report.kind, "object-value")
  assert.equal(report.title, "三角洲物品价值：H70（Top 1 / 共 3 条）")
  assert.deepEqual(report.columns, ["排名", "物品", "成色", "现价", "均价", "价格区间", "涨跌/样本", "更新时间"])
  assert.deepEqual(report.rows[0], {
    rank: 1,
    name: "H70 精英头盔",
    condition: "全新",
    latestPrice: "2,327,481",
    avgPrice: "2,525,680",
    minPrice: "224,781",
    maxPrice: "3,431,381",
    change: "+1.74%",
    count: "1,253",
    updateTime: "2026/6/29 22:57:07"
  })
})

test("formatSolutionListResponse renders gun solution codes", () => {
  assert.equal(
    formatSolutionListResponse({
      data: {
        keyword: "金枪客",
        list: [
          {
            name: "金枪客5交枪",
            armsDetail: { objectName: "ASh-12战斗步枪" },
            solutionCode: "ASh-12战斗步枪-烽火地带-6KGEMOC00ES0HEAQBTB8O",
            price: 371453,
            costPrice: 250040,
            applyNum: 64931,
            likeNum: 264,
            stickTag: "金枪客",
            authorComment: "<p>金枪客5最省交枪</p>"
          }
        ],
        total: 1
      }
    }, { keyword: "金枪客", limit: 10 }),
    "三角洲改枪码：金枪客（Top 1）\n1. ASh-12战斗步枪｜金枪客5交枪｜金枪客｜价格 371,453｜成本 250,040｜使用 64,931｜点赞 264\n改枪码：ASh-12战斗步枪-烽火地带-6KGEMOC00ES0HEAQBTB8O\n说明：金枪客5最省交枪"
  )

  assert.equal(
    formatSolutionListResponse({ data: { keyword: "不存在", list: [], total: 0 } }),
    "没有找到「不存在」相关的改枪码"
  )
})

test("buildSolutionListReportData maps gun solution rows for image report", () => {
  const report = buildSolutionListReportData({
    data: {
      keyword: "金枪客",
      list: [
        {
          name: "金枪客5交枪",
          armsDetail: { objectName: "ASh-12战斗步枪" },
          solutionCode: "ASh-12战斗步枪-烽火地带-6KGEMOC00ES0HEAQBTB8O",
          price: 371453,
          costPrice: 250040,
          applyNum: 64931,
          likeNum: 264,
          stickTag: "金枪客",
          authorComment: "<p>金枪客5最省交枪</p>"
        }
      ],
      total: 1
    }
  }, { keyword: "金枪客", limit: 10 })

  assert.equal(report.kind, "solution-list")
  assert.equal(report.title, "三角洲改枪码：金枪客（Top 1）")
  assert.deepEqual(report.columns, ["排名", "武器与方案", "标签", "价格/成本", "热度", "改枪码与说明"])
  assert.deepEqual(report.rows[0], {
    rank: 1,
    weapon: "ASh-12战斗步枪",
    name: "金枪客5交枪",
    tag: "金枪客",
    price: "371,453",
    costPrice: "250,040",
    applyNum: "64,931",
    likeNum: "264",
    solutionCode: "ASh-12战斗步枪-烽火地带-6KGEMOC00ES0HEAQBTB8O",
    comment: "金枪客5最省交枪"
  })
})

test("DeltaForceClient reports missing config clearly", async () => {
  const client = new DeltaForceClient({ deltaForceSystem: { enabled: true } })
  await assert.rejects(() => client.getDailyKeyword(), /API Base URL 未配置/)
})

test("help includes current delta force commands", () => {
  const help = getDeltaForceHelp()
  assert.match(help, /\.三角洲 今日密码/)
  assert.match(help, /制作场所：工作台 \/ 技术中心 \/ 制药台 \/ 防具台/)
  assert.doesNotMatch(help, /\.三角洲 制作场所/)
  assert.match(help, /\.三角洲 特勤处利润/)
  assert.match(help, /\.三角洲 利润排行/)
  assert.match(help, /\.三角洲 物品价值/)
  assert.match(help, /\.三角洲 改枪码/)
  assert.match(getDeltaForcePlaceHelp(), /工作台：workbench/)
  assert.equal(normalizeDeltaForcePlace("药台").type, "pharmacy")
})

test("Guoba schema exposes delta force api key config", async () => {
  const { default: deltaForceSchema } = await import("../models/Guoba/schemas/deltaForce.js")
  const fields = deltaForceSchema.map(item => item.field).filter(Boolean)
  assert.ok(fields.includes("deltaForceSystem.enabled"))
  assert.ok(fields.includes("deltaForceSystem.apiBaseUrl"))
  assert.ok(fields.includes("deltaForceSystem.apiKey"))
  assert.ok(fields.includes("deltaForceSystem.objectCacheEnabled"))
  assert.ok(fields.includes("deltaForceSystem.objectCacheRefreshMinutes"))
})
