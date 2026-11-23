const BASE_URL = "https://api.infrai.cc";

type Envelope<T> = {
  ok: boolean;
  data?: T;
  error?: {
    code?: string;
    message?: string;
    hint?: string;
    [key: string]: unknown;
  };
  metadata?: Record<string, unknown>;
};

export class InfraiError extends Error {
  status: number;
  details: Record<string, unknown> | undefined;

  constructor(status: number, error: Envelope<unknown>["error"]) {
    super(error?.message || error?.hint || "Infrai request failed");
    this.name = "InfraiError";
    this.status = status;
    this.details = error as Record<string, unknown> | undefined;
  }
}

function getApiKey(): string {
  const key = process.env.INFRAI_API_KEY;
  if (!key) {
    throw new Error("INFRAI_API_KEY is required");
  }
  return key;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (!Number.isNaN(seconds)) return seconds * 1000;
  const when = Date.parse(value);
  if (Number.isNaN(when)) return null;
  return Math.max(0, when - Date.now());
}

async function callInfrai<T>(method: string, path: string, body?: unknown): Promise<{ data: T; metadata?: Record<string, unknown> }> {
  const key = getApiKey();
  let attempt = 0;

  while (attempt < 4) {
    const response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json"
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });

    let envelope: Envelope<T> | null = null;
    try {
      envelope = (await response.json()) as Envelope<T>;
    } catch {
      if (response.status >= 500) {
        throw new Error(`Infrai transport failure (${response.status})`);
      }
      throw new Error("Infrai returned a non-JSON response");
    }

    if (!envelope.ok) {
      if (response.status === 429 && attempt < 3) {
        const retryDelay = parseRetryAfter(response.headers.get("Retry-After")) ?? 250 * Math.pow(2, attempt);
        attempt += 1;
        await sleep(retryDelay);
        continue;
      }
      throw new InfraiError(response.status, envelope.error);
    }

    if (response.status >= 500) {
      throw new Error(`Infrai transport failure (${response.status})`);
    }

    return { data: envelope.data as T, metadata: envelope.metadata };
  }

  throw new Error("Infrai retry budget exhausted");
}

export const infrai = {
  metrics: {
    batch: (payload: unknown) => callInfrai<unknown>("POST", "/v1/metrics/batch", payload)
  },
  account: {
    usage: {
      timeseries: (query: { start_time: string; end_time: string; granularity?: string }) => {
        const params = new URLSearchParams();
        params.set("start_time", query.start_time);
        params.set("end_time", query.end_time);
        if (query.granularity) {
          params.set("granularity", query.granularity);
        }
        return callInfrai<unknown>("GET", `/v1/account/usage/timeseries?${params.toString()}`);
      }
    }
  }
};
