import {AdCorpusStore as Runtime} from '../../dist/backend/modules/groupAdmin/infrastructure/adCorpusStore.js'
export class AdCorpusStore extends Runtime {constructor(options={}){super({logger:globalThis.logger,...options})}}
export const adCorpusStore=new AdCorpusStore()
