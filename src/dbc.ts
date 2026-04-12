export const ErrPreconditionViolation = 'precondition violation';
export const ErrPostconditionViolation = 'postcondition violation';

declare global {
  var __AASX_DEBUG_CONTRACTS__: boolean | undefined;
}

function isDebugContractsEnabled(): boolean {
  if (typeof globalThis.__AASX_DEBUG_CONTRACTS__ === 'boolean') {
    return globalThis.__AASX_DEBUG_CONTRACTS__;
  }

  if (typeof process !== 'undefined' && process?.env) {
    const explicit = process.env.AASX_DEBUG_CONTRACTS;
    if (explicit === '1' || explicit === 'true') {
      return true;
    }
    if (explicit === '0' || explicit === 'false') {
      return false;
    }
    return process.env.NODE_ENV !== 'production';
  }

  return true;
}

export function Require(condition: boolean, message: string): void {
  if (!condition && isDebugContractsEnabled()) {
    throw new Error(`${ErrPreconditionViolation}: ${message}`);
  }
}

export function Ensure(condition: boolean, message: string): void {
  if (!condition && isDebugContractsEnabled()) {
    throw new Error(`${ErrPostconditionViolation}: ${message}`);
  }
}
