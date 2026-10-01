#!/usr/bin/env node
// Local stand-in for the four upstream oracle APIs.
//
// Integration tests need the aggregator to produce real prices, but pointing it
// at the live providers would make CI depend on four third-party services. This
// stub serves the exact response shape each source module parses, from one
// deterministic price table, so the pipeline can run end to end offline.
//
// Every source is pointed at this one base URL, so routes are distinguished by
// path: /price (chainlink), /prices (redstone), /oracle/v1/feeds/:s (band),
// /v1/prices (reflector).
//
// Note the deliberate decimal spread (8 vs 9 vs 18) — the aggregator has to
// reduce mixed-scale sources to a common scale, and this keeps that path
// exercised in CI rather than only in unit tests.
//
// FAULT INJECTION
// ---------------
// A control endpoint lets tests inject faults per source and/or asset without
// restarting the stub. The default behaviour (no faults) is unchanged.
//
// POST /_control/fault
//   Body: {
//     source?:  "chainlink"|"redstone"|"band"|"reflector"  // omit = all sources
//     asset?:   "XLM"|"BTC"|...                            // omit = all assets
//     fault: {
//       type: "status"|"latency"|"timeout"|"malformed"|"error_envelope"|"missing_field"|"out_of_range"
//       statusCode?: number        // for type "status"
//       latencyMs?:  number        // for type "latency" (added to every response)
//       body?:       string        // raw body override for type "malformed"
//       field?:      string        // field to omit for type "missing_field"
//     }
//   }
//
// DELETE /_control/fault
//   Clears all active faults. Body (optional): { source?, asset? } to clear selectively.
//
// GET /_control/fault
//   Returns current fault table (useful for test output recording).
//
// Fault injection is deterministic: the same POST produces the same behaviour on
// every subsequent request until cleared. Each response includes an
// X-Stub-Fault header naming the active fault so test failures can report it.

import http from 'node:http';

const PORT = parseInt(process.env.STUB_ORACLE_PORT || '4010', 10);

const PRICES = {
  XLM: 0.12,
  USDC: 1.0,
  BTC: 65000.0,
  ETH: 3500.0,
  USDT: 1.0,
};

const SOURCES = ['chainlink', 'redstone', 'band', 'reflector'];

const nowSeconds = () => Math.floor(Date.now() / 1000);

function priceFor(symbol) {
  const key = String(symbol || '').toUpperCase();
  return Object.prototype.hasOwnProperty.call(PRICES, key) ? PRICES[key] : null;
}

function send(res, status, body, extraHeaders) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    ...extraHeaders,
  });
  res.end(payload);
}

function sendRaw(res, status, text, extraHeaders) {
  const buf = Buffer.from(text, 'utf8');
  res.writeHead(status, {
    'content-type': 'text/plain',
    'content-length': buf.length,
    ...extraHeaders,
  });
  res.end(buf);
}

// ---------------------------------------------------------------------------
// Fault table
// Key: "<source>|<asset>" or "<source>|*" or "*|<asset>" or "*|*"
// ---------------------------------------------------------------------------
const faultTable = new Map();

function faultKey(source, asset) {
  return `${source || '*'}|${asset || '*'}`;
}

function activeFault(source, asset) {
  const assetUp = asset ? asset.toUpperCase() : '*';
  const candidates = [
    faultKey(source, assetUp),
    faultKey(source, '*'),
    faultKey('*', assetUp),
    faultKey('*', '*'),
  ];
  for (const k of candidates) {
    if (faultTable.has(k)) return { key: k, fault: faultTable.get(k) };
  }
  return null;
}

