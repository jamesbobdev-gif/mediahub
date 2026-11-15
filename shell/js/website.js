// Open a website: type any web address on the TV (or in a phone or PC browser pointed at the hub)
// and it opens at once through the hub's cleaning proxy, without being saved as a source first.
// Left, the address field with the same on-screen keyboard as Settings. Right, the websites opened
// lately, each with Open and "Save as a source". The hub keeps an opened website in memory only
// (POST /api/open), so an old entry is simply opened afresh; the list itself lives in this
// browser's localStorage, like resume positions. Saving goes through POST /api/sources, the same
// call the Settings screen makes.

import { KEY_ROWS } from './search.js';

export const WEBSITE_KEYS = [...KEY_ROWS.slice(0, 4), ['.', '-', '/', ':', '_', '?', '=', '&'], ['space', 'back', 'clear', 'go']];
const KEY_LABELS = { space: 'space', back: '⌫  delete', clear: '✕  clear', go: 'open' };
const STORE = 'hub:websites';
const RECENT_MAX = 12;
const ADDRESS_MAX = 200;

const el = (cls, text) => { const d = document.createElement('div'); d.className = cls; if (text != null) d.textContent = text; return d; };
const focusable = (node, key) => { node.dataset.focusable = ''; node.dataset.fkey = key; return node; };
const loadRecent = () => { try { const l = JSON.parse(localStorage.getItem(STORE) || '[]'); return Array.isArray(l) ? l : []; } catch { return []; } };
const storeRecent = (list) => { try { localStorage.setItem(STORE, JSON.stringify(list)); } catch {} };

/** The list with one website put (back) at the top: the same address once, the newest first. */
export function remember(list, entry, max = RECENT_MAX) {
  return [entry, ...list.filter((x) => x.address !== entry.address)].slice(0, max);
}

export class WebsiteView {
  /**
   * @param root       the #view-website section
   * @param say        toast
   * @param focusKey   () => the data-fkey of the focused element, if any
   * @param focusEl    (el) => move the focus ring to an element
   * @param refocus    () => pick a focus when the old one is gone
   * @param openPortal (path) => open a hub page in the portal frame
   * @param close      () => leave the screen
   * @param onSourcesChanged  () => reload the home screen's source list
   */
  constructor({ root, say, focusKey, focusEl, refocus, openPortal, close, onSourcesChanged }) {
    Object.assign(this, { root, say, focusKey, focusEl, refocus, openPortal, close, onSourcesChanged });
    this.pane = root.querySelector('#website-pane');
    this.draft = '';
    this.recent = loadRecent();
    this.busy = false;
  }

  open() {
    this.recent = loadRecent();
    this.render();
    this.focus('key:q');
  }
  typing() { return true; }

  // ---------- rendering ----------
  render() {
    const p = this.pane; p.innerHTML = '';
    const left = el('website-left');
    left.appendChild(el('muted detail-hint', 'Type the address of any website. The hub opens it with the ads, pop-ups and other sites\' scripts stripped out. Nothing is saved unless you choose to.'));
    const f = focusable(el('field active'), 'field'); f.dataset.field = '';
    f.append(el('field-label', 'Address'), el('field-value'), el('field-hint', 'Like bbc.com/news or archive.org. Back deletes a letter.'));
    left.appendChild(f);
    const kb = el('keyboard');
    for (const keys of WEBSITE_KEYS) {
      const r = el('krow');
      for (const k of keys) {
        const b = focusable(el('key' + (k.length > 1 ? ' wide ' + k : '')), `key:${k}`); b.dataset.key = k;
        b.textContent = KEY_LABELS[k] || k;
        r.appendChild(b);
      }
      kb.appendChild(r);
    }
    left.appendChild(kb);
    const actions = el('btn-row');
    const go = focusable(el('btn primary', 'Open'), 'go'); go.dataset.go = '';
    const cancel = focusable(el('btn', 'Cancel'), 'cancel'); cancel.dataset.cancel = '';
    actions.append(go, cancel);
    left.appendChild(actions);
    p.appendChild(left);

    const right = el('website-recent');
    const h3 = document.createElement('h3'); h3.textContent = 'Opened lately'; right.appendChild(h3);
    if (!this.recent.length) right.appendChild(el('detail-hint', 'Websites you open show up here, so you can go back to them or save one as a source on the home screen.'));
    for (const w of this.recent) {
      const row = el('brow');
      row.append(el('brow-host', w.name || w.address), el('brow-sub', w.address));
      const open = focusable(el('btn', 'Open'), `open:${w.address}`); open.dataset.open = w.address;
      const save = focusable(el('btn', w.saved ? 'Saved' : 'Save as a source'), `save:${w.address}`); save.dataset.save = w.address;
      const forget = focusable(el('btn', 'Forget'), `forget:${w.address}`); forget.dataset.forget = w.address;
      row.append(open, save, forget);
      right.appendChild(row);
    }
    p.appendChild(right);
    this.renderField();
    const key = this.focusKey();
    if (key && !this.focus(key)) this.refocus();
  }
  /** The address, updated in place so typing never rebuilds the keyboard under the focus. */
  renderField() {
    const v = this.pane.querySelector('.field-value'); if (!v) return;
    v.textContent = this.draft;
    v.appendChild(Object.assign(document.createElement('span'), { className: 'caret' }));
  }
  focus(key) {
    const target = this.root.querySelector(`[data-fkey="${CSS.escape(key)}"]`);
    if (!target) return false;
    this.focusEl(target);
    return true;
  }

