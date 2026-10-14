import type {CardBaseConstructor} from '../../../contracts/mediaCards.js';
let sequence=0;
export function createMagnetSearchReport(Base:CardBaseConstructor){

class MagnetSearchReport extends Base {
  constructor(e:unknown) {
    super(e)
    this.model = "magnetSearchReport"
  }

  async getData(data:Record<string,unknown>, scale = 1) {
    return {
      ...this.screenData,
      saveId: `magnet-search-${String(this.userId||"report").replace(/[^a-zA-Z0-9_-]/g,"-")}-${Date.now()}-${++sequence}`,
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

return MagnetSearchReport;
}
