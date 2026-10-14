import {createObserveWebApp} from '../dist/backend/modules/platform/infrastructure/console/observeWebApp.js'
const app = createObserveWebApp({bots:()=>globalThis.Bot || {},logger:globalThis.logger})
export const {registerObserveWebApp} = app
