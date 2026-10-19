import type { UmaEvent } from '../../../../contracts/uma.js';
import type { createUmaRaceManager } from './UmaRaceManager.js';
import type { MediaPluginConstructor } from '../../../../contracts/mediaCards.js';
import type { createSmartReply } from '../../../conversation/application/smartReply.js';
type UmaRaceManager = InstanceType<ReturnType<typeof createUmaRaceManager>['UmaRaceManager']>;
type AppEvent = UmaEvent & {
    reply(message: unknown): Promise<unknown>;
};
type ReplySender = ReturnType<typeof createSmartReply>['sendSmartReply'];
export declare function createUmaRacePlugin(plugin: MediaPluginConstructor, ports: {
    umaRaceManager: UmaRaceManager;
    sendSmartReply: ReplySender;
}): {
    new (): {
        reply(e: AppEvent, output: unknown, options?: Parameters<ReplySender>[2]): Promise<unknown>;
        showHelp(e: AppEvent): Promise<boolean>;
        startRace(e: AppEvent): Promise<boolean>;
        adoptUma(e: AppEvent): Promise<boolean>;
        readoptUma(e: AppEvent): Promise<boolean>;
        abandonUma(e: AppEvent): Promise<boolean>;
        showUma(e: AppEvent): Promise<boolean>;
        showAffix(e: AppEvent): Promise<boolean>;
        rerollAffix(e: AppEvent): Promise<boolean>;
        showAffixPool(e: AppEvent): Promise<boolean>;
        trainUma(e: AppEvent): Promise<boolean>;
        showTrainingStatus(e: AppEvent): Promise<boolean>;
        joinRace(e: AppEvent): Promise<boolean>;
        raceDecision(e: AppEvent): Promise<boolean>;
        runRace(e: AppEvent): Promise<boolean>;
        cancelRace(e: AppEvent): Promise<boolean>;
        showScore(e: AppEvent): Promise<boolean>;
        adjustScore(e: AppEvent): Promise<boolean>;
        showRank(e: AppEvent): Promise<boolean>;
        name?: string;
    };
};
export {};
