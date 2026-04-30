const DEFAULT_LABELS = Object.freeze({
  service: 'livekit-token-api',
});

function escapeLabelValue(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/"/g, '\\"');
}

function formatLabels(labels) {
  const mergedLabels = { ...DEFAULT_LABELS, ...labels };
  const entries = Object.entries(mergedLabels)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .sort(([left], [right]) => left.localeCompare(right));

  if (entries.length === 0) {
    return '';
  }

  return `{${entries.map(([key, value]) => `${key}="${escapeLabelValue(value)}"`).join(',')}}`;
}

function getMetricKey(name, labels) {
  return `${name}|${JSON.stringify(labels)}`;
}

function createMetricsRegistry() {
  const counters = new Map();

  function increment(name, labels = {}, value = 1) {
    const key = getMetricKey(name, labels);
    const current = counters.get(key) ?? 0;
    counters.set(key, current + value);
  }

  function observeDuration(name, labels = {}, durationMs = 0) {
    increment(`${name}_count`, labels, 1);
    increment(`${name}_sum`, labels, durationMs);
  }

  function render() {
    const lines = [
      '# HELP voip_http_requests_total HTTP requests handled by the token API.',
      '# TYPE voip_http_requests_total counter',
      '# HELP voip_http_request_duration_ms_count Count of HTTP request durations in milliseconds.',
      '# TYPE voip_http_request_duration_ms_count counter',
      '# HELP voip_http_request_duration_ms_sum Sum of HTTP request durations in milliseconds.',
      '# TYPE voip_http_request_duration_ms_sum counter',
      '# HELP voip_token_requests_total Token issuance attempts grouped by result.',
      '# TYPE voip_token_requests_total counter',
      '# HELP voip_livekit_webhook_receive_total LiveKit webhook delivery attempts grouped by result.',
      '# TYPE voip_livekit_webhook_receive_total counter',
      '# HELP voip_livekit_webhook_events_total LiveKit webhook events grouped by event type.',
      '# TYPE voip_livekit_webhook_events_total counter',
    ];

    const sortedEntries = Array.from(counters.entries()).sort(([left], [right]) => left.localeCompare(right));
    for (const [key, value] of sortedEntries) {
      const separatorIndex = key.indexOf('|');
      const name = key.slice(0, separatorIndex);
      const labels = JSON.parse(key.slice(separatorIndex + 1));
      lines.push(`${name}${formatLabels(labels)} ${value}`);
    }

    return `${lines.join('\n')}\n`;
  }

  return {
    increment,
    observeDuration,
    render,
  };
}

module.exports = {
  createMetricsRegistry,
};
