// One debit, one process. Spawned in parallel by concurrency-check.js.
//
// It has to be a separate process to prove anything: node:sqlite is synchronous,
// so ten "concurrent" debits inside a single process would simply run one after
// another and pass trivially. Real processes contend for the same file lock,
// which is the situation the guard actually has to survive.
//
// Usage: node debit-once.js <dbPath> <studentId> <amount>
const { Ledger } = require('../ledger');

const [, , dbPath, studentId, amountArg] = process.argv;
const ledger = new Ledger(dbPath);
try {
  const result = ledger.debit(studentId, Number(amountArg));
  process.stdout.write(JSON.stringify(result));
} catch (err) {
  process.stdout.write(JSON.stringify({ ok: false, reason: 'error', message: err.message }));
} finally {
  ledger.close();
}
