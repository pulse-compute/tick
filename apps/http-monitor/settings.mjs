// Replace the resource identities/target before a controlled deployment. No secrets here.
export const settings = {
  target: 'https://monitor-target.example/health',
  storeId: 'REPLACE_WITH_DEDICATED_KV_STORE_ID',
  s3Endpoint: 'https://monitor-observations.s3.us-east-1.amazonaws.com',
  s3Region: 'us-east-1',
  observationsPrefix: 'tick08/observations/',
  monitor: {
    namespace: 'tick08-monitor', monitorId: 'homepage',
    coordinationPrefix: 'tick08/jobs/', admissionPrefix: 'tick08/admission/',
    schedule: { kind: 'interval', anchorMs: 0, everyMs: 60000, revision: 'v1', missedWindows: 'skip' },
    admissionSchedule: { kind: 'interval', anchorMs: 0, everyMs: 5000, revision: 'v1', missedWindows: 'skip' },
    limits: { maxJobsPerTick: 1, maxAttemptsPerRun: 3, leaseMs: 8000, runTimeoutMs: 30000, retryDelayMs: 1000, maxClockSkewMs: 50, deadlineSafetyMs: 50 },
    requestTimeoutMs: 10000,
  },
};
