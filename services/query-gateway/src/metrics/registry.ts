/**
 * Minimal Prometheus metrics (text exposition format 0.0.4) without a
 * dependency: counters, gauges and histograms with fixed label names.
 *
 * Label rule: only low-cardinality values (backend, route class, status
 * code). Never tenant keys, user names, query strings or raw paths.
 */

type Labels = Record<string, string>;

function escapeLabel(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/"/g, '\\"');
}

function formatLabels(labels: Labels): string {
  const entries = Object.entries(labels);

  if (entries.length === 0) {
    return '';
  }

  return `{${entries
    .map(([key, value]) => `${key}="${escapeLabel(value)}"`)
    .join(',')}}`;
}

function formatNumber(value: number): string {
  if (value === Infinity) {
    return '+Inf';
  }

  if (value === -Infinity) {
    return '-Inf';
  }

  return Number.isNaN(value) ? 'NaN' : String(value);
}

abstract class Metric<L extends string> {
  constructor(
    readonly name: string,
    readonly help: string,
    readonly labelNames: readonly L[],
  ) {}

  protected key(labels: Record<L, string>): string {
    return this.labelNames.map((name) => labels[name] ?? '').join('\u0000');
  }

  protected labelsOf(key: string): Labels {
    const values = key.split('\u0000');
    const labels: Labels = {};

    this.labelNames.forEach((name, index) => {
      labels[name] = values[index] ?? '';
    });

    return labels;
  }

  abstract render(): string[];
}

export class Counter<L extends string = never> extends Metric<L> {
  private readonly values = new Map<string, number>();

  inc(labels: Record<L, string>, by = 1): void {
    const key = this.key(labels);

    this.values.set(key, (this.values.get(key) ?? 0) + by);
  }

  render(): string[] {
    const lines = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} counter`,
    ];

    for (const [key, value] of this.values) {
      lines.push(
        `${this.name}${formatLabels(this.labelsOf(key))} ${formatNumber(value)}`,
      );
    }

    return lines;
  }
}

export class Gauge<L extends string = never> extends Metric<L> {
  private readonly values = new Map<string, number>();

  constructor(
    name: string,
    help: string,
    labelNames: readonly L[],
    /** Called right before rendering (for values read on demand). */
    private readonly collect?: (gauge: Gauge<L>) => void,
  ) {
    super(name, help, labelNames);
  }

  set(labels: Record<L, string>, value: number): void {
    this.values.set(this.key(labels), value);
  }

  inc(labels: Record<L, string>, by = 1): void {
    const key = this.key(labels);

    this.values.set(key, (this.values.get(key) ?? 0) + by);
  }

  dec(labels: Record<L, string>, by = 1): void {
    this.inc(labels, -by);
  }

  render(): string[] {
    this.collect?.(this);

    const lines = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} gauge`,
    ];

    for (const [key, value] of this.values) {
      lines.push(
        `${this.name}${formatLabels(this.labelsOf(key))} ${formatNumber(value)}`,
      );
    }

    return lines;
  }
}

interface HistogramSeries {
  counts: number[];
  sum: number;
  count: number;
}

export class Histogram<L extends string = never> extends Metric<L> {
  private readonly series = new Map<string, HistogramSeries>();

  constructor(
    name: string,
    help: string,
    labelNames: readonly L[],
    readonly buckets: readonly number[],
  ) {
    super(name, help, labelNames);
  }

  observe(labels: Record<L, string>, value: number): void {
    const key = this.key(labels);
    let series = this.series.get(key);

    if (!series) {
      series = { counts: this.buckets.map(() => 0), sum: 0, count: 0 };
      this.series.set(key, series);
    }

    // Per-bucket (non-cumulative) counts; rendering makes them cumulative.
    const index = this.buckets.findIndex((bound) => value <= bound);

    if (index >= 0) {
      series.counts[index] += 1;
    }

    series.sum += value;
    series.count += 1;
  }

  render(): string[] {
    const lines = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} histogram`,
    ];

    for (const [key, series] of this.series) {
      const labels = this.labelsOf(key);
      let cumulative = 0;

      this.buckets.forEach((bound, index) => {
        cumulative += series.counts[index];
        lines.push(
          `${this.name}_bucket${formatLabels({ ...labels, le: formatNumber(bound) })} ${cumulative}`,
        );
      });

      lines.push(
        `${this.name}_bucket${formatLabels({ ...labels, le: '+Inf' })} ${series.count}`,
        `${this.name}_sum${formatLabels(labels)} ${formatNumber(series.sum)}`,
        `${this.name}_count${formatLabels(labels)} ${series.count}`,
      );
    }

    return lines;
  }
}

export class Registry {
  private readonly metrics: Metric<string>[] = [];

  register<M extends Metric<string>>(metric: M): M {
    this.metrics.push(metric);
    return metric;
  }

  render(): string {
    return `${this.metrics.flatMap((metric) => metric.render()).join('\n')}\n`;
  }
}
