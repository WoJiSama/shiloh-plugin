import {createSearchVideoTool} from '../../dist/backend/modules/toolSupport/infrastructure/SearchVideoTool.js'
export const SearchVideoTool=createSearchVideoTool({image:url=>globalThis.segment.image(url),sendvideos:async(...args)=>(await import('../tools/sendvideos.js')).sendvideos(...args)})
