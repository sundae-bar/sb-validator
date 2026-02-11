// sn121-weights-service.ts
//
// High-level goal:
// ----------------
// Provide a *small, focused service* you can call after fetching weights
// from your own API, which will then submit those weights on-chain to
// Bittensor subnet 121 using the standard `setWeights` extrinsic.
//
// You should be able to:
//   1. Copy this file into your validator project.
//   2. Import `submitSn121Weights` in the place where you already fetch weights.
//   3. Call `submitSn121Weights(fetchedWeights, { validatorSecret: ... })`.
//
// This file intentionally does NOT manage intervals, loops, or fetching.
// It focuses only on: "given weights, send a single setWeights transaction".

import { ApiPromise, WsProvider } from '@polkadot/api';
import { Keyring } from '@polkadot/keyring';
import { cryptoWaitReady } from '@polkadot/util-crypto';

import logger from './logger';

// Reuse the type shape we already use in this repo for weights.
// If your project has its own type, make sure it is structurally compatible.
export interface BittensorWeightTarget {
    readonly uid: number;
    readonly weight: number;
}

// Configuration for a single submission.
// In most cases you only *need* to provide `validatorSecret`.
// The rest has reasonable defaults but can be overridden if needed.
export interface Sn121SubmitConfig {
    /**
     * WebSocket endpoint for the Bittensor (Finney) network.
     * Example: 'wss://entrypoint-finney.opentensor.ai:443'
     *
     * If omitted, a sensible default is used.
     */
    wsEndpoint?: string;

    /**
     * The subnet ID (netuid). For sn121 this should be 121.
     *
     * If omitted, we default to 121.
     */
    netuid?: number;

    /**
     * Version key for weights. Most subnets use 0 unless specified otherwise.
     *
     * If omitted, we default to 0.
     */
    versionKey?: number;

    /**
     * SS58 address format. Finney typically uses 42.
     *
     * If omitted, we default to 42.
     */
    ss58Format?: number;

    /**
     * Your validator secret, used to sign the transaction.
     *
     * This can be:
     *   - A full mnemonic phrase: "word1 word2 ... word12"
     *   - A dev URI such as "//Alice" (for testing only)
     *   - A raw seed like "0x..." that keyring understands
     *
     * IMPORTANT: Do NOT hard-code this in code for production. Read from
     * environment variables or a secure secret store instead.
     */
    validatorSecret: string;
}

// Reasonable defaults so you can call submitSn121Weights() with minimal config.
const DEFAULT_WS_ENDPOINT = 'wss://entrypoint-finney.opentensor.ai:443';
const DEFAULT_NETUID_121 = 121;
const DEFAULT_VERSION_KEY = 0;
const DEFAULT_SS58_FORMAT = 42;

/**
 * Utility: clean up and deduplicate weight targets.
 *
 * Why this exists:
 *   - On-chain expectations:
 *       * UIDs must be non-negative integers.
 *       * Weights must be non-negative numbers.
 *       * Each UID should appear at most once.
 *   - Real-world APIs sometimes:
 *       * Contain duplicates.
 *       * Contain malformed rows.
 *
 * This helper:
 *   - Drops obviously invalid entries.
 *   - Keeps only the *last* weight for each UID.
 *   - Sorts by UID for deterministic ordering.
 */
const dedupeTargets = (targets: readonly BittensorWeightTarget[]): BittensorWeightTarget[] => {
    const seen = new Map<number, number>();

    for (const { uid, weight } of targets) {
        if (!Number.isInteger(uid) || uid < 0) {
            // Skip invalid UID entries.
            continue;
        }

        if (!Number.isFinite(weight) || weight < 0) {
            // Skip invalid weight entries.
            continue;
        }

        // If a UID appears multiple times, the last one wins.
        seen.set(uid, weight);
    }

    return Array.from(seen.entries())
        .sort(([a], [b]) => a - b)
        .map(([uid, weight]) => ({ uid, weight }));
};

/**
 * Core function you will call from your validator.
 *
 * Typical usage pattern (pseudocode):
 *
 *   const response = await apiClient.fetchBittensorWeights();
 *   const weightTargets = response.weights.map(w => ({ uid: w.uid, weight: w.weight }));
 *
 *   await submitSn121Weights(weightTargets, {
 *       validatorSecret: process.env.VALIDATOR_MNEMONIC ?? '',
 *   });
 *
 * This function:
 *   1. Validates and deduplicates the weight list.
 *   2. Connects to the Bittensor network via WebSocket.
 *   3. Builds the `setWeights(netuid, uids, weights, versionKey)` extrinsic.
 *   4. Signs it with your validator key.
 *   5. Waits for it to be included and finalized.
 *   6. Logs useful information and disconnects the API.
 */
