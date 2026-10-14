import type {CardBaseConstructor} from '../../../contracts/mediaCards.js';
export function createModrinthCard(Base:CardBaseConstructor){

let renderSequence = 0

function safeSavePart(value:unknown = "") {
  return String(value || "ranking").replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80) || "ranking"
}

class ModrinthCard extends Base {
  constructor(e:unknown) {
    super(e)
    this.model = "modrinthCard"
  }

  async getData(data:Record<string,unknown>, scale = 1) {
    const projectKey = safeSavePart(data?.projectId || data?.rank)
    const sequence = ++renderSequence
    return {
      ...this.screenData,
      // Parallel cards must never share an HTML temp file. The renderer writes
      // the template before opening it in Chromium.
      saveId: `modrinth-${safeSavePart(this.userId)}-${projectKey}-${Date.now()}-${sequence}`,
      imgType: "jpeg",
      quality: 82,
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

return ModrinthCard;
}
