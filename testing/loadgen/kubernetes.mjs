import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export const MANAGER = 'mtco-loadgen';
export const RUN_LABEL = 'mtco.test/run';
export function labels(run) {
  return { 'app.kubernetes.io/part-of': 'mtco-testing', 'app.kubernetes.io/managed-by': MANAGER, [RUN_LABEL]: run };
}
export function selector(run) {
  return `app.kubernetes.io/managed-by=${MANAGER},${RUN_LABEL}=${run}`;
}
export function assertOwned(object, run) {
  if (Object.entries(labels(run)).some(([key, value]) => object.metadata?.labels?.[key] !== value)) {
    throw new Error('Resource name collision: refusing to modify a resource not owned by this run');
  }
}

export class Kubernetes {
  constructor(namespace, execute = spawnSync) { this.namespace = namespace; this.execute = execute; }
  call(args, input) {
    const result = this.execute('kubectl', ['-n', this.namespace, ...args], {
      input: input === undefined ? undefined : JSON.stringify(input), encoding: 'utf8',
      timeout: args[0] === 'delete' ? 90000 : 30000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
    });
    if (result.error || result.status !== 0) {
      // Kubernetes errors can echo a submitted Secret. Never print stderr/stdout here.
      throw new Error(`Kubernetes operation failed: ${args[0]} ${args[1] ?? ''} (exit ${result.status ?? 'unavailable'}); check context, permissions and resource status`);
    }
    return result.stdout.trim();
  }
  get(kind, resourceName) {
    const value = this.call(['get', kind, resourceName, '--ignore-not-found', '-o', 'json']);
    return value ? JSON.parse(value) : null;
  }
  list(kind, run) { return JSON.parse(this.call(['get', kind, '-l', selector(run), '-o', 'json'])).items; }
  create(object) { this.call(['create', '-f', '-', '-o', 'name'], object); }
  replace(object) { this.call(['replace', '-f', '-', '-o', 'name'], object); }
  suspend(job) { this.call(['patch', 'job', job, '--type=merge', '-p', '{"spec":{"suspend":true}}']); }
  delete(kind, resourceName) { this.call(['delete', kind, resourceName, '--ignore-not-found', '--wait=true', '--timeout=60s']); }
}

export async function sourceData() {
  const names = ['config.mjs', 'model.mjs', 'transport.mjs', 'worker.mjs'];
  return Object.fromEntries(await Promise.all(names.map(async (file) => [file, await readFile(new URL(file, import.meta.url), 'utf8')])));
}

export function configMap(config, namespace, sources) {
  const data = { ...sources, 'scenario.json': JSON.stringify(config) };
  const digest = createHash('sha256').update(JSON.stringify(data)).digest('hex');
  return {
    apiVersion: 'v1', kind: 'ConfigMap', immutable: true,
    metadata: { name: `mtco-load-${config.run}`, namespace, labels: labels(config.run), annotations: { 'mtco.test/digest': digest } }, data,
  };
}

export function job(config, namespace, image, mode, suffix = '') {
  const base = `mtco-load-${config.run}`;
  const isProbe = mode === 'probe';
  const count = isProbe ? 1 : config.pods;
  return {
    apiVersion: 'batch/v1', kind: 'Job',
    metadata: { name: `${base}${isProbe ? `-probe-${suffix}` : ''}`, namespace, labels: labels(config.run) },
    spec: {
      completionMode: 'Indexed', completions: count, parallelism: count,
      backoffLimit: 0, activeDeadlineSeconds: isProbe ? 120 : config.durationSeconds + config.rampSeconds + 180,
      template: {
        metadata: { labels: { ...labels(config.run), 'mtco.test/mode': mode } },
        spec: {
          restartPolicy: 'Never', automountServiceAccountToken: false,
          terminationGracePeriodSeconds: 15,
          securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000, seccompProfile: { type: 'RuntimeDefault' } },
          containers: [{
            name: 'generator', image, imagePullPolicy: 'IfNotPresent',
            command: ['node', '--max-old-space-size=64', '/config/worker.mjs'],
            env: [
              { name: 'MODE', value: mode },
              { name: 'WORKER_INDEX', valueFrom: { fieldRef: { fieldPath: "metadata.annotations['batch.kubernetes.io/job-completion-index']" } } },
            ],
            resources: { requests: { cpu: '50m', memory: '64Mi' }, limits: { cpu: '250m', memory: '128Mi' } },
            securityContext: { readOnlyRootFilesystem: true, allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } },
            volumeMounts: [
              { name: 'config', mountPath: '/config', readOnly: true },
              { name: 'credentials', mountPath: '/credentials', readOnly: true },
            ],
          }],
          volumes: [
            { name: 'config', configMap: { name: base, defaultMode: 292 } },
            { name: 'credentials', secret: { secretName: `${base}-credentials`, defaultMode: 288, items: [{ key: 'credentials.json', path: 'credentials.json' }] } },
          ],
          topologySpreadConstraints: [{
            maxSkew: 1, topologyKey: 'kubernetes.io/hostname', whenUnsatisfiable: 'ScheduleAnyway',
            labelSelector: { matchLabels: { ...labels(config.run), 'mtco.test/mode': mode } },
          }],
        },
      },
    },
  };
}
