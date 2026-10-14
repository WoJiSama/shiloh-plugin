import QRCode from 'qrcode'
import {createBilibiliAuthManager} from '../dist/backend/modules/media/infrastructure/BilibiliAuthManager.js'
const TypedBilibiliAuthManager=createBilibiliAuthManager(QRCode)
export class BilibiliAuthManager extends TypedBilibiliAuthManager {
 constructor(options={}) {super({logger:globalThis.logger,...options})}
}
