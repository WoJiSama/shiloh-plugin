import type { ImageAttempt } from './image.js'
export type ImageValue = string | Uint8Array
export interface ImageServiceCandidate { apiUrl: string; apiKey?: string; model: string; name?: string; providerId?: string; size?: string; aspectRatio?: string; quality?: string; [key: string]: unknown }
export interface ImageServiceRequest { operation: 'generate' | 'edit'; prompt: string; images?: readonly string[]; count?: number; quality?: string; signal?: AbortSignal }
export interface ImageServiceResult { images: ImageValue[]; format: string; provider: string; attempts: ImageAttempt[] }
export interface ImageServicePorts {
 fetch: typeof fetch
 loadReference(url: string, signal?: AbortSignal): Promise<string>
 encodeMultipart(fields: Record<string, string>, files: { data: Uint8Array; mimeType: string; filename: string }[]): Promise<{ headers: Record<string,string>; body: BodyInit }>
 resolveImage(image: ImageValue, signal?: AbortSignal): Promise<Uint8Array>
 metadata(bytes: Uint8Array): Promise<{ width: number; height: number }>
 logInfo?(message: string): void; logWarn?(message: string): void
}
