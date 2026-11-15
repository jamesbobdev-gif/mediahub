// When is a portal frame dead? The timing rules behind portal.js, kept free of the DOM so they
// can be tested. A page announces itself once (hub:ready) and then answers pings; the shell
// treats a frame as gone when a page that loaded never announced itself, or when a page that did
// announce itself goes silent. A heavy page gets seconds, not milliseconds, and a page that just
// navigated (some reload themselves once) is given the same patience again.

export class FrameWatch {
  /**
   * @param readyWaitMs  how long a page may take after its load event to announce itself
   * @param stallMs      how long a page may take to fire a load event at all
   * @param silentMs     how long an announced page may stay silent before it counts as gone
   */
  constructor({ readyWaitMs = 4000, stallMs = 20000, silentMs = 4000 } = {}) {
    Object.assign(this, { readyWaitMs, stallMs, silentMs });
    this.load(0);
  }

  /** The frame was pointed at a page. */
  load(now) {
    this.loadAt = now; this.loadedAt = null; this.readyAt = null; this.lastSeen = now; this.readyPending = false;
  }

  /** The frame's load event. A ready that came just before it belongs to this load. */
  loaded(now) {
    this.lastSeen = now;
    if (this.readyPending) { this.readyPending = false; return; }
    this.loadedAt = now;
  }

  /** hub:ready from the page. If no load event is waiting for it, the next one will consume it. */
  ready(now) {
    this.lastSeen = now; this.readyAt = now;
    if (this.loadedAt != null) this.loadedAt = null; else this.readyPending = true;
  }

  /** Any message from the page: it is alive. A load event with no new page behind it (the Fire TV
   *  browser fires one for a page that is still there) is forgotten once the announced page talks
   *  again; a page that really navigated away cannot talk, so it still counts as dead. */
  message(now) {
    this.lastSeen = now;
    if (this.readyAt != null && this.loadedAt != null) this.loadedAt = null;
  }

  /** Seconds since the page last said anything. */
  silence(now) { return Math.max(0, now - this.lastSeen) / 1000; }

  /** 'loading' while a page is being fetched or has just navigated, 'ok' while it talks, 'dead' when it does not. */
  state(now) {
    if (this.loadedAt != null) return now - this.loadedAt > this.readyWaitMs ? 'dead' : 'loading';   // loaded, not yet announced
    if (this.readyAt == null) return now - this.loadAt > this.stallMs ? 'dead' : 'loading';         // nothing from it yet
    return now - this.lastSeen > this.silentMs ? 'dead' : 'ok';
  }
}
