import { useEffect, useState } from 'react';
import { requestJson, startPolling } from './request';

export type PublicActivityEvent = {
  public_event_id: string;
  occurred_at: string;
  event_type: string;
  source_kind: string;
  client_kind: string;
  protocol_family: string;
  catalog_id: string | null;
  provider_id: string | null;
  object_type: string | null;
  status_class: string;
  duration_bucket: string;
  result_count_bucket: string;
  public_summary: string;
  correlation_id_hash: string | null;
};

export type ActivityRollups = {
  window_hours: number;
  event_count: number;
  by_event_type: Record<string, number>;
  by_protocol_family: Record<string, number>;
  by_status_class: Record<string, number>;
};

export type LiveActivityStatus = 'loading' | 'ready' | 'error';

const activityApiUrl = (
  import.meta.env.VITE_OCP_ACTIVITY_API_URL ?? 'http://localhost:4400'
).replace(/\/+$/, '');

type Options = {
  limit?: number;
  windowHours?: number;
  pollMs?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNumberRecord(value: unknown): value is Record<string, number> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === 'number');
}

function parseRollups(value: unknown): ActivityRollups {
  if (
    !isRecord(value) ||
    typeof value.window_hours !== 'number' ||
    typeof value.event_count !== 'number' ||
    !isNumberRecord(value.by_event_type) ||
    !isNumberRecord(value.by_protocol_family) ||
    !isNumberRecord(value.by_status_class)
  ) {
    throw new Error('Activity rollup payload does not match the public projection schema');
  }

  return {
    window_hours: value.window_hours,
    event_count: value.event_count,
    by_event_type: value.by_event_type,
    by_protocol_family: value.by_protocol_family,
    by_status_class: value.by_status_class,
  };
}

function parseEvents(value: unknown): PublicActivityEvent[] {
  if (!isRecord(value) || !Array.isArray(value.events)) {
    throw new Error('Activity recent payload does not expose an events array');
  }

  return value.events as PublicActivityEvent[];
}

export function useLiveActivity({ limit = 40, windowHours = 24, pollMs = 15_000 }: Options = {}) {
  const [events, setEvents] = useState<PublicActivityEvent[]>([]);
  const [rollups, setRollups] = useState<ActivityRollups | null>(null);
  const [status, setStatus] = useState<LiveActivityStatus>('loading');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load(signal: AbortSignal) {
      try {
        const responses = await Promise.allSettled([
          requestJson(`${activityApiUrl}/api/activity/recent?limit=${limit}`, { signal }),
          requestJson(`${activityApiUrl}/api/activity/rollups?hours=${windowHours}`, { signal }),
        ]);
        const [recent, rollup] = responses;
        if (recent.status === 'rejected') throw recent.reason;
        if (rollup.status === 'rejected') throw rollup.reason;
        const recentPayload = recent.value;
        const rollupPayload = rollup.value;
        const parsedEvents = parseEvents(recentPayload);
        const parsedRollups = parseRollups(rollupPayload);
        if (signal.aborted) return;

        setEvents(parsedEvents);
        setRollups(parsedRollups);
        setError(null);
        setStatus('ready');
      } catch (loadError) {
        if (!signal.aborted) {
          setError(loadError instanceof Error ? loadError.message : 'Activity API unavailable');
          setStatus('error');
        }
      }
    }

    const polling = startPolling(load, pollMs);
    return () => polling.stop();
  }, [limit, windowHours, pollMs]);

  return { events, rollups, status, error };
}
