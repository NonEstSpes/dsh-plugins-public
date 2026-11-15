/** Pair-owned bounded transfer operations over verified native SDK callbacks. */
import type { FederationSessionRef } from './grants.mjs'
import type { ProjectAuthority } from './project-journal.mjs'
import type { NativeSourceFiles } from './native-adapter.mjs'
import type { SourceFileStartRequest, SourceFileChunkRequest, SourceFileFinishRequest, SourceFileCancelRequest,
  SourceFileTransferId, SourceUploadValue, SourceFileAttachmentRequest, SourceImageAttachmentRequest, SourceFileAttachmentValue, SourcePromptUpload } from '@deepseek-ai/dsh-api-session-controller/types'
export declare const SOURCE_FILE_CHUNK_BYTES: 16384
export interface FileTransferOptions {
  readonly upload: NativeSourceFiles['upload']
  readonly attachment?: NativeSourceFiles['attachment']
  readonly image?: NativeSourceFiles['image']
  readonly timeoutMs: number
  readonly check: (ref: FederationSessionRef, authority: ProjectAuthority, direction: 'upload' | 'download') => void
}
export interface FileTransfers {
  start(ref: FederationSessionRef, request: SourceFileStartRequest, authority: ProjectAuthority): Promise<{ readonly transferId: SourceFileTransferId }>
  chunk(ref: FederationSessionRef, request: SourceFileChunkRequest, authority: ProjectAuthority): Promise<{ readonly nextIndex: number }>
  finish(ref: FederationSessionRef, request: SourceFileFinishRequest, authority: ProjectAuthority): Promise<SourceUploadValue>
  cancel(ref: FederationSessionRef, request: SourceFileCancelRequest, authority: ProjectAuthority): Promise<{ readonly cancelled: true }>
  attachment(ref: FederationSessionRef, request: SourceFileAttachmentRequest, authority: ProjectAuthority): Promise<SourceFileAttachmentValue>
  image(ref: FederationSessionRef, request: SourceImageAttachmentRequest, authority: ProjectAuthority): Promise<SourceFileAttachmentValue>
  owned(ref: FederationSessionRef, uploads: readonly SourcePromptUpload[], authority: ProjectAuthority): readonly SourcePromptUpload[]
  retire(authority: Readonly<{ generation: number; grantRevision: number | null }> | null): void
  close(): Promise<void>
}
/** @param options Native callbacks, current pair authority and the explicitly resolved pair request deadline. @returns One-credit uploads and integrity-checked attachment readers; no Session mutation or full-file buffering. */
export declare function createFileTransfers(options: FileTransferOptions): FileTransfers
