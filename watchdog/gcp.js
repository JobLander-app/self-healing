'use strict';
//
// Thin GCP + Telegram I/O for the watchdog.
//
// No client libraries on purpose: an ADC token from the metadata server plus
// `fetch` is the whole dependency surface. This code's job is to work on the
// day the VM it watches is broken, so it carries as little machinery as it can.

const METADATA_TOKEN_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';

const DEFAULT_TIMEOUT_MS = 15000;

async function httpJson(url, { method = 'GET', headers = {}, body, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: body ? { 'content-type': 'application/json', ...headers } : headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: ac.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`${method} ${url.split('?')[0]} -> ${res.status}: ${text.slice(0, 400)}`);
    }
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timer);
  }
}

let cachedToken = null;
async function accessToken() {
  if (cachedToken && cachedToken.expiresAt - Date.now() > 60_000) return cachedToken.value;
  const tok = await httpJson(METADATA_TOKEN_URL, { headers: { 'Metadata-Flavor': 'Google' } });
  cachedToken = { value: tok.access_token, expiresAt: Date.now() + (tok.expires_in || 3600) * 1000 };
  return cachedToken.value;
}

async function authed(url, opts = {}) {
  const token = await accessToken();
  return httpJson(url, { ...opts, headers: { authorization: `Bearer ${token}`, ...(opts.headers || {}) } });
}

/**
 * Newest entry timestamp (ms) for a log id, or null when the log has produced
 * nothing inside the lookback window.
 */
async function latestEntryMs({ projectId, logId, lookbackSec, contains }) {
  const since = new Date(Date.now() - lookbackSec * 1000).toISOString();
  const filterParts = [
    `logName="projects/${projectId}/logs/${encodeURIComponent(logId)}"`,
    `timestamp>="${since}"`,
  ];
  if (contains) filterParts.push(`textPayload:"${contains}"`);
  const res = await authed('https://logging.googleapis.com/v2/entries:list', {
    method: 'POST',
    body: {
      resourceNames: [`projects/${projectId}`],
      filter: filterParts.join(' AND '),
      orderBy: 'timestamp desc',
      pageSize: 1,
    },
  });
  const entry = (res.entries || [])[0];
  if (!entry) return null;
  const ts = Date.parse(entry.timestamp);
  return Number.isFinite(ts) ? ts : null;
}

async function writeLogEntry({ projectId, logId, text, severity = 'INFO', labels = {} }) {
  await authed('https://logging.googleapis.com/v2/entries:write', {
    method: 'POST',
    body: {
      logName: `projects/${projectId}/logs/${encodeURIComponent(logId)}`,
      resource: { type: 'global' },
      entries: [{ textPayload: text, severity, labels }],
    },
  });
}

async function getInstanceStatus({ projectId, zone, instance }) {
  const res = await authed(
    `https://compute.googleapis.com/compute/v1/projects/${projectId}/zones/${zone}/instances/${instance}`,
  );
  return res.status;
}

async function instanceAction({ projectId, zone, instance, action }) {
  // action: 'reset' | 'start'
  return authed(
    `https://compute.googleapis.com/compute/v1/projects/${projectId}/zones/${zone}/instances/${instance}/${action}`,
    { method: 'POST' },
  );
}

async function readState({ bucket, object }) {
  const url = `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(object)}?alt=media`;
  try {
    return await authed(url);
  } catch (err) {
    // A missing state object is the normal first run, not a failure.
    if (String(err.message).includes('-> 404')) return {};
    throw err;
  }
}

async function writeState({ bucket, object, state }) {
  const url =
    `https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o` +
    `?uploadType=media&name=${encodeURIComponent(object)}`;
  await authed(url, { method: 'POST', body: state });
}

async function sendTelegram({ token, chatId, text }) {
  // Telegram caps a message at 4096 chars.
  const body = { chat_id: chatId, text: text.slice(0, 4000), disable_web_page_preview: true };
  return httpJson(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', body });
}

module.exports = {
  httpJson,
  accessToken,
  latestEntryMs,
  writeLogEntry,
  getInstanceStatus,
  instanceAction,
  readState,
  writeState,
  sendTelegram,
};
