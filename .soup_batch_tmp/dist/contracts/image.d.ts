/** Provider identity is carried separately from user-visible channel labels. */
export interface ImageCandidateIdentity {
    providerId?: string;
    model?: string;
    name?: string;
}
export interface ImageAttempt {
    provider: string;
    providerId: string;
    model: string;
    ok: boolean;
    ms: number;
    error?: string;
}
export type ImageCandidateResponse<T> = {
    ok: true;
    value: T;
} | {
    ok: false;
    errorMessage: string;
};
export interface ImageExecutionResult<T> {
    value: T;
    provider: string;
    attempts: ImageAttempt[];
}
export interface ImageCandidatePorts<C, T> {
    describe(candidate: C, index: number): string;
    identity(candidate: C): {
        providerId: string;
        model: string;
    };
    request(candidate: C, responseFormat: 'b64_json' | ''): Promise<ImageCandidateResponse<T>>;
    retryWithoutFormat(message: string): boolean;
    failureMessage(attempts: readonly ImageAttempt[]): string;
    now(): number;
    signal?: AbortSignal;
    onFormatFallback?(label: string): void;
    onCandidateFailure?(attempt: ImageAttempt, hasNext: boolean): void;
    onSuccess?(label: string, index: number): void;
}
export interface ImageRequest {
    operation: 'generate' | 'edit';
    prompt: string;
    references: readonly string[];
    count: number;
    requestedProviderId?: string;
    size?: string;
    aspectRatio?: string;
    quality?: string;
}
export interface ImageResource {
    source: string;
    width: number;
    height: number;
}
export interface ImageResult {
    images: readonly ImageResource[];
    providerId: string;
    model: string;
    attempts: readonly ImageAttempt[];
}
