import Base from "../../../../model/base.js"

export default class MagnetSearchReport extends Base {
  constructor(e) {
    super(e)
    this.model = "magnetSearchReport"
  }

  async getData(data, scale = 1) {
    return {
      ...this.screenData,
      saveId: `magnet-search-${this.userId || "report"}`,
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
