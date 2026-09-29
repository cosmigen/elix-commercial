/**
 * Native File Identity adapter backed by the Rust Native Core.
 *
 * Implements the FileIdentityAdapter contract using native Windows FILE_ID_INFO
 * (volume serial + 128-bit file ID) over the typed bridge.
 *
 * @module @deepseek-ai/dsh-native-core/adapters/identity
 */

import type { Stats, BigIntStats } from 'node:fs'
import type { FileIdentity } from '../types.ts'
import type { NativeBridgeClient } from '../client.ts'

export interface FileIdentityAdapter {
  identify(filePath: string, statObj?: Stats | BigIntStats): Promise<FileIdentity>
}

/**
 * File identity adapter delegating to Rust Native Core.
 */
export class NativeFileIdentityAdapter implements FileIdentityAdapter {
  private readonly client: NativeBridgeClient

  constructor(client: NativeBridgeClient) {
    this.client = client
  }

  async identify(filePath: string, _statObj?: Stats | BigIntStats): Promise<FileIdentity> {
    return this.client.files.identify(filePath)
  }
}
