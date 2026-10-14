import {emojiPackManager} from './EmojiPackManager.js'
import {TakeImages} from '../../utils/fileUtils.js'
import common from '../../../../lib/common/common.js'
import {createEmojiPackPlugin} from '../../dist/backend/modules/emoji/infrastructure/app.js'
export const EmojiPackPlugin=createEmojiPackPlugin(plugin,{manager:emojiPackManager,takeImages:TakeImages,makeForwardMsg:common.makeForwardMsg.bind(common),image:file=>segment.image(file)})
