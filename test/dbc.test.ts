import { afterEach, describe, expect, test, vi } from 'vitest';
import { Ensure, ErrPostconditionViolation, ErrPreconditionViolation, Require } from '../src';

const originalDebugContracts = globalThis.__AASX_DEBUG_CONTRACTS__;
const originalAasxDebugContracts = process.env.AASX_DEBUG_CONTRACTS;
const originalNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  vi.unstubAllGlobals();
  globalThis.__AASX_DEBUG_CONTRACTS__ = originalDebugContracts;
  setOptionalEnv('AASX_DEBUG_CONTRACTS', originalAasxDebugContracts);
  setOptionalEnv('NODE_ENV', originalNodeEnv);
});

describe('Design by contract flags', () => {
  test('throws by default when checks are enabled', () => {
    globalThis.__AASX_DEBUG_CONTRACTS__ = undefined;
    delete process.env.AASX_DEBUG_CONTRACTS;
    process.env.NODE_ENV = 'test';

    expect(() => Require(false, 'require failure')).toThrow(`${ErrPreconditionViolation}: require failure`);
    expect(() => Ensure(false, 'ensure failure')).toThrow(`${ErrPostconditionViolation}: ensure failure`);
  });

  test('global override false disables checks', () => {
    globalThis.__AASX_DEBUG_CONTRACTS__ = false;
    process.env.AASX_DEBUG_CONTRACTS = '1';
    process.env.NODE_ENV = 'test';

    expect(() => Require(false, 'should not throw')).not.toThrow();
    expect(() => Ensure(false, 'should not throw')).not.toThrow();
  });

  test('global override true enables checks even if env would disable them', () => {
    globalThis.__AASX_DEBUG_CONTRACTS__ = true;
    process.env.AASX_DEBUG_CONTRACTS = '0';
    process.env.NODE_ENV = 'production';

    expect(() => Require(false, 'require failure')).toThrow(ErrPreconditionViolation);
    expect(() => Ensure(false, 'ensure failure')).toThrow(ErrPostconditionViolation);
  });

  test('env explicit true enables checks', () => {
    globalThis.__AASX_DEBUG_CONTRACTS__ = undefined;
    process.env.AASX_DEBUG_CONTRACTS = 'true';
    process.env.NODE_ENV = 'production';

    expect(() => Require(false, 'require failure')).toThrow(ErrPreconditionViolation);
  });

  test('env explicit 1 enables checks', () => {
    globalThis.__AASX_DEBUG_CONTRACTS__ = undefined;
    process.env.AASX_DEBUG_CONTRACTS = '1';
    process.env.NODE_ENV = 'production';

    expect(() => Require(false, 'require failure')).toThrow(ErrPreconditionViolation);
  });

  test('env explicit false disables checks', () => {
    globalThis.__AASX_DEBUG_CONTRACTS__ = undefined;
    process.env.AASX_DEBUG_CONTRACTS = 'false';
    process.env.NODE_ENV = 'test';

    expect(() => Require(false, 'should not throw')).not.toThrow();
    expect(() => Ensure(false, 'should not throw')).not.toThrow();
  });

  test('env explicit 0 disables checks', () => {
    globalThis.__AASX_DEBUG_CONTRACTS__ = undefined;
    process.env.AASX_DEBUG_CONTRACTS = '0';
    process.env.NODE_ENV = 'test';

    expect(() => Require(false, 'should not throw')).not.toThrow();
  });

  test('production disables checks when env flag is not explicitly set', () => {
    globalThis.__AASX_DEBUG_CONTRACTS__ = undefined;
    delete process.env.AASX_DEBUG_CONTRACTS;
    process.env.NODE_ENV = 'production';

    expect(() => Require(false, 'should not throw')).not.toThrow();
    expect(() => Ensure(false, 'should not throw')).not.toThrow();
  });

  test('falls back to enabled checks when process global is unavailable', () => {
    globalThis.__AASX_DEBUG_CONTRACTS__ = undefined;
    vi.stubGlobal('process', undefined);

    expect(() => Require(false, 'require failure')).toThrow(ErrPreconditionViolation);
    expect(() => Ensure(false, 'ensure failure')).toThrow(ErrPostconditionViolation);
  });
});

function setOptionalEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}