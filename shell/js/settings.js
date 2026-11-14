// Settings screen: the sources the hub pulls in from other apps and sites, managed from the couch.
// Left, the list of sources and "Add a source". Right, the focused source: what the hub has been
// blocking for it with an Allow button per host, Open, and Remove. Adding a source uses the same
// on-screen keyboard as search, with a row of address characters. Every change goes to the hub's
// API, which writes config/sources.json and reloads it; nothing is kept on the TV.

import { KEY_ROWS } from './search.js';

export const ADDRESS_KEYS = [...KEY_ROWS.slice(0, 4), ['.', '-', '/', ':', '_'], ['space', 'back', 'clear', 'next']];
const KEY_LABELS = { space: 'space', back: '⌫  delete', clear: '✕  clear', next: 'next field' };
const FEED_HOW = { jsonld: 'the lists on its page', pagedata: 'the lists on its page', rss: 'its RSS feed', sitemap: 'its video sitemap', pages: 'the list of its pages', wp: 'its WordPress list', html: 'its list page', json: 'its feed' };
const KIND_LABELS = { script: 'script', xhr: 'data', other: 'data', document: 'page', iframe: 'frame', style: 'style', image: 'image', font: 'font', media: 'video' };
const LIMITS = { name: 40, address: 200 };

const hostOf = (origin) => { try { return new URL(origin).host; } catch { return origin || ''; } };
const el = (cls, text) => { const d = document.createElement('div'); d.className = cls; if (text != null) d.textContent = text; return d; };
const focusable = (node, key) => { node.dataset.focusable = ''; node.dataset.fkey = key; return node; };

export class SettingsView {
  /**
   * @param root       the #view-settings section
   * @param say        toast
   * @param focusKey   () => the data-fkey of the focused element, if any
   * @param focusEl    (el) => move the focus ring to an element
   * @param refocus    () => pick a focus when the old one is gone
   * @param openPortal (path) => open a source's page
   * @param onSourcesChanged  () => reload the home screen's source list
   */
  constructor({ root, say, focusKey, focusEl, refocus, openPortal, onSourcesChanged }) {
    Object.assign(this, { root, say, focusKey, focusEl, refocus, openPortal, onSourcesChanged });
    this.listEl = root.querySelector('#settings-list');
    this.detailEl = root.querySelector('#settings-detail');
    this.addEl = root.querySelector('#settings-add');
    this.sources = []; this.status = null; this.selected = null;
    this.pane = 'list';                 // 'list' | 'add'
    this.draft = { name: '', address: '' }; this.field = 'name';
    this.confirmRemove = null;          // source id waiting for a second OK
  }

  async open() {
    this.pane = 'list'; this.confirmRemove = null;
    await this.refresh();
    this.render();
    this.focus(this.selected ? `source:${this.selected}` : 'add');
    clearInterval(this.poll);
    this.poll = setInterval(() => this.refreshStatus(), 5000);
  }
  close() { clearInterval(this.poll); this.poll = null; }

  async refresh() {
    try {
      [this.sources, this.status] = await Promise.all([fetch('/api/sources').then((r) => r.json()), fetch('/api/status').then((r) => r.json())]);
    } catch (e) { this.say(`Could not reach the hub: ${e.message}`); }
    if (!this.sources.some((s) => s.id === this.selected)) this.selected = this.sources[0]?.id || null;
  }
  /** Every few seconds while the list is open; redraws only when what it shows has changed. */
  async refreshStatus() {
    if (this.pane !== 'list') return;
    let status;
    try { status = await fetch('/api/status').then((r) => r.json()); } catch { return; }
    const shown = (st) => JSON.stringify([st?.blockedHosts, Object.values(st?.ingest || {}).map((i) => [i.sourceId, i.state, i.items, i.error])]);
    const changed = shown(status) !== shown(this.status);
    this.status = status;
    if (changed && this.pane === 'list') this.render();
  }

  blockedFor(id) { return this.status?.blockedHosts?.[id] || []; }
  typing() { return this.pane === 'add' || this.pane === 'start'; }

  // ---------- rendering ----------
  render() {
    const adding = this.pane === 'add' || this.pane === 'start';
    this.root.querySelector('.settings-layout').hidden = adding;
    this.addEl.hidden = !adding;
    if (adding) this.renderAdd(); else { this.renderList(); this.renderDetail(); }
    const key = this.focusKey();
    if (key && !this.focus(key)) this.refocus();
  }

