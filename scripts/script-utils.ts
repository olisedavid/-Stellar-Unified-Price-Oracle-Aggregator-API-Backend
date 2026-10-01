/**
 * Shared helpers for operational scripts.
 *
 * Provides a consistent interface for:
 *  - Argument parsing (--flag, --key=value, positional args)
 *  - Structured logging with timestamps and levels
 *  - Exit-code helpers that flush logs before termination
 *  - Dry-run mode detection and enforcement
 *
 * Usage:
 *   import { args, log, die, requireConfirm, isDryRun } from './script-utils.js';
 *
 *   if (isDryRun()) log.info('[dry-run] would delete X');
 *   else deleteX();
 */

const argv = process.argv.slice(2);

export function hasFlag(flag: string): boolean {
  return argv.includes(flag);
}

export function getArg(key: string): string | undefined {
  const prefix = `--${key}=`;
  const entry = argv.find((a) => a.startsWith(prefix));
  if (entry) return entry.slice(prefix.length);
  const idx = argv.indexOf(`--${key}`);
  if (idx !== -1 && idx + 1 < argv.length && !argv[idx + 1].startsWith('--')) {
    return argv[idx + 1];
  }
  return undefined;
}

export function positionalArgs(): string[] {
  return argv.filter((a) => !a.startsWith('--'));
}

export function isDryRun(): boolean {
  return hasFlag('--dry-run') || process.env.DRY_RUN === 'true';
}

function ts(): string {
  return new Date().toISOString();
}

export const log = {
  info(msg: string): void {
    process.stdout.write(`[${ts()}] INFO  ${msg}\n`);
  },
  warn(msg: string): void {
    process.stderr.write(`[${ts()}] WARN  ${msg}\n`);
  },
  error(msg: string): void {
    process.stderr.write(`[${ts()}] ERROR ${msg}\n`);
  },
};

export function die(msg: string, code = 1): never {
  log.error(msg);
  process.exit(code);
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) die(`Required environment variable ${name} is not set.`);
  return value as string;
}

export function requireConfirm(envVar: string, expected = 'yes'): void {
  if ((process.env[envVar] || '').toLowerCase() !== expected.toLowerCase()) {
    die(
      `This is a destructive operation. Set ${envVar}=${expected} to confirm, or pass --dry-run to preview.`,
    );
  }
}

export function dryRunGuard(confirmEnvVar: string, expected = 'yes'): void {
  if (isDryRun()) {
    log.info('[dry-run] mode active — no state will be mutated.');
    return;
  }
  requireConfirm(confirmEnvVar, expected);
}