async function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve(null);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Apply a fault to a response.  Returns true if the request was fully handled
// (no further processing needed), false if only latency was injected.
// ---------------------------------------------------------------------------
async function applyFault(res, fault, faultKey) {
  const faultHeader = { 'X-Stub-Fault': faultKey };

  if (fault.type === 'latency') {
    const ms = fault.latencyMs ?? 200;
    await new Promise((r) => setTimeout(r, ms));
    return false;
  }

  if (fault.type === 'timeout') {
    // Never respond — the client will time out.
    console.log(`[stub-oracle] [fault] timeout injected (key=${faultKey})`);
    return true;
  }

  if (fault.type === 'status') {
    send(res, fault.statusCode ?? 500, { error: 'injected fault' }, faultHeader);
    return true;
  }

  if (fault.type === 'malformed') {
    sendRaw(res, 200, fault.body ?? '{not valid json{{', faultHeader);
    return true;
  }

  if (fault.type === 'error_envelope') {
    send(res, 200, { error: 'provider error', code: 'INJECTED' }, faultHeader);
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------
async function handleChainlink(req, res, url) {
  const symbol = String(url.searchParams.get('fsym') || '').toUpperCase();
  const fi = activeFault('chainlink', symbol);

  if (fi) {
    const done = await applyFault(res, fi.fault, fi.key);
    if (done) return;
  }

  const price = priceFor(symbol);
  if (price === null) return send(res, 200, {});
  console.log(`[stub-oracle] chainlink ${req.url}`);

  let body = { USD: { PRICE: price } };
  if (fi && fi.fault.type === 'missing_field') {
    body = {};
  } else if (fi && fi.fault.type === 'out_of_range') {
    body = { USD: { PRICE: -9999 } };
  }
  const header = fi ? { 'X-Stub-Fault': fi.key } : {};
  send(res, 200, body, header);
}

async function handleRedstone(req, res, url) {
  const symbol = String(url.searchParams.get('symbols') || '').toUpperCase();
  const fi = activeFault('redstone', symbol);

  if (fi) {
    const done = await applyFault(res, fi.fault, fi.key);
    if (done) return;
  }

  const price = priceFor(symbol);
  if (price === null) return send(res, 200, {});
  console.log(`[stub-oracle] redstone ${req.url}`);

  let body = { [symbol]: { value: String(price), decimals: 8 } };
  if (fi && fi.fault.type === 'missing_field') {
    body = { [symbol]: { decimals: 8 } };
  } else if (fi && fi.fault.type === 'out_of_range') {
    body = { [symbol]: { value: '-9999', decimals: 8 } };
  }
  const header = fi ? { 'X-Stub-Fault': fi.key } : {};
  send(res, 200, body, header);
}

async function handleBand(req, res, raw) {
  const symbol = raw.replace(/-USD$/i, '').toUpperCase();
  const fi = activeFault('band', symbol);

  if (fi) {
    const done = await applyFault(res, fi.fault, fi.key);
    if (done) return;
  }

  const price = priceFor(symbol);
  if (price === null) return send(res, 404, { error: 'unknown feed' });
  console.log(`[stub-oracle] band /${raw}`);

  let body = { data: { price: String(price), decimals: 9, updated_at: nowSeconds() } };
  if (fi && fi.fault.type === 'missing_field') {
    body = { data: { decimals: 9, updated_at: nowSeconds() } };
  } else if (fi && fi.fault.type === 'out_of_range') {
    body = { data: { price: '-9999', decimals: 9, updated_at: nowSeconds() } };
  }
  const header = fi ? { 'X-Stub-Fault': fi.key } : {};
  send(res, 200, body, header);
}

async function handleReflector(req, res, url) {
  const asset = String(url.searchParams.get('asset') || '');
  const base = asset.replace(/^Crypto\./i, '').replace(/\/USD$/i, '').toUpperCase();
  const fi = activeFault('reflector', base);

  if (fi) {
    const done = await applyFault(res, fi.fault, fi.key);
    if (done) return;
  }

  const price = priceFor(base);
  if (price === null) return send(res, 200, { prices: {} });
  console.log(`[stub-oracle] reflector ${req.url}`);

  let body = {
    prices: { [asset]: { price: String(price), decimals: 8, timestamp: nowSeconds() } },
  };
  if (fi && fi.fault.type === 'missing_field') {
    body = { prices: { [asset]: { decimals: 8, timestamp: nowSeconds() } } };
  } else if (fi && fi.fault.type === 'out_of_range') {
    body = { prices: { [asset]: { price: '-9999', decimals: 8, timestamp: nowSeconds() } } };
  }
  const header = fi ? { 'X-Stub-Fault': fi.key } : {};
  send(res, 200, body, header);
}

// ---------------------------------------------------------------------------
// Control endpoint handlers
// ---------------------------------------------------------------------------
async function handleControlGet(res) {
  const table = Object.fromEntries(faultTable);
  send(res, 200, { faults: table });
}

async function handleControlPost(req, res) {
  const body = await readBody(req);
  if (!body || !body.fault || !body.fault.type) {
    send(res, 400, { error: 'body must contain { fault: { type } }' });
    return;
  }
  const source = body.source || '*';
  const asset = body.asset ? String(body.asset).toUpperCase() : '*';

  if (source !== '*' && !SOURCES.includes(source)) {
    send(res, 400, { error: `unknown source "${source}"` });
    return;
  }

  const key = faultKey(source, asset);
  faultTable.set(key, body.fault);
  console.log(`[stub-oracle] [fault] SET key=${key} type=${body.fault.type}`);
  send(res, 200, { ok: true, key, fault: body.fault });
}

async function handleControlDelete(req, res) {
  const body = await readBody(req);
  if (body && (body.source || body.asset)) {
    const source = body.source || '*';
    const asset = body.asset ? String(body.asset).toUpperCase() : '*';
    const key = faultKey(source, asset);
    faultTable.delete(key);
    console.log(`[stub-oracle] [fault] CLEAR key=${key}`);
    send(res, 200, { ok: true, cleared: key });
  } else {
    const count = faultTable.size;
    faultTable.clear();
    console.log(`[stub-oracle] [fault] CLEAR all (${count} entries)`);
    send(res, 200, { ok: true, cleared: 'all' });
  }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  if (path === '/_control/fault') {
    if (req.method === 'GET') return handleControlGet(res);
    if (req.method === 'POST') return handleControlPost(req, res);
    if (req.method === 'DELETE') return handleControlDelete(req, res);
    return send(res, 405, { error: 'method not allowed' });
  }

  if (path === '/price') return handleChainlink(req, res, url);
  if (path === '/prices') return handleRedstone(req, res, url);

  if (path.startsWith('/oracle/v1/feeds/')) {
    const raw = decodeURIComponent(path.slice('/oracle/v1/feeds/'.length));
    return handleBand(req, res, raw);
  }

  if (path === '/v1/prices') return handleReflector(req, res, url);

  send(res, 404, { error: `no stub route for ${path}` });
});

server.listen(PORT, () => {
  console.log(`[stub-oracle] listening on http://localhost:${PORT}`);
  console.log(`[stub-oracle] assets: ${Object.keys(PRICES).join(', ')}`);
  console.log(`[stub-oracle] fault control: POST/DELETE/GET /_control/fault`);
});
