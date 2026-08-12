import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isSecretRef,
  expandEnvInString,
  resolveSecretValue,
  resolveSecretRefs,
  findPlaintextSecretFields,
  applySecretsToConfig,
} from '../src/credentials/resolve.js';

describe('secret resolve', () => {
  let dir;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-sec-'));
    fs.writeFileSync(path.join(dir, 'pw'), 'hunter2\n', 'utf8');
  });
  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('detects file: and env: refs', () => {
    assert.equal(isSecretRef('file:/x'), true);
    assert.equal(isSecretRef('env:FOO'), true);
    assert.equal(isSecretRef('plain'), false);
  });

  it('reads file: and strips trailing newline', () => {
    const v = resolveSecretValue(`file:${path.join(dir, 'pw')}`);
    assert.equal(v, 'hunter2');
  });

  it('reads env:', () => {
    process.env.MG_TEST_SECRET = 'from-env';
    assert.equal(resolveSecretValue('env:MG_TEST_SECRET'), 'from-env');
    delete process.env.MG_TEST_SECRET;
  });

  it('expands ${CREDENTIALS_DIRECTORY} in paths', () => {
    process.env.CREDENTIALS_DIRECTORY = dir;
    const v = resolveSecretValue('file:${CREDENTIALS_DIRECTORY}/pw');
    assert.equal(v, 'hunter2');
    delete process.env.CREDENTIALS_DIRECTORY;
  });

  it('expandEnvInString', () => {
    process.env.FOO_BAR = 'xyz';
    assert.equal(expandEnvInString('/a/${FOO_BAR}/b'), '/a/xyz/b');
    delete process.env.FOO_BAR;
  });

  it('resolveSecretRefs walks config', () => {
    process.env.MG_X = '1';
    const out = resolveSecretRefs({
      source: { password: 'env:MG_X' },
      keep: 'ok',
    });
    assert.equal(out.source.password, '1');
    assert.equal(out.keep, 'ok');
    delete process.env.MG_X;
  });

  it('findPlaintextSecretFields ignores refs', () => {
    const hits = findPlaintextSecretFields({
      source: { password: 'file:/x' },
      a: { clientSecret: 'inline-bad' },
    });
    assert.deepEqual(hits, ['a.clientSecret']);
  });

  it('applySecretsToConfig rejects plaintext by default', () => {
    assert.throws(
      () =>
        applySecretsToConfig({
          settings: {},
          source: { password: 'clear' },
        }),
      /Plaintext secrets/,
    );
  });

  it('applySecretsToConfig allows plaintext when opted in', () => {
    const { config } = applySecretsToConfig({
      settings: { allowPlaintextSecrets: true },
      source: { password: 'clear' },
    });
    assert.equal(config.source.password, 'clear');
  });
});
