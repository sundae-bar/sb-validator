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
    logger.info(
        {
            rawTargetsCount: rawTargets?.length || 0,
            hasConfig: !!cfg,
            hasValidatorSecret: !!cfg?.validatorSecret,
            validatorSecretLength: cfg?.validatorSecret?.length || 0,
        },
        'sn121: submitSn121Weights called'
    );

    // 1) Early exit if nothing to submit at all.
    if (!rawTargets || rawTargets.length === 0) {
        logger.info('sn121: no weights to submit (empty array)');
        return;
    }

    logger.debug(
        {
            rawTargetsCount: rawTargets.length,
            sampleRawTargets: rawTargets.slice(0, 5),
        },
        'sn121: raw targets received'
    );

    // 2) Clean up / normalize / deduplicate incoming targets.
    const targets = dedupeTargets(rawTargets);
    logger.debug(
        {
            beforeDedupe: rawTargets.length,
            afterDedupe: targets.length,
            removed: rawTargets.length - targets.length,
        },
        'sn121: deduplication completed'
    );

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

    logger.debug(
        {
            wsEndpoint,
            netuid,
            versionKey,
            ss58Format,
            validatorSecretLength: validatorSecret.length,
            validatorSecretPrefix: validatorSecret.substring(0, 10) + '...',
            usingDefaultWsEndpoint: !cfg.wsEndpoint,
            usingDefaultNetuid: cfg.netuid === undefined,
            usingDefaultVersionKey: cfg.versionKey === undefined,
            usingDefaultSs58Format: cfg.ss58Format === undefined,
        },
        'sn121: configuration resolved'
    );

    if (!validatorSecret) {
        // We cannot proceed without a secret to sign the transaction.
        logger.error('sn121: validatorSecret is empty – cannot sign setWeights');
        throw new Error('sn121: validatorSecret is empty – cannot sign setWeights');
    }

    // Calculate total weight sum for validation
    const totalWeight = targets.reduce((sum, t) => sum + t.weight, 0);
    const weightSumRounded = Math.round(totalWeight * 1000000) / 1000000;

    logger.info(
        {
            wsEndpoint,
            netuid,
            versionKey,
            ss58Format,
            targetCount: targets.length,
            totalWeight: weightSumRounded,
            expectedSum: 1.0,
            weightSumDifference: Math.abs(weightSumRounded - 1.0),
            targetsSample: targets.slice(0, 10),
        },
        'sn121: preparing to submit bittensor weights'
    );

    // 4) Initialize cryptography and Polkadot API client.
    //
    //    cryptoWaitReady() ensures the WASM crypto backends are ready before
    //    we try to construct or use sr25519 keys.
    logger.debug('sn121: waiting for crypto to be ready...');
    const cryptoStartTime = Date.now();
    await cryptoWaitReady();
    const cryptoReadyTime = Date.now() - cryptoStartTime;
    logger.debug(
        {
            cryptoReadyTimeMs: cryptoReadyTime,
        },
        'sn121: crypto ready'
    );

    logger.debug(
        {
            wsEndpoint,
        },
        'sn121: creating WebSocket provider...'
    );
    const providerStartTime = Date.now();
    const provider = new WsProvider(wsEndpoint);
    logger.debug(
        {
            providerCreatedTimeMs: Date.now() - providerStartTime,
        },
        'sn121: WebSocket provider created'
    );

    logger.debug('sn121: creating ApiPromise...');
    const apiStartTime = Date.now();
    // Create API with runtime definition for metagraph queries
    const api = await ApiPromise.create({
        provider,
        noInitWarn: true,
        runtime: {
            subnetInfoRuntimeApi: [
                {
                    methods: {
                        getMetagraph: {
                            description: 'Get registered validators and miners for a subnet',
                            params: [
                                {
                                    name: 'netuid',
                                    type: 'u16',
                                },
                            ],
                            type: 'Json',
                        },
                    },
                    version: 1,
                },
            ],
        },
    });
    const apiReadyTime = Date.now() - apiStartTime;
    logger.info(
        {
            apiReadyTimeMs: apiReadyTime,
            chainName: api.runtimeChain?.toString() || 'unknown',
            runtimeVersion: api.runtimeVersion?.toString() || 'unknown',
        },
        'sn121: ApiPromise created and connected'
    );

    // 5) Create a keyring and derive our validator account from the secret.
    //
    //    ss58Format = 42 is standard on Finney, but you can override it if
    //    your validator uses a different format.
    logger.debug(
        {
            keyringType: 'sr25519',
            ss58Format,
        },
        'sn121: creating keyring...'
    );
    const keyringStartTime = Date.now();
    const keyring = new Keyring({ type: 'sr25519', ss58Format });
    logger.debug(
        {
            keyringCreatedTimeMs: Date.now() - keyringStartTime,
        },
        'sn121: keyring created'
    );

    logger.debug(
        {
            validatorSecretPrefix: validatorSecret.substring(0, 10) + '...',
            validatorSecretLength: validatorSecret.length,
        },
        'sn121: adding account from secret...'
    );
    const accountStartTime = Date.now();
    const account = keyring.addFromUri(validatorSecret);
    const accountCreatedTime = Date.now() - accountStartTime;
    logger.info(
        {
            address: account.address,
            accountCreatedTimeMs: accountCreatedTime,
            addressLength: account.address.length,
        },
        'sn121: using validator account for setWeights'
    );

    // 5.5) Verify that the account is actually a registered validator on the subnet
    logger.debug(
        {
            netuid,
            accountAddress: account.address,
        },
        'sn121: verifying account is a registered validator on subnet...'
    );
    const validationStartTime = Date.now();
    try {
        // Query the metagraph using runtime API to check if this account is a validator
        // In Bittensor, we can check the validatorPermit array for the subnet
        logger.debug('sn121: fetching metagraph via runtime API...');
        const metagraphResult = await api.call.subnetInfoRuntimeApi.getMetagraph(netuid);
        const metagraphData = metagraphResult.toHuman() as any;

        if (!metagraphData) {
            logger.warn(
                {
                    netuid,
                    accountAddress: account.address,
                },
                'sn121: could not fetch metagraph data (proceeding anyway - network will reject if invalid)'
            );
        } else {
            const hotkeys = metagraphData.hotkeys || [];
            const validatorPermits = metagraphData.validatorPermit || [];
            const totalValidators = validatorPermits.filter((p: any) => p === true).length;

            logger.debug(
                {
                    netuid,
                    totalHotkeys: hotkeys.length,
                    totalValidators,
                    hasValidatorPermits: !!validatorPermits,
                    validatorPermitsLength: validatorPermits.length,
                },
                'sn121: metagraph data fetched'
            );

            const accountIndex = hotkeys.indexOf(account.address);

            if (accountIndex === -1) {
                logger.error(
                    {
                        netuid,
                        accountAddress: account.address,
                        totalHotkeys: hotkeys.length,
                        totalValidators,
                    },
                    'sn121: account is not registered on subnet (not found in metagraph hotkeys)'
                );
                throw new Error(
                    `Account ${account.address} is not registered on subnet ${netuid}. Cannot submit weights.`
                );
            }

            const isValidator = validatorPermits[accountIndex] === true;
            if (!isValidator) {
                logger.error(
                    {
                        netuid,
                        accountAddress: account.address,
                        accountIndex,
                        isValidator,
                        validatorPermit: validatorPermits[accountIndex],
                        totalValidators,
                    },
                    'sn121: account is registered but does not have validator permit'
                );
                throw new Error(
                    `Account ${account.address} is registered on subnet ${netuid} (UID: ${accountIndex}) but does not have validator permit. Cannot submit weights.`
                );
            }

            const validationTime = Date.now() - validationStartTime;
            logger.info(
                {
                    netuid,
                    accountAddress: account.address,
                    accountIndex,
                    uid: accountIndex,
                    isValidator,
                    validationTimeMs: validationTime,
                    totalValidators,
                },
                'sn121: verified account is a registered validator on subnet'
            );
        }
    } catch (error) {
        const validationTime = Date.now() - validationStartTime;
        // If it's our custom error, re-throw it
        if (error instanceof Error && (error.message.includes('not registered') || error.message.includes('validator permit'))) {
            logger.error(
                {
                    error: error.message,
                    validationTimeMs: validationTime,
                },
                'sn121: validator validation failed'
            );
            throw error;
        }
        // Otherwise, log warning but proceed (network will reject if invalid)
        logger.warn(
            {
                error: error instanceof Error ? error.message : String(error),
                validationTimeMs: validationTime,
            },
            'sn121: could not verify validator status (proceeding anyway - network will reject if invalid)'
        );
    }

    // 6) Split targets into the two arrays expected by the setWeights extrinsic.
    // Bittensor expects u16 integers for weights, typically normalized to sum to 10000.
    // We'll convert floating point weights (0.0-1.0) to u16 integers (0-65535).
    const uids = targets.map((t) => t.uid);
    
    // Convert floating point weights to u16 integers
    // Use a scale factor of 10000 (common in Bittensor) to maintain precision
    // while keeping values within u16 range (0-65535)
    const SCALE_FACTOR = 10000;
    const floatWeights = targets.map((t) => t.weight);
    const totalFloatWeight = floatWeights.reduce((sum, w) => sum + w, 0);
    
    // Convert to integers, ensuring they sum to SCALE_FACTOR
    let weights: number[] = [];
    let totalIntWeight = 0;
    
    // First pass: convert to integers (rounding)
    for (let i = 0; i < floatWeights.length; i++) {
        const intWeight = Math.round(floatWeights[i] * SCALE_FACTOR);
        weights.push(intWeight);
        totalIntWeight += intWeight;
    }
    
    // Adjust to ensure exact sum (handle rounding errors)
    const difference = SCALE_FACTOR - totalIntWeight;
    if (difference !== 0 && weights.length > 0) {
        // Add/subtract the difference from the largest weight to maintain relative proportions
        const maxIndex = weights.indexOf(Math.max(...weights));
        weights[maxIndex] += difference;
        totalIntWeight = SCALE_FACTOR;
    }
    
    // Validate all weights are within u16 range (0-65535)
    for (let i = 0; i < weights.length; i++) {
        if (weights[i] < 0 || weights[i] > 65535) {
            logger.error(
                {
                    index: i,
                    weight: weights[i],
                    uid: uids[i],
                    floatWeight: floatWeights[i],
                },
                'sn121: weight out of u16 range after conversion'
            );
            throw new Error(
                `Weight ${weights[i]} for UID ${uids[i]} is out of u16 range (0-65535)`
            );
        }
    }

    logger.debug(
        {
            uidsCount: uids.length,
            weightsCount: weights.length,
            uidsSample: uids.slice(0, 10),
            weightsSample: weights.slice(0, 10),
            floatWeightsSample: floatWeights.slice(0, 10),
            minUid: Math.min(...uids),
            maxUid: Math.max(...uids),
            minWeight: Math.min(...weights),
            maxWeight: Math.max(...weights),
            totalFloatWeight: Math.round(totalFloatWeight * 1000000) / 1000000,
            totalIntWeight,
            expectedSum: SCALE_FACTOR,
            difference: SCALE_FACTOR - totalIntWeight,
        },
        'sn121: prepared uids and weights arrays (converted to u16 integers)'
    );

    const sample = targets.slice(0, 5);

    logger.info(
        {
            netuid,
            count: targets.length,
            sample,
            totalFloatWeight: Math.round(totalFloatWeight * 1000000) / 1000000,
            totalIntWeight: weights.reduce((a, b) => a + b, 0),
            expectedIntSum: SCALE_FACTOR,
        },
        'sn121: submitting bittensor weights'
    );

    // 7) Build the extrinsic:
    //
    //       setWeights(netuid, uids[], weights[], versionKey)
    //
    logger.debug(
        {
            netuid,
            uidsLength: uids.length,
            weightsLength: weights.length,
            versionKey,
        },
        'sn121: building setWeights extrinsic...'
    );
    const extrinsicStartTime = Date.now();
    const extrinsic = api.tx.subtensorModule.setWeights(netuid, uids, weights, versionKey);
    const extrinsicBuiltTime = Date.now() - extrinsicStartTime;
    logger.debug(
        {
            extrinsicBuiltTimeMs: extrinsicBuiltTime,
            method: extrinsic.method.method,
            section: extrinsic.method.section,
        },
        'sn121: setWeights extrinsic built'
    );

    // 8) Sign and send the extrinsic, and wait for it to be included and finalized.
    //
    //    We wrap this in a Promise so the caller can `await` until it's finished
    //    (or failed), and we log status along the way for debugging.
    logger.info(
        {
            accountAddress: account.address,
            netuid,
            uidsCount: uids.length,
        },
        'sn121: signing and sending setWeights extrinsic...'
    );
    const submissionStartTime = Date.now();
    let inBlockTime: number | null = null;
    let finalizedTime: number | null = null;

    try {
        await new Promise<void>((resolve, reject) => {
            extrinsic
                .signAndSend(account, (result: any) => {
                    const { status, dispatchError, events } = result;

                    logger.debug(
                        {
                            statusType: status.type,
                            isInBlock: status.isInBlock,
                            isFinalized: status.isFinalized,
                            isReady: status.isReady,
                            isBroadcast: status.isBroadcast,
                            hasDispatchError: !!dispatchError,
                            eventsCount: events?.length || 0,
                        },
                        'sn121: setWeights status update'
                    );

                    if (status.isInBlock) {
                        inBlockTime = Date.now() - submissionStartTime;
                        const blockHash = status.asInBlock.toHex();
                        logger.info(
                            {
                                blockHash,
                                inBlockTimeMs: inBlockTime,
                                eventsCount: events?.length || 0,
                            },
                            'sn121: setWeights included in block'
                        );

                        // Log events if available
                        if (events && events.length > 0) {
                            logger.debug(
                                {
                                    events: events.map((e: any) => ({
                                        phase: e.phase?.toString(),
                                        event: e.event?.toString(),
                                        data: e.event?.data?.toString(),
                                    })),
                                },
                                'sn121: events in block'
                            );
                        }
                    }

                    if (status.isFinalized) {
                        finalizedTime = Date.now() - submissionStartTime;
                        const blockHash = status.asFinalized.toHex();
                        logger.info(
                            {
                                blockHash,
                                finalizedTimeMs: finalizedTime,
                                inBlockTimeMs: inBlockTime,
                                totalTimeMs: finalizedTime,
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
                                        docs,
                                        blockHash,
                                        finalizedTimeMs: finalizedTime,
                                    },
                                    'sn121: setWeights extrinsic failed'
                                );

                                reject(new Error(`${section}.${name}: ${docs.join(' ')}`));
                            } else {
                                logger.error(
                                    {
                                        error: dispatchError.toString(),
                                        blockHash,
                                        finalizedTimeMs: finalizedTime,
                                    },
                                    'sn121: setWeights extrinsic failed (non-module error)'
                                );

                                reject(new Error(dispatchError.toString()));
                            }
                        } else {
                            // Happy path.
                            logger.info(
                                {
                                    blockHash,
                                    totalTimeMs: finalizedTime,
                                    inBlockTimeMs: inBlockTime,
                                },
                                'sn121: setWeights transaction successful'
                            );
                            resolve();
                        }
                    }
                })
                .catch((err: unknown) => {
                    const errorTime = Date.now() - submissionStartTime;
                    logger.error(
                        {
                            err,
                            errorTimeMs: errorTime,
                            errorMessage: err instanceof Error ? err.message : String(err),
                            errorStack: err instanceof Error ? err.stack : undefined,
                        },
                        'sn121: failed to sign and send setWeights'
                    );
                    reject(err);
                });
        });
    } catch (error) {
        const errorTime = Date.now() - submissionStartTime;
        logger.error(
            {
                error: error instanceof Error ? error.message : String(error),
                errorStack: error instanceof Error ? error.stack : undefined,
                errorTimeMs: errorTime,
            },
            'sn121: setWeights submission failed with exception'
        );
        throw error;
    } finally {
        // 9) Always disconnect the API client when we're done to avoid leaking sockets.
        logger.debug('sn121: disconnecting ApiPromise...');
        const disconnectStartTime = Date.now();
        try {
            await api.disconnect();
            const disconnectTime = Date.now() - disconnectStartTime;
            logger.debug(
                {
                    disconnectTimeMs: disconnectTime,
                },
                'sn121: ApiPromise disconnected'
            );
        } catch (err) {
            logger.warn(
                {
                    err,
                    errorMessage: err instanceof Error ? err.message : String(err),
                },
                'sn121: error while disconnecting polkadot api'
            );
        }
    }

    const totalTime = Date.now() - submissionStartTime;
    logger.info(
        {
            totalTimeMs: totalTime,
            targetsCount: targets.length,
            netuid,
        },
        'sn121: setWeights call completed successfully'
    );
};

