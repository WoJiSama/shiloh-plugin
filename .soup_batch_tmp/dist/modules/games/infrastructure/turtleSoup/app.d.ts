import type { TurtleSoupEvent } from '../../../../contracts/turtleSoup.js';
type AppEvent = TurtleSoupEvent & {
    reply(message: unknown): Promise<unknown>;
};
import type { MediaPluginConstructor } from '../../../../contracts/mediaCards.js';
import type { createSmartReply } from '../../../conversation/application/smartReply.js';
import type { TurtleSoupManager } from './TurtleSoupManager.js';
type ReplySender = ReturnType<typeof createSmartReply>['sendSmartReply'];
export declare function createTurtleSoupPlugin(plugin: MediaPluginConstructor, ports: {
    turtleSoupManager: TurtleSoupManager;
    sendSmartReply: ReplySender;
}): {
    new (): {
        reply(e: AppEvent, output: unknown, options?: Parameters<ReplySender>[2]): Promise<unknown>;
        showHub(e: AppEvent): Promise<boolean>;
        showHelp(e: AppEvent): Promise<boolean>;
        openGame(e: AppEvent): Promise<boolean>;
        joinGame(e: AppEvent): Promise<boolean>;
        startGame(e: AppEvent): Promise<boolean>;
        choosePuzzle(e: AppEvent): Promise<boolean>;
        cancelGame(e: AppEvent): Promise<boolean>;
        guessSoup(e: AppEvent): Promise<boolean>;
        surrender(e: AppEvent): Promise<boolean>;
        useHint(e: AppEvent): Promise<boolean>;
        showStatus(e: AppEvent): Promise<boolean>;
        endGame(e: AppEvent): Promise<boolean>;
        rateGame(e: AppEvent): Promise<boolean>;
        inventory(e: AppEvent): Promise<boolean>;
        generateMore(e: AppEvent): Promise<boolean>;
        switchPuzzleCmd(e: AppEvent): Promise<boolean>;
        rankingsCmd(e: AppEvent): Promise<boolean>;
        listPendingCmd(e: AppEvent): Promise<boolean>;
        approvePuzzleCmd(e: AppEvent): Promise<boolean>;
        rejectPuzzleCmd(e: AppEvent): Promise<boolean>;
        handleChat(e: AppEvent): Promise<boolean>;
        name?: string;
    };
};
export {};
