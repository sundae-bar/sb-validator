/**
 * Submission payment verification.
 *
 * Every submission pays a TAO fee: a plain balance transfer from the
 * submitting wallet to the subnet fee wallet. The coordinator passes the
 * expected payer, destination, amount and the transaction + block hashes in
 * the task metadata. Before spending any evaluator time, the validator checks
 * the transfer on chain.
 *
 * Split in two so the rules are testable without a chain:
 *   - `judgeTransfer` is pure: observed transfer + expectation -> verdict.
 *   - `verifyTaskPayment` reads the chain and feeds `judgeTransfer`.
 *
 * Replay is the coordinator's job: it stores each transaction hash on exactly
 * one submission, forever, so a hash cannot pay twice even if the submission
 * it first paid for fails.
 */

import { ApiPromise, WsProvider } from '@polkadot/api';
import type { EventRecord } from '@polkadot/types/interfaces';
import { cryptoWaitReady, decodeAddress, encodeAddress } from '@polkadot/util-crypto';

import logger from './logger';
import {
  CHAIN_CONNECT_TIMEOUT_MS,
  CHAIN_DISCONNECT_TIMEOUT_MS,
  CHAIN_READ_TIMEOUT_MS,
  resolveWsEndpoints,
  withDeadline,
} from './weights';

/** Payment block of `task_payload.metadata`, as sent by the coordinator. */
export interface TaskPayment {
  tx_hash: string;
  block_hash: string | null;
  payer: string | null;
  destination: string | null;
  /** Minimum amount in RAO, as a decimal string (u128 does not fit a JSON number). */
  amount_rao: string;
}

/** What the chain says about the extrinsic. */
export interface ObservedTransfer {
  /** The block hash exists on the canonical chain at its height. */
  canonical: boolean;
  /** The extrinsic with the claimed hash exists in that block. */
  found: boolean;
  /** ExtrinsicSuccess was emitted for it. */
  success: boolean;
  /** `section.method` of the call, e.g. `balances.transferKeepAlive`. */
  call: string;
  signer: string | null;
  destination: string | null;
  amountRao: bigint | null;
}

export type PaymentVerdict = { ok: true } | { ok: false; message: string };

const SS58_PREFIX = 42;

/** Plain balance transfers. Anything else (batches, proxies) is not accepted. */
export const ACCEPTED_TRANSFER_CALLS: ReadonlySet<string> = new Set([
  'balances.transferKeepAlive',
  'balances.transferAllowDeath',
  'balances.transfer',
]);

export const normalizeAddress = (address: string | null | undefined): string | null => {
  if (!address) {
    return null;
  }
  try {
    return encodeAddress(decodeAddress(address), SS58_PREFIX);
  } catch {
    return null;
  }
};

/** Parse the task's payment block; null when it is absent or unusable. */
export const parseTaskPayment = (metadata: unknown): TaskPayment | null => {
  const raw = (metadata as { payment?: unknown } | null | undefined)?.payment;
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const p = raw as Record<string, unknown>;
  if (typeof p.tx_hash !== 'string' || p.tx_hash === '') {
    return null;
  }
  return {
    tx_hash: p.tx_hash,
    block_hash: typeof p.block_hash === 'string' ? p.block_hash : null,
    payer: typeof p.payer === 'string' ? p.payer : null,
    destination: typeof p.destination === 'string' ? p.destination : null,
    amount_rao: typeof p.amount_rao === 'string' ? p.amount_rao : String(p.amount_rao ?? '0'),
  };
};

