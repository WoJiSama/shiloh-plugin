export interface CardBase {
    userId?: unknown;
    model: string;
    screenData: Record<string, unknown>;
}
export type CardBaseConstructor = new (event?: unknown) => CardBase;
export interface CardRenderer {
    browserInit?(): Promise<unknown>;
    screenshot(template: string, data: Record<string, unknown>, mode: number): Promise<unknown>;
}
export interface MediaPluginBase {
    name?: string;
}
export type MediaPluginConstructor = new (options: Record<string, unknown>) => MediaPluginBase;
export interface MediaCommandEvent {
    msg: string;
    reply(message: unknown): Promise<unknown>;
}
