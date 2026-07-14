/**
 * Internal logger. Warnings are always emitted (dropped events must never be
 * silent); info-level detail only when the client was built with debug: true.
 */
export interface Logger {
  warn(message: string): void;
  debug(message: string): void;
}

export function makeLogger(debug: boolean): Logger {
  return {
    warn(message: string): void {
      console.warn(`[kilden] ${message}`);
    },
    debug(message: string): void {
      if (debug) console.log(`[kilden] ${message}`);
    },
  };
}

/** A logger that says nothing, for enabled: false clients. */
export const silentLogger: Logger = { warn() {}, debug() {} };
