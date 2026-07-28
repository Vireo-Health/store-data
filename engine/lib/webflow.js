/**
 * Minimal Webflow Data API v2 client.
 *
 * Requires WEBFLOW_API_TOKEN — a Site API token with CMS read/write and
 * publish scopes (Site settings -> Apps & integrations -> API access).
 */

const API_BASE = 'https://api.webflow.com/v2';

function token() {
  const t = process.env.WEBFLOW_API_TOKEN;
  if (!t) throw new Error('WEBFLOW_API_TOKEN is not set');
  return t;
}

async function request(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token()}`,
      accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Webflow ${method} ${path} -> ${res.status}: ${text.slice(0, 400)}`);
  }
  return text ? JSON.parse(text) : {};
}

async function listItems(collectionId) {
  const items = [];
  let offset = 0;
  for (;;) {
    const page = await request(`/collections/${collectionId}/items?limit=100&offset=${offset}`);
    items.push(...(page.items || []));
    const total = page.pagination ? page.pagination.total : items.length;
    offset += 100;
    if (items.length >= total || !page.items || page.items.length === 0) break;
  }
  return items;
}

async function getCollection(collectionId) {
  return request(`/collections/${collectionId}`);
}

async function createField(collectionId, field) {
  return request(`/collections/${collectionId}/fields`, { method: 'POST', body: field });
}

/**
 * Patch live items in bulk. Writing to /items/live updates the published item
 * directly, so no separate publish call is needed for these fields.
 */
async function updateLiveItems(collectionId, items) {
  if (items.length === 0) return { items: [] };
  const out = [];
  // The API accepts up to 100 items per call.
  for (let i = 0; i < items.length; i += 100) {
    const batch = items.slice(i, i + 100);
    const res = await request(`/collections/${collectionId}/items/live`, {
      method: 'PATCH',
      body: { items: batch },
    });
    out.push(...(res.items || []));
  }
  return { items: out };
}

async function publishSite(siteId, { customDomains = [], publishToWebflowSubdomain = true } = {}) {
  return request(`/sites/${siteId}/publish`, {
    method: 'POST',
    body: { customDomains, publishToWebflowSubdomain },
  });
}

module.exports = {
  listItems,
  getCollection,
  createField,
  updateLiveItems,
  publishSite,
};
