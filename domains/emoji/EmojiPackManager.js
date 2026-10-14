import {EmojiPackManager as TypedEmojiPackManager} from '../../dist/backend/modules/emoji/infrastructure/EmojiPackManager.js'
export {emojiFamiliarity} from '../../dist/backend/modules/emoji/infrastructure/EmojiPackManager.js'
export class EmojiPackManager extends TypedEmojiPackManager {constructor(){super({logger:globalThis.logger})}}
export const emojiPackManager=EmojiPackManager.getInstance({logger:globalThis.logger})
export default emojiPackManager