  renderList() {
    const list = this.listEl; list.innerHTML = '';
    for (const s of this.sources) {
      const row = focusable(el('srow' + (s.id === this.selected ? ' selected' : '')), `source:${s.id}`);
      row.dataset.source = s.id;
      const blocked = this.blockedFor(s.id).length;
      row.append(el('srow-name', s.name), el('srow-sub', hostOf(s.origin) + (blocked ? ` · ${blocked} blocked` : '')));
      list.appendChild(row);
    }
    const add = focusable(el('srow add'), 'add');
    add.dataset.add = '';
    add.append(el('srow-name', 'Add a source'), el('srow-sub', 'Another app or site the hub should pull in'));
    list.appendChild(add);
  }

  renderDetail() {
    const d = this.detailEl; d.innerHTML = '';
    const s = this.sources.find((x) => x.id === this.selected);
    if (!s) { d.appendChild(el('settings-empty', 'No sources yet. Choose "Add a source" to put in the first app or site.')); return; }
    const h = document.createElement('h2'); h.textContent = s.name; d.appendChild(h);
    d.appendChild(el('muted', hostOf(s.origin)));
    const ing = this.status?.ingest?.[s.id];
    if (s.feed) d.appendChild(el('detail-line', ing ? (ing.state === 'running' ? 'Pulling its titles now.' : ing.error ? `Its titles could not be pulled: ${ing.error}` : `${ing.items} titles pulled from ${FEED_HOW[s.feed?.type] || 'its feed'}; they are on the home screen.`) : `Titles come from ${FEED_HOW[s.feed?.type] || 'its feed'}; not pulled yet.`));
    else d.appendChild(el('detail-line', 'Opens as a page. No list of titles has been found for it yet, so nothing from it is on the home screen.'));

    const h3 = document.createElement('h3'); h3.textContent = 'Blocked for this source'; d.appendChild(h3);
    const blocked = this.blockedFor(s.id);
    if (!blocked.length) d.appendChild(el('detail-hint', 'Nothing blocked since the hub started. If this source shows a blank page or no player, open it, then come back here and allow what it needs.'));
    else d.appendChild(el('detail-hint', 'Hosts this source asked for that the hub refused. Allow one if the source needs it; ads and trackers are better left blocked.'));
    for (const b of blocked) {
      const row = el('brow');
      const kinds = [...new Set(b.kinds.map((k) => KIND_LABELS[k] || k))].join(', ');
      row.append(el('brow-host', b.host), el('brow-sub', `${b.count} request${b.count === 1 ? '' : 's'} · ${kinds}`));
      const btn = focusable(el('btn', 'Allow'), `allow:${b.host}`); btn.dataset.allow = b.host;
      row.appendChild(btn);
      d.appendChild(row);
    }

    d.appendChild(el('detail-line', `Start page: ${s.startPage || '/'}` + (s.userAgent === 'tv' ? ' (opened as a TV)' : '')));
    const actions = el('btn-row');
    const open = focusable(el('btn', 'Open'), 'open'); open.dataset.open = s.home;
    const start = focusable(el('btn', 'Start page'), 'startpage'); start.dataset.startpage = s.id;
    actions.append(start);
    const titles = focusable(el('btn', s.feed ? 'Pull titles now' : 'Find its titles'), 'titles'); titles.dataset.titles = s.id; titles.dataset.feed = s.feed ? '1' : '';
    actions.append(titles);
    const remove = focusable(el('btn danger', this.confirmRemove === s.id ? 'Press OK again to remove' : 'Remove this source'), 'remove'); remove.dataset.remove = s.id;
    actions.append(open, remove);
    d.appendChild(actions);
  }

