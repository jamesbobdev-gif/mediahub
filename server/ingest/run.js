// One-shot ingestion for cron or CI: run every source once and print a summary.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSources } from '../sources.js';
import { Catalog } from './catalog.js';
import { Scheduler } from './scheduler.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sources = loadSources(path.join(root, 'config', 'sources.json'));
const catalog = new Catalog(path.join(root, 'data', 'catalog.sqlite'));
const sched = new Scheduler({ sources, catalog, log: (...a) => console.log('[ingest]', ...a) });
const results = await Promise.all([...sources.keys()].map((id) => sched.run(id)));
sched.stop();
console.table(results.map(({ sourceId, pages, items, inserted, merged, error }) => ({ sourceId, pages, items, inserted, merged, error })));
console.log('catalog items:', catalog.count());
catalog.close();
