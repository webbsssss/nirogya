/**
 * Server access with an offline-first contract.
 *
 * THE RULE: a screening is NEVER lost and NEVER blocks on the network. It is
 * scored on-device by risk.js, written to IndexedDB, and pushed when a
 * connection exists. `navigator.onLine` is only a hint (it lies on captive
 * portals and on venue Wi-Fi that associates but doesn't route), so every read
 * falls back to cache on failure rather than trusting the flag.
 */

import * as db from './db.js';
import { setWeights, hasWeights } from './risk.js';

const listeners = new Set();
export function onStatusChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit() { listeners.forEach((f) => { try { f(); } catch (e) { console.error(e); } }); }

window.addEventListener('online', emit);
window.addEventListener('offline', emit);

export function isOnline() { return navigator.onLine; }

async function getJSON(path, cacheKey) {
  try {
    const r = await fetch(path, { cache: 'no-store' });
    if (!r.ok) {
      // The status has to travel with the error. Without it every failure looks
      // the same to the caller, and "this patient does not exist" (404) gets
      // reported as "you are offline" — which sends the ASHA looking for a signal
      // instead of checking the id.
      const err = new Error(`HTTP ${r.status}`);
      err.status = r.status;
      throw err;
    }
    const data = await r.json();
    if (cacheKey) await db.cacheSet(cacheKey, data);
    return { data, stale: false };
  } catch (e) {
    // A 404 is a real answer, not a connectivity failure: falling back to cache
    // here would show a stale copy of a patient the server has just told us it
    // does not have.
    if (cacheKey && e.status !== 404) {
      const cached = await db.cacheGet(cacheKey);
      if (cached) {
        const meta = await db.cacheMeta(cacheKey);
        return { data: cached, stale: true, cachedAt: meta && meta.at };
      }
    }
    throw e;
  }
}

/**
 * Load model coefficients once, then cache them permanently.
 *
 * This is the single most important fetch in the app: after it succeeds once,
 * the phone can score patients forever with no network. Roughly 2 KB of JSON.
 */
export async function loadModel() {
  if (hasWeights()) return;
  const cached = await db.cacheGet('model');
  if (cached) { setWeights(cached); return; }
  const { data } = await getJSON('/api/model', 'model');
  setWeights(data);
}

export const getPatients = (params = {}) => {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '' && v != null));
  return getJSON(`/api/patients?${qs}`, `patients:${qs}`);
};
export const getPatient = (id) => getJSON(`/api/patients/${encodeURIComponent(id)}`, `patient:${id}`);
export const getVillages = () => getJSON('/api/villages', 'villages');
export const getStats = () => getJSON('/api/stats', 'stats');

/**
 * Submit a screening. Always queues first, then tries to push.
 *
 * Queue-then-push (rather than try-then-fallback) means an interrupted request
 * cannot lose data: worst case the record syncs twice, and /api/sync is
 * idempotent on client_uuid, so a duplicate is ignored server-side.
 */
export async function submitScreening(payload) {
  await db.enqueue(payload);
  emit();
  if (!navigator.onLine) return { queued: true, synced: false };
  try {
    const res = await syncNow();
    // A record this app just built and scored itself should never come back
    // permanently rejected. If it does, the client and the server disagree about
    // what a valid screening is, and that has to be visible immediately rather
    // than discovered later as a missing row.
    const mine = res.errors.find((e) => e.permanent && e.client_uuid === payload.client_uuid);
    return { queued: true, synced: res.applied > 0, rejected: mine || null, sync: res };
  } catch {
    return { queued: true, synced: false };
  }
}

/**
 * Push the queue and act on the server's PER-ITEM verdict.
 *
 * Three outcomes, and each one has exactly one correct response:
 *
 *   applied / duplicates_ignored  the server holds it -> drop it from the queue
 *   errors[].permanent === true   it will never be accepted -> move it to
 *                                 `rejected`, where it stops blocking sync but
 *                                 stays recoverable for a human
 *   errors[].permanent === false  transient -> leave it queued, try again later
 *
 * The body is parsed BEFORE the status is checked, and that ordering is the fix
 * for the bug this whole path had. The old first line was
 *
 *     if (!r.ok) throw new Error(`sync failed: HTTP ${r.status}`);
 *
 * so when one malformed record made the server return 500 for the batch, this
 * threw before reading the response. dequeue() never ran, and the queue kept
 * every record the server had ALREADY committed. The badge stayed lit, the ASHA
 * pressed Sync again, and the same item failed the same way forever. The server
 * now isolates each item, but the client still parses first: a body with a
 * verdict in it is worth reading whatever the status line says.
 */
export async function syncNow() {
  const items = await db.queued();
  if (!items.length) {
    return { applied: 0, duplicates: 0, rejected: 0, errors: [], remaining: 0 };
  }

  const r = await fetch('/api/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ screenings: items }),
  });

  let out;
  try {
    out = await r.json();
  } catch {
    // No readable body at all — a proxy error page, or the connection died
    // mid-response. Nothing is confirmed, so nothing leaves the queue.
    const err = new Error(`sync failed: HTTP ${r.status}`);
    err.status = r.status;
    throw err;
  }
  if (!out || typeof out !== 'object') out = {};

  const applied = (out.applied || []).map((a) => a && a.client_uuid).filter(Boolean);
  const dupes = (out.duplicates_ignored || []).filter(Boolean);
  await db.dequeue([...applied, ...dupes]);

  const errors = (out.errors || []).filter(Boolean);
  const moved = [];
  for (const e of errors) {
    if (!e.permanent) continue;
    // Fall back to the batch index: a queued record always has a client_uuid
    // (it is the keyPath), so if the server could not read one, we still know
    // which record we sent in that slot.
    const uuid = e.client_uuid
      || (items[e.index] && items[e.index].client_uuid);
    if (uuid && await db.reject(uuid, e.message, e.fields)) moved.push(uuid);
  }

  const remaining = await db.queueCount();
  emit();

  // Only now does the status matter, and only if the response accounted for
  // nothing at all — an envelope-level rejection (batch too large, body not an
  // object) where no item was even examined.
  if (!r.ok && !applied.length && !dupes.length && !moved.length) {
    const err = new Error(out.error ? `sync failed: ${out.error}`
                                    : `sync failed: HTTP ${r.status}`);
    err.status = r.status;
    err.fields = out.fields || [];
    throw err;
  }

  return {
    applied: applied.length,
    duplicates: dupes.length,
    rejected: moved.length,
    errors,
    remaining,
  };
}

export const pendingCount = () => db.queueCount();
export const rejectedRecords = () => db.rejected();
export const discardRejected = (uuid) => db.discardRejected(uuid);