  renderAdd() {
    const a = this.addEl; a.innerHTML = '';
    const editing = this.pane === 'start';
    const h = document.createElement('h2'); h.textContent = editing ? 'Start page' : 'Add a source'; a.appendChild(h);
    a.appendChild(el('muted detail-hint', editing ? 'The page the hub opens first for this source, on the same site: a path like /tv or /feed/trending, or / for its front page.' : 'Only add apps and sites you are entitled to use. The hub opens them through its own cleaning proxy.'));
    const fields = editing ? [['address', 'Start page', 'A path on the site, like /tv']] : [['name', 'Name', 'What to call it on the home screen'], ['address', 'Address', 'The site, like pluto.tv or tubitv.com']];
    for (const [name, label, hint] of fields) {
      const f = focusable(el('field' + (this.field === name ? ' active' : '')), `field:${name}`); f.dataset.field = name;
      f.append(el('field-label', label), el('field-value'), el('field-hint', hint + '. Back deletes a letter.'));
      a.appendChild(f);
    }
    this.renderFields();
    const kb = el('keyboard');
    for (const keys of ADDRESS_KEYS) {
      const r = el('krow');
      for (const k of keys) {
        const b = focusable(el('key' + (k.length > 1 ? ' wide ' + k : '')), `key:${k}`); b.dataset.key = k;
        b.textContent = KEY_LABELS[k] || k;
        r.appendChild(b);
      }
      kb.appendChild(r);
    }
    a.appendChild(kb);
    const actions = el('btn-row');
    const save = focusable(el('btn primary', 'Save'), 'save'); save.dataset.save = '';
    const cancel = focusable(el('btn', 'Cancel'), 'cancel'); cancel.dataset.cancel = '';
    actions.append(save, cancel);
    a.appendChild(actions);
  }
  /** The two field values, updated in place so typing never rebuilds the keyboard under the focus. */
  renderFields() {
    for (const f of this.addEl.querySelectorAll('.field')) {
      const name = f.dataset.field;
      f.classList.toggle('active', this.field === name);
      const v = f.querySelector('.field-value'); v.textContent = this.draft[name];
      if (this.field === name) v.appendChild(Object.assign(document.createElement('span'), { className: 'caret' }));
    }
  }

  focus(key) {
    const target = this.root.querySelector(`[data-fkey="${CSS.escape(key)}"]`);
    if (!target) return false;
    this.focusEl(target);
    return true;
  }

  // ---------- the remote ----------
  /** Focus moved: the detail pane follows the source under focus. */
  onFocus(node) {
    const id = node?.dataset?.source;
    if (!id || id === this.selected) return;
    this.selected = id; this.confirmRemove = null;
    for (const r of this.listEl.querySelectorAll('.srow')) r.classList.toggle('selected', r.dataset.source === id);
    this.renderDetail();
  }

  async select(node) {
    if (!node) return;
    const d = node.dataset;
    if (d.source != null) { this.selected = d.source; if (!this.focus(this.blockedFor(d.source).length ? `allow:${this.blockedFor(d.source)[0].host}` : 'open')) this.focus('remove'); return; }
    if (d.add != null) { this.pane = 'add'; this.draft = { name: '', address: '' }; this.field = 'name'; this.render(); this.focus('key:q'); return; }
    if (d.open) { this.openPortal(d.open); return; }
    if (d.startpage) { this.pane = 'start'; this.editing = d.startpage; const s = this.sources.find((x) => x.id === d.startpage); this.draft = { name: s?.name || '', address: s?.startPage || '/' }; this.field = 'address'; this.render(); this.focus('key:q'); return; }
    if (d.allow) return this.allow(this.selected, d.allow);
    if (d.titles) return d.feed ? this.pull(d.titles) : this.discover(d.titles);
    if (d.remove) return this.remove(d.remove);
    if (d.field) { this.field = d.field; this.renderFields(); this.focus('key:q'); return; }
    if (d.key) return this.key(d.key);
    if (d.save != null) return this.pane === 'start' ? this.saveStartPage() : this.save();
    if (d.cancel != null) { this.pane = 'list'; this.render(); this.focus('add'); }
  }

  /** Back: delete a character while typing, leave the add form, or cancel a pending remove. False means the screen itself should close. */
  back() {
    if (this.pane === 'add' || this.pane === 'start') {
      if (this.draft[this.field]) { this.draft[this.field] = this.draft[this.field].slice(0, -1); this.renderFields(); return true; }
      this.pane = 'list'; this.render(); this.focus('add'); return true;
    }
    if (this.confirmRemove) { this.confirmRemove = null; this.render(); return true; }
    return false;
  }

  key(k) {
    if (k === 'space') this.typeChar(' ');
    else if (k === 'back') { this.draft[this.field] = this.draft[this.field].slice(0, -1); this.renderFields(); }
    else if (k === 'clear') { this.draft[this.field] = ''; this.renderFields(); }
    else if (k === 'next') { if (this.field === 'name') { this.field = 'address'; this.renderFields(); this.focus('key:q'); } else this.focus('save'); }
    else this.typeChar(k);
  }
  typeChar(ch) {
    if (this.pane !== 'add') return;
    const f = this.field;
    this.draft[f] = (this.draft[f] + (f === 'address' ? ch.trim() : ch)).slice(0, LIMITS[f]);
    this.renderFields();
  }

