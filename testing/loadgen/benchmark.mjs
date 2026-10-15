// Offline encoder check, NOT a measurement of gateway/storage capacity or pod CPU limits.
import { performance } from 'node:perf_hooks';
import { metricsPayload } from './model.mjs';

for (const hosts of [100, 1000, 10000]) {
  const before = performance.now(); const started = Date.now() - 60000;
  let bytes = 0, peakRss = 0;
  for (let start = 0; start < hosts; start += 10) {
    const ids = Array.from({ length: Math.min(10, hosts - start) }, (_, i) => start + i);
    bytes += Buffer.byteLength(JSON.stringify(metricsPayload('benchmark', ids, Date.now(), started)));
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }
  console.log(JSON.stringify({ hosts, dataPoints: hosts * 10, encodedBytes: bytes,
    encoderMilliseconds: Math.round(performance.now() - before), peakRssMi: Math.round(peakRss / 1024 ** 2) }));
}
