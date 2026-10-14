import type {CardBaseConstructor} from '../../../../contracts/mediaCards.js'
export function createUmaRaceReport(Base:CardBaseConstructor){
let sequence=0
class UmaRaceReport extends Base {
  constructor(e:unknown) {
    super(e)
    this.model = "umaRaceReport"
  }

  async getData(data:Record<string,unknown>, scale = 1) {
    return {
      ...this.screenData,
      saveId: `uma-race-${String(this.userId || "report").replace(/[^a-zA-Z0-9_-]/g,"-")}-${Date.now()}-${++sequence}`,
      imgType: "png",
      ...data,
      sys: {
        scale: this.scale(scale)
      }
    }
  }

  scale(pct = 1) {
    return `style=transform:scale(${Math.min(2, Math.max(0.5, pct))})`
  }
}

return UmaRaceReport
}
