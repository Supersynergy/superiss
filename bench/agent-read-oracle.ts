import { readFileSync } from 'node:fs';
const [manifestPath, output] = process.argv.slice(2);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const result = JSON.parse(readFileSync(output, 'utf8'));
if (result.calls !== manifest.rounds * manifest.requests.length) throw Error('Missing calls');
for (let i = 0; i < result.rows.length; i++) {
  const wanted = manifest.requests[i % manifest.requests.length];
  const actual = result.rows[i];
  if (actual.cmd !== wanted.cmd || JSON.stringify(actual.value) !== JSON.stringify(wanted.expected)) throw Error('Read acceptance failed at row ' + i);
}
console.log(JSON.stringify({accepted: true, calls: result.calls}));
