import type { TurtleSoupHost } from '../../../../contracts/turtleSoup.js';
import type { TurtleSoupModelCall } from './TurtleSoupGenerator.js';
export interface TurtleSoupModelHostPorts {
    callModel: TurtleSoupModelCall;
    logger?: {
        warn?(message: string): void;
    };
}
export declare function createTurtleSoupModelHost(ports: TurtleSoupModelHostPorts): TurtleSoupHost;
