import {renderRecord} from './renderDecoders.js'
export function createBaseModel(pluginName:unknown) {
 if(typeof pluginName!=='string'||!pluginName.trim())throw new TypeError('插件包缺少有效名称')
 const name=pluginName
 return class Base {
  static pluginName=name
  e:Record<string,unknown>;userId:string|number|undefined;model:string;_path:string
  constructor(event:unknown={}) {
   this.e=renderRecord(event)
   this.userId=typeof this.e.user_id==='string'||typeof this.e.user_id==='number'?this.e.user_id:undefined
   this.model=Base.pluginName;this._path=process.cwd().replace(/\\/g,'/')
  }
  get prefix(){return `Yz:${Base.pluginName}:${this.model}:`}
  get screenData(){return {saveId:this.userId,tplFile:`./plugins/${Base.pluginName}/resources/html/${this.model}/${this.model}.html`,pluResPath:`${this._path}/plugins/${Base.pluginName}/resources/`,pageGotoParams:{waitUntil:'load',timeout:60000},imgType:'jpeg',multiPageHeight:12000}}
 }
}
