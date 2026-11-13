// Runs the storage migration on a database, one batch at a time, printing "batch <n>" after each committed batch
// (tests kill this process between or during batches). argv: <dbPath> <batchRows>.
import { migrateBatch } from '../../src/store/migrate-storage.ts';
import { openStore } from '../../src/store/store.ts';

const [dbPath, rows] = process.argv.slice(2);
const store = openStore(dbPath);
let n = 0;
for (;;) {
  const { more } = migrateBatch(store, { batchRows: Number(rows) });
  n += 1;
  process.stdout.write(`batch ${n}\n`);
  if (!more) break;
}
store.close();
process.stdout.write('done\n');