/** Apply the payment rules to what the chain returned. */
export const judgeTransfer = (
  observed: ObservedTransfer,
  expected: TaskPayment,
): PaymentVerdict => {
  if (!observed.canonical) {
    return { ok: false, message: 'Payment block is not part of the canonical chain' };
  }
  if (!observed.found) {
    return { ok: false, message: 'Payment transaction not found in the stated block' };
  }
  if (!observed.success) {
    return { ok: false, message: 'Payment transaction failed on chain' };
  }
  if (!ACCEPTED_TRANSFER_CALLS.has(observed.call)) {
    return { ok: false, message: `Payment is not a plain TAO transfer (${observed.call})` };
  }

  const expectedPayer = normalizeAddress(expected.payer);
  const expectedDestination = normalizeAddress(expected.destination);
  if (!expectedPayer || !expectedDestination) {
    return { ok: false, message: 'Task carries no valid payer or destination address' };
  }

  if (normalizeAddress(observed.signer) !== expectedPayer) {
    return { ok: false, message: 'Payment was not sent from the submitting wallet' };
  }
  if (normalizeAddress(observed.destination) !== expectedDestination) {
    return { ok: false, message: 'Payment was not sent to the subnet fee wallet' };
  }

  let required: bigint;
  try {
    required = BigInt(expected.amount_rao);
  } catch {
    return { ok: false, message: 'Task carries an invalid payment amount' };
  }
  if (required <= 0n) {
    return { ok: false, message: 'Task carries a non-positive payment amount' };
  }
  if (observed.amountRao === null || observed.amountRao < required) {
    return {
      ok: false,
      message: `Payment amount ${observed.amountRao?.toString() ?? 'unknown'} RAO is below the required ${required.toString()} RAO`,
    };
  }

  return { ok: true };
};

/** Thrown when the chain cannot be read; the payment itself is not judged. */
export class PaymentUnverifiableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentUnverifiableError';
  }
}

/**
 * A node that keeps full state. Reading the events of a block needs that
 * block's state, and a pruning node discards it after a few hundred blocks
 * (about an hour), so a payment made while the task queue was deep cannot be
 * read from such a node. The archive node is always tried last.
 */
const ARCHIVE_WS_ENDPOINT = 'wss://archive.chain.opentensor.ai:443';

/**
 * Endpoints the payment check reads from, in order: `PAYMENT_WS_ENDPOINTS`
 * when set, otherwise the weight-setting endpoints, with the archive node
 * appended when it is not already listed.
 */
export const resolvePaymentWsEndpoints = (): string[] => {
  const override = process.env.PAYMENT_WS_ENDPOINTS?.trim();
  const list = override ? resolveWsEndpoints(override) : resolveWsEndpoints();
  return list.includes(ARCHIVE_WS_ENDPOINT) ? list : [...list, ARCHIVE_WS_ENDPOINT];
};

const connect = async (endpoint: string): Promise<ApiPromise> => {
  await cryptoWaitReady();
  const provider = new WsProvider(endpoint);
  try {
    return await withDeadline(
      ApiPromise.create({ provider, throwOnConnect: true, noInitWarn: true }),
      CHAIN_CONNECT_TIMEOUT_MS,
      `connect to ${endpoint}`,
    );
  } catch (error) {
    await withDeadline(provider.disconnect(), CHAIN_DISCONNECT_TIMEOUT_MS, 'disconnect').catch(
      () => undefined,
    );
    throw error;
  }
};

const addressOf = (arg: unknown): string | null => {
  const a = arg as
    { isId?: boolean; asId?: { toString(): string }; toString(): string } | undefined;
  if (!a) {
    return null;
  }
  return a.isId && a.asId ? a.asId.toString() : a.toString();
};

/**
 * Read the claimed extrinsic from the chain.
 *
 * The coordinator only accepts a submission whose payment block is already
 * finalized, so there is nothing to wait for here. A node that does not know
 * the block, or has not finalized it yet, is behind the coordinator's view:
 * that throws `PaymentUnverifiableError` so the task fails as an
 * infrastructure problem, not as a bad payment. Only a finalized block whose
 * hash is not the canonical one at its height is judged non-canonical.
 */
