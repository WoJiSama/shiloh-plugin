import Base from "../../../../model/base.js"

export default class UmaRaceReport extends Base {
  constructor(e) {
    super(e)
    this.model = "umaRaceReport"
  }

  async getData(data, scale = 1) {
    return {
      ...this.screenData,
      saveId: `uma-race-${this.userId || "report"}`,
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