  async saveStartPage() {
    const id = this.editing, home = this.draft.address.trim() || '/';
    let r, body;
    try { r = await fetch(`/api/sources/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ home }) }); body = await r.json(); }
    catch (e) { return this.say(`Could not save: ${e.message}`); }
    if (!r.ok) return this.say(body.error || `Could not save (HTTP ${r.status})`);
    this.say(`${body.name} now starts at ${body.startPage}`);
    this.pane = 'list'; this.selected = id;
    await this.refresh(); this.onSourcesChanged(); this.render(); this.focus(`source:${id}`);
  }

  async save() {
    const name = this.draft.name.trim(), address = this.draft.address.trim();
    if (!name) { this.say('Give the source a name first.'); this.field = 'name'; this.renderFields(); return this.focus('field:name'); }
    if (!address) { this.say('Type the address of the site.'); this.field = 'address'; this.renderFields(); return this.focus('field:address'); }
    let r, body;
    try { r = await fetch('/api/sources', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, address }) }); body = await r.json(); }
    catch (e) { return this.say(`Could not save: ${e.message}`); }
    if (!r.ok) return this.say(body.error || `Could not save (HTTP ${r.status})`);
    this.pane = 'list'; this.selected = body.id;
    await this.refresh(); this.onSourcesChanged(); this.render(); this.focus(`source:${body.id}`);
    this.say(`Added ${body.name}. Looking for its titles...`);
    await this.discover(body.id, { quiet: true });
  }

  /** Ask the hub to work out where this source's titles can be pulled from, then pull them. */
  async discover(id, { quiet = false } = {}) {
    const s = this.sources.find((x) => x.id === id);
    if (!quiet) this.say(`Looking for the titles on ${s?.name || id}. This can take a few seconds.`);
    let r, body;
    try { r = await fetch(`/api/sources/${encodeURIComponent(id)}/discover`, { method: 'POST' }); body = await r.json(); }
    catch (e) { return this.say(`Could not look: ${e.message}`); }
    if (!r.ok) return this.say(body.error || `Could not look (HTTP ${r.status})`);
    if (body.found) this.say(`Found the titles on ${s?.name || id} in ${body.how}. They are being pulled in and will show on the home screen.`);
    else this.say(`No list of titles was found on ${s?.name || id}. It stays as a page you can open.`);
    await this.refresh(); this.onSourcesChanged(); this.render();
  }

  async pull(id) {
    const s = this.sources.find((x) => x.id === id);
    this.say(`Pulling the titles from ${s?.name || id}...`);
    try { await fetch(`/api/ingest/run?source=${encodeURIComponent(id)}`, { method: 'POST' }); } catch (e) { return this.say(`Could not pull: ${e.message}`); }
    await this.refresh(); this.onSourcesChanged(); this.render();
    const ing = this.status?.ingest?.[id];
    this.say(ing?.error ? `Could not pull the titles: ${ing.error}` : `Pulled ${ing?.items ?? 0} titles from ${s?.name || id}.`);
  }

  async allow(id, host) {
    const s = this.sources.find((x) => x.id === id);
    let r, body;
    try { r = await fetch(`/api/sources/${encodeURIComponent(id)}/allow`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ host }) }); body = await r.json(); }
    catch (e) { return this.say(`Could not allow it: ${e.message}`); }
    if (!r.ok) return this.say(body.error || `Could not allow it (HTTP ${r.status})`);
    this.say(`Allowed ${body.site} for ${s?.name || id}. Open it again to check.`);
    try { this.status = await fetch('/api/status').then((x) => x.json()); } catch {}
    this.render();
    const left = this.blockedFor(id);
    this.focus(left.length ? `allow:${left[0].host}` : 'open');
  }

  async remove(id) {
    const s = this.sources.find((x) => x.id === id);
    if (this.confirmRemove !== id) { this.confirmRemove = id; this.render(); this.say(`Press OK again to remove ${s?.name || id}`); return; }
    this.confirmRemove = null;
    let r;
    try { r = await fetch(`/api/sources/${encodeURIComponent(id)}`, { method: 'DELETE' }); } catch (e) { return this.say(`Could not remove it: ${e.message}`); }
    if (!r.ok) return this.say(`Could not remove it (HTTP ${r.status})`);
    this.say(`Removed ${s?.name || id}`);
    this.selected = null;
    await this.refresh(); this.onSourcesChanged(); this.render();
    this.focus(this.selected ? `source:${this.selected}` : 'add');
  }
}