export const submitSn121Weights = async (
    rawTargets: readonly BittensorWeightTarget[],
    cfg: Sn121SubmitConfig
): Promise<void> => {
    // 1) Early exit if nothing to submit at all.
    if (!rawTargets || rawTargets.length === 0) {
        logger.info('sn121: no weights to submit (empty array)');
        return;
    }

    // 2) Clean up / normalize / deduplicate incoming targets.
    const targets = dedupeTargets(rawTargets);
    if (targets.length === 0) {
        logger.warn('sn121: no valid weights to submit after dedupe');
        return;
    }

    // 3) Resolve configuration, falling back to safe defaults where possible.
    const wsEndpoint = cfg.wsEndpoint?.trim() || DEFAULT_WS_ENDPOINT;
    const netuid = cfg.netuid ?? DEFAULT_NETUID_121;
    const versionKey = cfg.versionKey ?? DEFAULT_VERSION_KEY;
    const ss58Format = cfg.ss58Format ?? DEFAULT_SS58_FORMAT;
    const validatorSecret = cfg.validatorSecret.trim();

    if (!validatorSecret) {
        // We cannot proceed without a secret to sign the transaction.
        throw new Error('sn121: validatorSecret is empty – cannot sign setWeights');
    }

    logger.info(
        {
            wsEndpoint,
            netuid,
            versionKey,
            ss58Format,
            targetCount: targets.length
        },
        'sn121: preparing to submit bittensor weights'
    );

    // 4) Initialize cryptography and Polkadot API client.
    //
    //    cryptoWaitReady() ensures the WASM crypto backends are ready before
    //    we try to construct or use sr25519 keys.
    await cryptoWaitReady();

    const provider = new WsProvider(wsEndpoint);
    const api = await ApiPromise.create({ provider, noInitWarn: true });

    // 5) Create a keyring and derive our validator account from the secret.
    //
    //    ss58Format = 42 is standard on Finney, but you can override it if
    //    your validator uses a different format.
    const keyring = new Keyring({ type: 'sr25519', ss58Format });
    const account = keyring.addFromUri(validatorSecret);

    logger.info(
        {
            address: account.address
        },
        'sn121: using validator account for setWeights'
    );

    // 6) Split targets into the two arrays expected by the setWeights extrinsic.
    const uids = targets.map((t) => t.uid);
    const weights = targets.map((t) => t.weight);

    const sample = targets.slice(0, 5);

    logger.info(
        {
            netuid,
            count: targets.length,
            sample
        },
        'sn121: submitting bittensor weights'
    );

    // 7) Build the extrinsic:
    //
    //       setWeights(netuid, uids[], weights[], versionKey)
    //
    const extrinsic = api.tx.subtensorModule.setWeights(netuid, uids, weights, versionKey);

    // 8) Sign and send the extrinsic, and wait for it to be included and finalized.
    //
    //    We wrap this in a Promise so the caller can `await` until it's finished
    //    (or failed), and we log status along the way for debugging.
    try {
        await new Promise<void>((resolve, reject) => {
            extrinsic
                .signAndSend(account, (result: any) => {
                    const { status, dispatchError } = result;

                    if (status.isInBlock) {
                        logger.info(
                            {
                                blockHash: status.asInBlock.toHex()
                            },
                            'sn121: setWeights included in block'
                        );
                    }

                    if (status.isFinalized) {
                        logger.info(
                            {
                                blockHash: status.asFinalized.toHex()
                            },
                            'sn121: setWeights finalized'
                        );

                        if (dispatchError) {
                            // If the chain signalled an error, try to decode it nicely.
                            if (dispatchError.isModule) {
                                const meta = api.registry.findMetaError(dispatchError.asModule);
                                const { section, name, docs } = meta;

                                logger.error(
                                    {
                                        section,
                                        name,
                                        docs
                                    },
                                    'sn121: setWeights extrinsic failed'
                                );

                                reject(new Error(`${section}.${name}: ${docs.join(' ')}`));
                            } else {
                                logger.error(
                                    {
                                        error: dispatchError.toString()
                                    },
                                    'sn121: setWeights extrinsic failed (non-module error)'
                                );

                                reject(new Error(dispatchError.toString()));
                            }
                        } else {
                            // Happy path.
                            resolve();
                        }
                    }
                })
                .catch((err: unknown) => {
                    logger.error({ err }, 'sn121: failed to sign and send setWeights');
                    reject(err);
                });
        });
    } finally {
        // 9) Always disconnect the API client when we're done to avoid leaking sockets.
        try {
            await api.disconnect();
        } catch (err) {
            logger.warn({ err }, 'sn121: error while disconnecting polkadot api');
        }
    }

    logger.info('sn121: setWeights call completed successfully');
};

