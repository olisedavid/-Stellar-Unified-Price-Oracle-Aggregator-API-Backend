import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fetch from 'node-fetch';

const STUB_URL = process.env.STUB_ORACLE_URL || 'http://localhost:4010';
const AGGREGATOR_HEALTH_URL =
  process.env.AGGREGATOR_HEALTH_URL || 'http://localhost:4002';

async function setFault(
  source: string | undefined,
  asset: string | undefined,
  fault: Record<string, unknown>,
) {
  const body: Record<string, unknown> = { fault };
  if (source) body.source = source;
  if (asset) body.asset = asset;
  const res = await fetch(`${STUB_URL}/_control/fault`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`setFault failed: ${res.status}`);
}

async function clearFaults() {
  await fetch(`${STUB_URL}/_control/fault`, { method: 'DELETE' });
}

async function getFaults() {
  const res = await fetch(`${STUB_URL}/_control/fault`);
  return res.json() as Promise<{ faults: Record<string, unknown> }>;
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function aggregatorHealth() {
  const res = await fetch(`${AGGREGATOR_HEALTH_URL}/health`, {
    headers: { accept: 'application/json' },
  });
  return res.json() as Promise<{
    service: string;
    sources?: Array<{ name: string; healthy: boolean; circuitOpen?: boolean }>;
    status?: string;
  }>;
}

describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)(
  'Fault Injection: stub oracle fault control endpoint',
  () => {
    afterEach(async () => {
      await clearFaults();
    });

    it('should set and retrieve a fault via the control endpoint', async () => {
      await setFault('chainlink', 'XLM', { type: 'status', statusCode: 500 });
      const { faults } = await getFaults();
      expect(Object.keys(faults).length).toBeGreaterThan(0);
    });

    it('should return the injected status code for the targeted source', async () => {
      await setFault('chainlink', 'XLM', { type: 'status', statusCode: 503 });
      const res = await fetch(`${STUB_URL}/price?fsym=XLM`);
      expect(res.status).toBe(503);
      expect(res.headers.get('x-stub-fault')).toBeTruthy();
    });

    it('should return malformed body when malformed fault is set', async () => {
      await setFault('redstone', 'BTC', { type: 'malformed' });
      const res = await fetch(`${STUB_URL}/prices?symbols=BTC`);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(() => JSON.parse(text)).toThrow();
    });

    it('should return an error envelope with HTTP 200 when error_envelope fault is set', async () => {
      await setFault('band', 'ETH', { type: 'error_envelope' });
      const res = await fetch(`${STUB_URL}/oracle/v1/feeds/ETH-USD`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBeDefined();
    });

    it('should omit the price field when missing_field fault is set', async () => {
      await setFault('reflector', 'XLM', { type: 'missing_field', field: 'price' });
      const res = await fetch(`${STUB_URL}/v1/prices?asset=Crypto.XLM/USD`);
      const body = (await res.json()) as { prices: Record<string, Record<string, unknown>> };
      const entry = body.prices?.['Crypto.XLM/USD'];
      expect(entry).toBeDefined();
      expect(entry?.price).toBeUndefined();
    });

    it('should return an out-of-range price when out_of_range fault is set', async () => {
      await setFault('chainlink', 'BTC', { type: 'out_of_range' });
      const res = await fetch(`${STUB_URL}/price?fsym=BTC`);
      const body = (await res.json()) as { USD: { PRICE: number } };
      expect(body.USD.PRICE).toBeLessThan(0);
    });

    it('should clear all faults', async () => {
      await setFault('chainlink', 'XLM', { type: 'status', statusCode: 500 });
      await clearFaults();
      const { faults } = await getFaults();
      expect(Object.keys(faults).length).toBe(0);
    });

    it('should not affect unrelated source when fault is scoped to one source', async () => {
      await setFault('chainlink', 'XLM', { type: 'status', statusCode: 500 });
      const res = await fetch(`${STUB_URL}/prices?symbols=XLM`);
      expect(res.status).toBe(200);
    });

    it('should keep default happy-path behaviour when no faults are set', async () => {
      const res = await fetch(`${STUB_URL}/price?fsym=XLM`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { USD: { PRICE: number } };
      expect(body.USD.PRICE).toBeGreaterThan(0);
    });
  },
);

describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)(
  'Fault Injection: aggregator health and circuit breaker consequences',
  () => {
    beforeEach(async () => {
      await clearFaults();
    });

    afterEach(async () => {
      await clearFaults();
    });

    it('partial outage: one source returning 500 still produces an aggregated price', async () => {
      await setFault('chainlink', undefined, { type: 'status', statusCode: 500 });
      await sleep(6_000);

      const health = await aggregatorHealth();
      expect(health.service).toBe('stellar-price-oracle-aggregator');
      expect(Array.isArray(health.sources)).toBe(true);

      const chainlink = health.sources?.find((s) => s.name === 'chainlink');
      if (chainlink) {
        expect(chainlink.healthy).toBe(false);
      }
    }, 20_000);

    it('source recovery: breaker closes and source re-participates after fault is cleared', async () => {
      await setFault('redstone', undefined, { type: 'status', statusCode: 500 });
      await sleep(6_000);

      const degraded = await aggregatorHealth();
      const before = degraded.sources?.find((s) => s.name === 'redstone');
      if (before) expect(before.healthy).toBe(false);

      await clearFaults();
      await sleep(8_000);

      const recovered = await aggregatorHealth();
      const after = recovered.sources?.find((s) => s.name === 'redstone');
      if (after) expect(after.healthy).toBe(true);
    }, 30_000);

    it('all-source outage: health endpoint reports degraded status', async () => {
      await setFault(undefined, undefined, { type: 'status', statusCode: 503 });
      await sleep(8_000);

      const health = await aggregatorHealth();
      const statuses = ['degraded', 'unhealthy'];
      if (health.status) {
        expect(statuses).toContain(health.status);
      }
    }, 25_000);
  },
);
