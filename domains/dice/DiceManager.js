import {DiceManager as TypedDiceManager} from '../../dist/backend/modules/dice/infrastructure/DiceManager.js'
export class DiceManager extends TypedDiceManager {constructor(options={}){super({logger:globalThis.logger,bot:globalThis.Bot,...options})}}
export const diceManager=new DiceManager()
