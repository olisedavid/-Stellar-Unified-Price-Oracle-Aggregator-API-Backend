/**
 * Scheduled rent job for the PriceOracleContract (Issue #376).
 *
 * Invokes `extend_storage_ttl` on the deployed contract so persistent
 * PriceHistory entries and the shared instance storage entry (Admin,
 * GovernanceConfig, GovernanceProposal, MultiSigConfig) never hit their TTL
 * floor between runs. See docs/RENT_BUDGET.md for the funding and alerting
 * model this job is expected to run under.
 *
 * Usage:
 *   tsx scripts/extend-ttl-job.ts             # testnet
 *   tsx scripts/extend-ttl-job.ts --mainnet
 *   tsx scripts/extend-ttl-job.ts --dry-run   # print what would run, no-op
 *
 * Requires the same .env ADMIN_SECRET_KEY / CONTRACT_ID conventions as
 * scripts/deploy-soroban.js, and the `stellar` CLI on PATH.
 */
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { log, die, requireEnv, isDryRun, hasFlag } from './script-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const NETWORK = hasFlag('--mainnet') ? 'mainnet' : 'testnet';
const CONTRACT_ID = process.env.PRICE_ORACLE_CONTRACT_ID;
const SOURCE_ACCOUNT = process.env.RENT_FUNDING_SECRET_KEY || process.env.ADMIN_SECRET_KEY;

if (!CONTRACT_ID) die('PRICE_ORACLE_CONTRACT_ID not set in .env');
if (!SOURCE_ACCOUNT) die('RENT_FUNDING_SECRET_KEY (or ADMIN_SECRET_KEY) not set in .env');

const contractId = requireEnv('PRICE_ORACLE_CONTRACT_ID');

function run() {
  log.info(`network=${NETWORK} contract=${contractId}`);

  const cmd =
    `stellar contract invoke --id ${contractId} --source-account ${SOURCE_ACCOUNT} ` +
    `--network ${NETWORK} -- extend_storage_ttl`;

  if (isDryRun()) {
    log.info(`[dry-run] would execute: ${cmd}`);
    return;
  }

  try {
    const output = execSync(cmd, { encoding: 'utf-8' });
    log.info(output.trim());
    log.info('completed');
  } catch (err) {
    die(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
  }
}

run();
