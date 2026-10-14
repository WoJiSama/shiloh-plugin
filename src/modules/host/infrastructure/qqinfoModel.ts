type BaseClass=new(event:unknown)=>{screenData:Record<string,unknown>;model:string}


export function createQqinfo(Base:BaseClass){
return class Qqinfo extends Base {
    constructor(e:unknown) {
        super(e)
        this.model = 'qqinfo'
    }

    /** 生成版本信息图片 */
    async getData(data:Record<string,unknown>, scale?:number) {
        return {
            ...this.screenData,
            saveId: 'qqinfo',
            ...data,
            sys: {
                scale: this.scale(scale || 1)
            },
        }
    }

    scale(pct = 1) {
        const renderScale = 100
        const scale = Math.min(2, Math.max(0.5, renderScale / 100))
        pct = pct * scale
        return `style=transform:scale(${pct})`
    }
}

}
