// Browser-side adapter: gives the game the same db/user API it used inside Claude,
// backed by the Node.js server in server.js.
(function () {
  const api = (url, opts) => fetch(url, opts).then(async r => {
    const body = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(body.error || 'Request failed'); e.code = body.code || 'unavailable'; throw e; }
    return body;
  });
  const snap = (exists, data) => ({ exists, data: () => (data == null ? data : structuredClone(data)), metadata: { fromCache: false } });

  function stream(url, onMsg, onErr) {
    const es = new EventSource(url);
    es.onmessage = e => { try { onMsg(JSON.parse(e.data)); } catch (_) {} };
    es.onerror = () => { if (es.readyState === EventSource.CLOSED) onErr && onErr(new Error('closed')); };
    return () => es.close();
  }

  function doc(path) {
    const q = '?path=' + encodeURIComponent(path);
    let lastHolder = null;
    return {
      async get() { const r = await api('/api/doc' + q); return snap(r.exists, r.data); },
      async set(data) {
        const holder = lastHolder; lastHolder = null;
        await api('/api/doc' + q, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data, holder }) });
      },
      async delete() { await api('/api/doc' + q, { method: 'DELETE' }); },
      async acquire({ holder, ttlMs } = {}) {
        const r = await api('/api/lock' + q, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ holder, ttlMs }) });
        if (r.acquired) lastHolder = holder;
        return r;
      },
      onSnapshot(cb, onErr) { return stream('/api/subscribe' + q, m => cb(snap(m.exists, m.data)), onErr); },
    };
  }

  function collection(name) {
    let lim = 15;
    const ref = {
      orderBy() { return ref; },
      limit(n) { lim = n; return ref; },
      onSnapshot(cb, onErr) {
        return stream(`/api/subscribe?collection=${encodeURIComponent(name)}&limit=${lim}`,
          m => cb({ docs: (m.docs || []).map(d => ({ data: () => structuredClone(d) })) }), onErr);
      },
    };
    return ref;
  }

  const db = { doc, collection };

  const user = {
    async id() {
      let id = null;
      try { id = localStorage.getItem('qct-pid'); } catch (e) {}
      if (!id) {
        id = 'p_' + (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));
        try { localStorage.setItem('qct-pid', id); } catch (e) {}
      }
      return id;
    },
    async can() { return true; },
  };

  window.claude = { use: async name => (name === 'db' ? db : name === 'user' ? user : null) };
})();
