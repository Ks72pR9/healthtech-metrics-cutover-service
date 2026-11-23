import test from "node:test";
import assert from "node:assert/strict";
import { buildAppointmentDecision } from "../src/appointment_metrics_service.js";

test("high-severity cancellation routes to patient-safe follow-up", () => {
  const result = buildAppointmentDecision({
    appointmentId: "apt-100",
    patientId: "pt-100",
    clinicId: "clinic-north",
    scheduledAt: "2026-02-10T10:00:00.000Z",
    status: "cancelled",
    cancellationSource: "patient",
    triageSeverity: "high",
    isTelehealth: false,
    recordedAt: "2026-02-10T09:40:00.000Z",
    idempotencyKey: "apt-100-cancelled"
  });

  assert.equal(result.notification.channel, "care-coordinator-queue");
  assert.equal(result.notification.subject, "High-severity appointment cancelled");
  assert.ok(result.metricSeries.some((series) => series.name === "appointments.workflow.cancelled_total"));
});

test("long check-in wait triggers an operations alert", () => {
  const result = buildAppointmentDecision({
    appointmentId: "apt-200",
    patientId: "pt-200",
    clinicId: "clinic-south",
    scheduledAt: "2026-02-10T10:00:00.000Z",
    checkedInAt: "2026-02-10T10:05:00.000Z",
    status: "checked_in",
    triageSeverity: "medium",
    isTelehealth: true,
    recordedAt: "2026-02-10T10:28:00.000Z",
    idempotencyKey: "apt-200-wait"
  });

  assert.equal(result.notification.channel, "ops-email");
  assert.match(result.notification.reason, /23 minutes/);
  assert.ok(result.metricSeries.some((series) => series.name === "appointments.workflow.wait_minutes" && series.value === 23));
});
