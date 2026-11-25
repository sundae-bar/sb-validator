import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keyring } from '@polkadot/keyring';
import { cryptoWaitReady } from '@polkadot/util-crypto';
import {
  judgeTransfer,
  parseTaskPayment,
  type ObservedTransfer,
  type TaskPayment,
} from '../src/payment-verifier';

const setup = async () => {
  await cryptoWaitReady();
  const keyring = new Keyring({ type: 'sr25519', ss58Format: 42 });
  const payer = keyring.addFromUri('//Alice').address;
  const destination = keyring.addFromUri('//Bob').address;
  const other = keyring.addFromUri('//Charlie').address;
  const expected: TaskPayment = {
    tx_hash: `0x${'a'.repeat(64)}`,
    block_hash: `0x${'b'.repeat(64)}`,
    payer,
    destination,
    amount_rao: '50000000',
  };
  const good: ObservedTransfer = {
    canonical: true,
    found: true,
    success: true,
    call: 'balances.transferKeepAlive',
    signer: payer,
    destination,
    amountRao: 50_000_000n,
  };
  return { payer, destination, other, expected, good };
};

test('exact payment passes, overpayment passes', async () => {
  const { expected, good } = await setup();
  assert.deepEqual(judgeTransfer(good, expected), { ok: true });
  assert.deepEqual(judgeTransfer({ ...good, amountRao: 90_000_000n }, expected), { ok: true });
});

test('underpayment fails', async () => {
  const { expected, good } = await setup();
  const v = judgeTransfer({ ...good, amountRao: 49_999_999n }, expected);
  assert.equal(v.ok, false);
});

test('wrong destination fails', async () => {
  const { expected, good, other } = await setup();
  assert.equal(judgeTransfer({ ...good, destination: other }, expected).ok, false);
});

test('payment from another wallet fails (hash theft)', async () => {
  const { expected, good, other } = await setup();
  assert.equal(judgeTransfer({ ...good, signer: other }, expected).ok, false);
});

test('failed, missing and non-canonical extrinsics fail', async () => {
  const { expected, good } = await setup();
  assert.equal(judgeTransfer({ ...good, success: false }, expected).ok, false);
  assert.equal(judgeTransfer({ ...good, found: false }, expected).ok, false);
  assert.equal(judgeTransfer({ ...good, canonical: false }, expected).ok, false);
});

test('only plain balance transfers count', async () => {
  const { expected, good } = await setup();
  assert.equal(judgeTransfer({ ...good, call: 'utility.batch' }, expected).ok, false);
  assert.equal(judgeTransfer({ ...good, call: 'balances.transferAllowDeath' }, expected).ok, true);
});

test('address prefix differences do not matter', async () => {
  const { expected, good } = await setup();
  // Same key, generic substrate prefix vs raw hex public key.
  const { decodeAddress } = await import('@polkadot/util-crypto');
  const { u8aToHex } = await import('@polkadot/util');
  const hex = u8aToHex(decodeAddress(expected.payer as string));
  assert.deepEqual(judgeTransfer({ ...good, signer: hex }, expected), { ok: true });
});

test('bad task data fails closed', async () => {
  const { expected, good } = await setup();
  assert.equal(judgeTransfer(good, { ...expected, payer: null }).ok, false);
  assert.equal(judgeTransfer(good, { ...expected, amount_rao: 'abc' }).ok, false);
  assert.equal(judgeTransfer(good, { ...expected, amount_rao: '0' }).ok, false);
});

test('parseTaskPayment', () => {
  assert.equal(parseTaskPayment(undefined), null);
  assert.equal(parseTaskPayment({}), null);
  assert.equal(parseTaskPayment({ payment: { tx_hash: '' } }), null);
  const p = parseTaskPayment({
    payment: { tx_hash: '0x1', block_hash: '0x2', payer: 'a', destination: 'b', amount_rao: '5' },
  });
  assert.deepEqual(p, {
    tx_hash: '0x1',
    block_hash: '0x2',
    payer: 'a',
    destination: 'b',
    amount_rao: '5',
  });
});
