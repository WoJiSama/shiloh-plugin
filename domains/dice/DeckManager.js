import {fileURLToPath} from 'node:url'
import {DeckManager as TypedDeckManager} from '../../dist/backend/modules/dice/infrastructure/DeckManager.js'
export class DeckManager extends TypedDeckManager {constructor(options={}){super({decksDir:fileURLToPath(new URL('../../config/decks',import.meta.url)),logger:globalThis.logger,...options})}}
export const deckManager=new DeckManager()
