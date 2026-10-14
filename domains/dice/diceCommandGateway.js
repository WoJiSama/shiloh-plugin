import {startsWithMentionOfOtherMember as starts,getDiceCommandGate as gate,getCustomDiceCommandGate as custom,executeDiceCommand as execute} from '../../dist/backend/modules/dice/domain/diceCommandGateway.js'
export {canManageGroupDice,sanitizeDiceCommandError} from '../../dist/backend/modules/dice/domain/diceCommandGateway.js'
export const startsWithMentionOfOtherMember=(event={})=>starts(event,globalThis.Bot?.uin)
export const getDiceCommandGate=(input={})=>gate({...input,fallbackBotId:globalThis.Bot?.uin})
export const getCustomDiceCommandGate=(input={})=>custom({...input,fallbackBotId:globalThis.Bot?.uin})
export const executeDiceCommand=(input={})=>execute({...input,fallbackBotId:globalThis.Bot?.uin})