export const fetchObservedTransfer = async (
  api: ApiPromise,
  payment: TaskPayment,
): Promise<ObservedTransfer> => {
  const blockHash = payment.block_hash as string;
  const none: ObservedTransfer = {
    canonical: false,
    found: false,
    success: false,
    call: '',
    signer: null,
    destination: null,
    amountRao: null,
  };

  let header;
  try {
    header = await withDeadline(
      api.rpc.chain.getHeader(blockHash),
      CHAIN_READ_TIMEOUT_MS,
      'get header',
    );
  } catch (error) {
    throw new PaymentUnverifiableError(
      `Payment block is not known to the node: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const height = header.number.toNumber();

  const finalizedHash = await withDeadline(
    api.rpc.chain.getFinalizedHead(),
    CHAIN_READ_TIMEOUT_MS,
    'get finalized head',
  );
  const finalizedHeader = await withDeadline(
    api.rpc.chain.getHeader(finalizedHash),
    CHAIN_READ_TIMEOUT_MS,
    'get finalized header',
  );
  if (finalizedHeader.number.toNumber() < height) {
    throw new PaymentUnverifiableError(
      `Payment block ${height} is not yet finalized on this node (finalized head ${finalizedHeader.number.toNumber()})`,
    );
  }

  const canonicalHash = await withDeadline(
    api.rpc.chain.getBlockHash(height),
    CHAIN_READ_TIMEOUT_MS,
    'get block hash',
  );
  if (canonicalHash.toHex() !== blockHash.toLowerCase()) {
    return none;
  }

  const signedBlock = await withDeadline(
    api.rpc.chain.getBlock(blockHash),
    CHAIN_READ_TIMEOUT_MS,
    'get block',
  );
  const extrinsics = signedBlock.block.extrinsics;
  const index = extrinsics.findIndex((ex) => ex.hash.toHex() === payment.tx_hash.toLowerCase());
  if (index < 0) {
    return { ...none, canonical: true };
  }

  const apiAt = await withDeadline(api.at(blockHash), CHAIN_READ_TIMEOUT_MS, 'api at block');
  const events = (await withDeadline(
    apiAt.query.system.events(),
    CHAIN_READ_TIMEOUT_MS,
    'read events',
  )) as unknown as EventRecord[];
  const success = events.some(
    ({ phase, event }) =>
      phase.isApplyExtrinsic &&
      phase.asApplyExtrinsic.toNumber() === index &&
      api.events.system.ExtrinsicSuccess.is(event),
  );

  const ex = extrinsics[index];
  const { section, method } = ex.method;
  const args = ex.method.args;
  return {
    canonical: true,
    found: true,
    success,
    call: `${section}.${method}`,
    signer: addressOf(ex.signer),
    destination: addressOf(args[0]),
    amountRao: args[1] ? BigInt(args[1].toString()) : null,
  };
};

/**
 * Verify the payment named in a task. Resolves to a verdict; rejects with
 * `PaymentUnverifiableError` when the chain could not be read (not the
 * payment's fault, so the caller reports it as an infrastructure failure).
 */
export const verifyTaskPayment = async (payment: TaskPayment): Promise<PaymentVerdict> => {
  if (!payment.block_hash) {
    return { ok: false, message: 'Payment has no block hash' };
  }

  // Each endpoint gets the whole read. A node that cannot be reached, or no
  // longer holds the block's state, is not a verdict on the payment: the next
  // endpoint is asked, and the archive node comes last.
  const failures: string[] = [];
  for (const endpoint of resolvePaymentWsEndpoints()) {
    let api: ApiPromise;
    try {
      api = await connect(endpoint);
    } catch (error) {
      failures.push(`${endpoint}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    try {
      const observed = await fetchObservedTransfer(api, payment);
      const verdict = judgeTransfer(observed, payment);
      logger.info(
        { txHash: payment.tx_hash, blockHash: payment.block_hash, endpoint, ok: verdict.ok },
        verdict.ok ? 'Payment verified on chain' : `Payment rejected: ${verdict.message}`,
      );
      return verdict;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${endpoint}: ${message}`);
      logger.warn(
        { txHash: payment.tx_hash, blockHash: payment.block_hash, endpoint, error: message },
        'Payment could not be read from this endpoint; trying the next',
      );
    } finally {
      await withDeadline(api.disconnect(), CHAIN_DISCONNECT_TIMEOUT_MS, 'disconnect').catch(
        () => undefined,
      );
    }
  }
  throw new PaymentUnverifiableError(`Chain read failed on every endpoint: ${failures.join('; ')}`);
};