  // ---------- the remote ----------
  select(node) {
    if (!node) return;
    const d = node.dataset;
    if (d.key) return this.key(d.key);
    if (d.field != null) return this.focus('key:q');
    if (d.go != null) return this.go(this.draft);
    if (d.cancel != null) return this.close();
    if (d.open) return this.go(d.open);
    if (d.save) return this.save(d.save);
    if (d.forget) return this.forget(d.forget);
  }
  /** Back: delete a character while there is one; false means the screen itself should close. */
  back() {
    if (!this.draft) return false;
    this.draft = this.draft.slice(0, -1); this.renderField();
    return true;
  }
  key(k) {
    if (k === 'space') this.typeChar(' ');
    else if (k === 'back') { this.draft = this.draft.slice(0, -1); this.renderField(); }
    else if (k === 'clear') { this.draft = ''; this.renderField(); }
    else if (k === 'go') this.go(this.draft);
    else this.typeChar(k);
  }
  typeChar(ch) {
    if (ch === '\n' || ch === '\r') return;
    this.draft = (this.draft + ch.trim()).slice(0, ADDRESS_MAX);
    this.renderField();
  }

  /** Ask the hub to open the address, remember it, and show it in the portal frame. */
  async go(address) {
    address = String(address || '').trim();
    if (!address) { this.say('Type the address of a website first.'); return this.focus('key:q'); }
    if (this.busy) return;
    this.busy = true;
    this.say(`Opening ${address}...`);
    let r, body;
    try { r = await fetch('/api/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address }) }); body = await r.json(); }
    catch (e) { this.busy = false; return this.say(`Could not open it: ${e.message}`); }
    this.busy = false;
    if (!r.ok) return this.say(body.error || `Could not open it (HTTP ${r.status})`);
    this.recent = remember(this.recent, { address: body.address, name: body.name, saved: !!body.saved, at: Date.now() });
    storeRecent(this.recent);
    this.draft = '';
    this.openPortal(body.home);
  }

  /** Make it a real source: on the home screen, in Settings, with its own titles if the hub finds any. */
  async save(address) {
    const w = this.recent.find((x) => x.address === address);
    if (w?.saved) return this.say(`${w.name} is already a source on the home screen.`);
    const name = w?.name || address.split('/')[0];
    let r, body;
    try { r = await fetch('/api/sources', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, address }) }); body = await r.json(); }
    catch (e) { return this.say(`Could not save it: ${e.message}`); }
    if (!r.ok) return this.say(body.error || `Could not save it (HTTP ${r.status})`);
    this.recent = this.recent.map((x) => x.address === address ? { ...x, saved: true, name: body.name } : x);
    storeRecent(this.recent);
    this.onSourcesChanged();
    this.render();
    this.focus(`open:${address}`);
    this.say(`Saved ${body.name} as a source. It is on the home screen now, and the hub is looking for its titles.`);
    fetch(`/api/sources/${encodeURIComponent(body.id)}/discover`, { method: 'POST' }).catch(() => {});
  }

  forget(address) {
    this.recent = this.recent.filter((x) => x.address !== address);
    storeRecent(this.recent);
    this.render();
    if (!this.focus(this.recent.length ? `open:${this.recent[0].address}` : 'key:q')) this.refocus();
  }
}
