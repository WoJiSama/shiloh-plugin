export interface RenderLogger {
    info?(message: string): void;
    warn?(message: string): void;
}
export interface RenderPage {
    setViewport(options: {
        width: number;
        height: number;
        deviceScaleFactor: number;
    }): Promise<void>;
    goto(url: string, options: {
        waitUntil: 'load';
        timeout: number;
    }): Promise<unknown>;
    evaluate<T>(callback: () => T): Promise<Awaited<T>>;
    screenshot(options: {
        path: string;
        clip: {
            x: number;
            y: number;
            width: number;
            height: number;
        };
        type: 'png';
        omitBackground?: boolean;
    }): Promise<unknown>;
    close(): Promise<void>;
}
export interface TextImageEvent {
    reply(value: unknown): Promise<unknown>;
}
export interface TextImagePorts {
    guardText(text: string, event: TextImageEvent): string;
    image(path: string): unknown;
    getSharedBrowser(): Promise<{
        newPage(): Promise<RenderPage>;
    }>;
    scheduleSharedBrowserClose(): void;
    logger?: RenderLogger | undefined;
}
export interface MathToken {
    tex: string;
    display: boolean;
    raw: string;
    html?: string;
}
export interface CodeToken {
    text: string;
    type: string;
}
export interface TextBlockOptions {
    fontSize?: number;
    maxUnits?: number;
    lineHeight?: number;
    fill?: string;
    fontWeight?: string;
    prefix?: string;
}
export interface TextBlock {
    type: 'paragraph' | 'heading' | 'quote' | 'list';
    text: string;
    lines: string[];
    fontSize: number;
    lineHeight: number;
    fill: string;
    fontWeight: string;
    prefix: string;
    height: number;
}
export interface CodeBlock {
    type: 'code';
    language: string;
    lines: string[];
    fontSize: number;
    lineHeight: number;
    labelHeight: number;
    height: number;
}
export interface SpacerBlock {
    type: 'spacer';
    height: number;
    lines: string[];
}
export type RenderBlock = TextBlock | CodeBlock | SpacerBlock;
export interface PreviewPage extends RenderPage {
    setDefaultTimeout(timeout: number): void;
    setContent(content: string, options: {
        waitUntil: ('networkidle0' | 'domcontentloaded')[];
        timeout?: number;
    }): Promise<void>;
    waitForSelector(selector: string, options: {
        timeout: number;
    }): Promise<unknown>;
}
export interface PreviewBrowser {
    newPage(): Promise<PreviewPage>;
    pages(): Promise<PreviewPage[]>;
    close(): Promise<void>;
}
export interface PreviewPorts {
    launch(options: {
        headless: 'new' | boolean;
        userDataDir: string;
        args: string[];
    }): Promise<PreviewBrowser>;
}
export interface PreviewOptions {
    outputDir?: string;
    timeout?: number;
    imageTimeout?: number;
    additionalScripts?: string[];
    additionalStyles?: string[];
    backendLanguages?: string[];
    frontendLanguages?: string[];
    puppeteerUserDataDir?: string;
}
export interface PreviewCodeBlock {
    language: string;
    code: string;
}
export interface PreviewRenderOptions {
    outputPath: string;
    timeout: number;
    additionalScripts: string[];
    additionalStyles: string[];
}
export interface PreviewResult {
    index: number | string;
    type: 'image' | 'code';
    url?: string;
    language?: string;
    outputPath: string;
    metadata: Record<string, unknown>;
}
