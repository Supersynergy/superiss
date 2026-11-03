import { refreshProjection, type ReportKind } from './bridge.ts';

const [source, destination, kind, rawLimit, token] = process.argv.slice(2);
try {
  if (process.argv.length !== 7 || !source || !destination || !token || !/^[a-f0-9]{32}$/u.test(token)) throw Error('Invalid private analytics invocation');
  process.stdout.write(JSON.stringify({ type: 'started', token, pid: process.pid }) + '\n');
  const data = refreshProjection(source, destination, kind as ReportKind, Number(rawLimit));
  process.stdout.write(JSON.stringify({ type: 'result', token, data }) + '\n');
} catch (error) { process.stderr.write(String(error) + '\n'); process.exitCode = 1; }
