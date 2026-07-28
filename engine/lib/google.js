/**
 * Google Places API (New) client — just the two calls we need.
 *
 * Uses the Places API rather than the Business Profile API deliberately: no
 * access-request approval, and it returns exactly what a customer sees.
 *
 * Two auth modes, checked in this order:
 *
 *   1. GOOGLE_ACCESS_TOKEN — an OAuth access token, sent as a Bearer header.
 *      This is the mode CI uses: Workload Identity Federation mints a
 *      short-lived token per run, so there is no long-lived credential to
 *      store or leak. Google recommends OAuth over API keys for server-to-
 *      server calls, and it satisfies org policies that disallow API keys.
 *      Pair it with GOOGLE_CLOUD_PROJECT so usage bills to the right project.
 *
 *   2. GOOGLE_MAPS_API_KEY — a plain API key, sent as X-Goog-Api-Key.
 *      Simpler for local runs, if your org policy permits keys at all.
 */

const PLACES_BASE = 'https://places.googleapis.com/v1';

function authHeaders() {
  const accessToken = process.env.GOOGLE_ACCESS_TOKEN;
  if (accessToken) {
    const headers = { Authorization: `Bearer ${accessToken}` };
    // OAuth calls are billed to the quota project rather than to the key's
    // project, so this must be set or the request is rejected.
    const project = process.env.GOOGLE_CLOUD_PROJECT;
    if (project) headers['X-Goog-User-Project'] = project;
    return headers;
  }

  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (key) return { 'X-Goog-Api-Key': key };

  throw new Error(
    'No Google credentials. Set GOOGLE_ACCESS_TOKEN (preferred; see README) ' +
      'or GOOGLE_MAPS_API_KEY.'
  );
}

async function request(url, { fieldMask, method = 'GET', body } = {}) {
  const headers = {
    ...authHeaders(),
    'X-Goog-FieldMask': fieldMask,
  };
  if (body) headers['Content-Type'] = 'application/json';

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Places API ${res.status}: ${text.slice(0, 400)}`);
  }
  return text ? JSON.parse(text) : {};
}

/**
 * Look up a Place ID from a free-text query (name + address).
 * Used once per store by resolve-place-ids.js; the sync job never calls this.
 */
async function findPlaceId(query, { locationBias } = {}) {
  const body = { textQuery: query, maxResultCount: 5 };
  if (locationBias) {
    body.locationBias = {
      circle: { center: { latitude: locationBias.lat, longitude: locationBias.lng }, radius: 2000 },
    };
  }

  const data = await request(`${PLACES_BASE}/places:searchText`, {
    method: 'POST',
    body,
    fieldMask: 'places.id,places.displayName,places.formattedAddress,places.businessStatus',
  });

  return (data.places || []).map((p) => ({
    placeId: p.id,
    name: p.displayName && p.displayName.text,
    address: p.formattedAddress,
    businessStatus: p.businessStatus,
  }));
}

/**
 * Fetch a place's regular opening hours.
 *
 * `regularOpeningHours` is the standing weekly schedule; `currentOpeningHours`
 * reflects holiday and temporary overrides for the next 7 days. We sync the
 * regular schedule and surface the current one only for change alerting, so a
 * one-off holiday never overwrites the standing hours.
 */
async function getPlaceHours(placeId) {
  const data = await request(`${PLACES_BASE}/places/${encodeURIComponent(placeId)}`, {
    fieldMask: [
      'id',
      'displayName',
      'formattedAddress',
      'businessStatus',
      'utcOffsetMinutes',
      'regularOpeningHours',
      'currentOpeningHours',
    ].join(','),
  });

  return {
    placeId: data.id,
    name: data.displayName && data.displayName.text,
    address: data.formattedAddress,
    businessStatus: data.businessStatus,
    utcOffsetMinutes: data.utcOffsetMinutes,
    regularOpeningHours: data.regularOpeningHours || null,
    currentOpeningHours: data.currentOpeningHours || null,
  };
}

module.exports = { findPlaceId, getPlaceHours };
