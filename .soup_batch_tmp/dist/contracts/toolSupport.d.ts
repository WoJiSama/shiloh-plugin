export interface ExtractionPorts {
    pdfParse(buffer: Buffer): Promise<{
        text: string;
    }>;
    textract: {
        fromBufferWithMime(mime: string, buffer: Buffer, options: {
            preserveLineBreaks: boolean;
            typeOverride: Record<string, (type: unknown) => string>;
        }, callback: (error: unknown, text: string) => void): void;
    };
    logger: {
        error(message: string, error: unknown): void;
    };
}
export interface FileSegment {
    type?: string;
    url?: string;
    fid?: string;
}
export interface SourceMessage {
    message: FileSegment[];
}
export interface FilePeer {
    getChatHistory?(id: unknown, count: number): Promise<SourceMessage[]>;
    getFileUrl?(fid: string | undefined): Promise<string> | string;
}
export interface FileEvent {
    group_id?: string | number;
    getReply?(): Promise<SourceMessage | null>;
    source?: {
        seq?: unknown;
        time?: unknown;
    };
    group?: FilePeer;
    friend?: FilePeer;
    message?: FileSegment[];
}
export interface DownloadPorts {
    get(url: string): Promise<{
        status: number;
        headers: Record<string, string | undefined>;
        data: Uint8Array;
    }>;
    lookup(name: string): string | false;
    logger: {
        error(message: string, error: unknown): void;
    };
}
