/**
 * Signature utilities for signing requests with hotkey
 */

import { Keyring } from '@polkadot/api';
import type { KeyringPair } from '@polkadot/keyring/types';
import { cryptoWaitReady } from '@polkadot/util-crypto';
import { u8aToHex, stringToU8a } from '@polkadot/util';
import logger from './logger';

let cryptoInitialized = false;

/**
 * Initialize crypto subsystem
 */
export async function initializeCrypto(): Promise<void> {
  if (!cryptoInitialized) {
    await cryptoWaitReady();
    cryptoInitialized = true;
    logger.debug('Crypto subsystem initialized');
  }
}

/**
 * Create key pair from mnemonic
 */
export async function createKeyPair(mnemonic: string): Promise<KeyringPair> {
  await initializeCrypto();
  
  if (!mnemonic || mnemonic.trim().length === 0) {
    throw new Error('Mnemonic is required and cannot be empty');
  }

  try {
    const keyring = new Keyring({ type: 'sr25519' });
    const pair = keyring.addFromMnemonic(mnemonic.trim());
    return pair;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error({ error: errorMessage }, 'Failed to create key pair from mnemonic');
    
    // Provide helpful error message
    if (errorMessage.includes('Invalid bip39 mnemonic')) {
      throw new Error(
        `Invalid mnemonic: ${errorMessage}\n` +
        `Please generate a valid mnemonic using: cd ../sn121 && npm run generate-keys\n` +
        `Or use a valid 12-word BIP39 mnemonic phrase.`
      );
    }
    
    throw new Error(`Invalid mnemonic: ${errorMessage}`);
  }
}

/**
 * Get hotkey (public key) from key pair
 */
export function getHotkey(pair: KeyringPair): string {
  return u8aToHex(pair.publicKey);
}

/**
 * Sign a payload with the key pair
 */
export function signPayload(pair: KeyringPair, payload: object | string): string {
  try {
    const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const payloadBytes = stringToU8a(payloadStr);
    const signature = pair.sign(payloadBytes);
    return u8aToHex(signature);
  } catch (error) {
    logger.error({ error }, 'Failed to sign payload');
    throw new Error(`Signature failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Sign a request payload and return signature
 */
export function signRequest(pair: KeyringPair, payload: object): string {
  // Remove signature fields if present
  const { signature, signed_payload, ...cleanPayload } = payload as any;
  return signPayload(pair, cleanPayload);
}

