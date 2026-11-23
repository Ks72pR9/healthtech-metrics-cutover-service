import { z } from "zod";
import { infrai } from "./infrai.js";

const appointmentEventSchema = z.object({
  appointmentId: z.string().min(1),
  patientId: z.string().min(1),
  clinicId: z.string().min(1),
  scheduledAt: z.string().datetime(),
  checkedInAt: z.string().datetime().optional(),
  clinicianJoinedAt: z.string().datetime().optional(),
  status: z.enum(["scheduled", "checked_in", "in_consult", "completed", "cancelled", "no_show"]),
  cancellationSource: z.enum(["patient", "clinic"]).optional(),
  triageSeverity: z.enum(["low", "medium", "high"]),
  isTelehealth: z.boolean(),
  recordedAt: z.string().datetime(),
  idempotencyKey: z.string().min(8)
});

export type AppointmentEvent = z.infer<typeof appointmentEventSchema>;

export type OperationalNotification = {
  channel: "ops-email" | "care-coordinator-queue" | "none";
  subject: string;
  reason: string;
  patientSafeSummary: string;
};

export type AppointmentDecision = {
  metricSeries: Array<{
    name: string;
    type: "counter" | "gauge";
    value: number;
    tags: Record<string, string>;
  }>;
  notification: OperationalNotification;
};

function minutesBetween(startIso: string, endIso: string): number {
  return Math.max(0, Math.round((Date.parse(endIso) - Date.parse(startIso)) / 60000));
}

export function buildAppointmentDecision(input: AppointmentEvent): AppointmentDecision {
  const tags = {
    clinic_id: input.clinicId,
    triage_severity: input.triageSeverity,
    visit_mode: input.isTelehealth ? "telehealth" : "in_person",
    status: input.status
  };

  const metricSeries: AppointmentDecision["metricSeries"] = [
    {
      name: "appointments.workflow.events",
      type: "counter",
      value: 1,
      tags
    }
  ];

  let notification: OperationalNotification = {
    channel: "none",
    subject: "No operational follow-up",
    reason: "workflow within expected range",
    patientSafeSummary: "No patient details included."
  };

  if (input.status === "cancelled") {
    metricSeries.push({
      name: "appointments.workflow.cancelled_total",
      type: "counter",
      value: 1,
      tags: {
        ...tags,
        cancellation_source: input.cancellationSource ?? "unknown"
      }
    });

    if (input.triageSeverity === "high") {
      notification = {
        channel: "care-coordinator-queue",
        subject: "High-severity appointment cancelled",
        reason: "same-day outreach needed",
        patientSafeSummary: `Appointment ${input.appointmentId} was cancelled before care delivery. Route to coordinator without clinical notes.`
      };
    }
  }

  if (input.status === "no_show") {
    metricSeries.push({
      name: "appointments.workflow.no_show_total",
      type: "counter",
      value: 1,
      tags
    });

    if (input.triageSeverity === "high") {
      notification = {
        channel: "care-coordinator-queue",
        subject: "High-severity no-show",
        reason: "outreach needed after missed visit",
        patientSafeSummary: `Appointment ${input.appointmentId} was missed. Queue a patient-safe follow-up task.`
      };
    }
  }

  if (input.checkedInAt) {
    metricSeries.push({
      name: "appointments.workflow.wait_minutes",
      type: "gauge",
      value: minutesBetween(input.checkedInAt, input.recordedAt),
      tags
    });
  }

  if (input.checkedInAt && input.status === "checked_in") {
    const waitMinutes = minutesBetween(input.checkedInAt, input.recordedAt);
    if (waitMinutes >= 20) {
      notification = {
        channel: "ops-email",
        subject: "Check-in wait threshold crossed",
        reason: `patient waiting ${waitMinutes} minutes before clinician join`,
        patientSafeSummary: `Appointment ${input.appointmentId} is delayed. Share only the appointment reference and clinic.`
      };
    }
  }

  if (input.clinicianJoinedAt) {
    metricSeries.push({
      name: "appointments.workflow.time_to_clinician_minutes",
      type: "gauge",
      value: minutesBetween(input.scheduledAt, input.clinicianJoinedAt),
      tags
    });
  }

  return { metricSeries, notification };
}

export async function reportAppointmentWorkflow(rawInput: unknown): Promise<{
  decision: AppointmentDecision;
  metricsMetadata?: Record<string, unknown>;
}> {
  const input = appointmentEventSchema.parse(rawInput);
  const decision = buildAppointmentDecision(input);

  const payload = {
    idempotency_key: input.idempotencyKey,
    points: decision.metricSeries.map((series) => ({
      name: series.name,
      type: series.type,
      value: series.value,
      tags: series.tags,
      timestamp: input.recordedAt
    }))
  };

  const result = await infrai.metrics.batch(payload);
  return {
    decision,
    metricsMetadata: result.metadata
  };
}

export async function buildOpsDashboardWindow(windowStart: string, windowEnd: string): Promise<{
  windowStart: string;
  windowEnd: string;
  platformUsage: unknown;
}> {
  const usage = await infrai.account.usage.timeseries({
    start_time: windowStart,
    end_time: windowEnd,
    granularity: "day"
  });

  return {
    windowStart,
    windowEnd,
    platformUsage: usage.data
  };
}

async function main(): Promise<void> {
  const sample: AppointmentEvent = {
    appointmentId: "apt-2048",
    patientId: "pt-882",
    clinicId: "clinic-east",
    scheduledAt: "2026-01-15T15:00:00.000Z",
    checkedInAt: "2026-01-15T15:02:00.000Z",
    status: "checked_in",
    triageSeverity: "medium",
    isTelehealth: true,
    recordedAt: "2026-01-15T15:27:00.000Z",
    idempotencyKey: "apt-2048-2026-01-15T15:27:00.000Z"
  };

  const workflow = await reportAppointmentWorkflow(sample);
  const usageWindow = await buildOpsDashboardWindow("2026-01-01T00:00:00.000Z", "2026-01-31T23:59:59.000Z");

  console.log(JSON.stringify({
    notification: workflow.decision.notification,
    metricCount: workflow.decision.metricSeries.length,
    usageWindow
  }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
