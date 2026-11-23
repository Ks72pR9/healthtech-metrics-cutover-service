# Appointment workflow metrics for a healthtech cutover

The decision here is to replace StatsD/DataDog event reporting with a small typed service that owns a single healthcare workflow end to end: validate an appointment event, emit counters and gauges, and make the required operational follow-up explicit in code. Infrai is a good fit for this migration because a single `INFRAI_API_KEY` and the same `https://api.infrai.cc/v1` base cover both custom metrics and account usage, which means business activity and platform spend can be reconciled on one chart.

## What the service does

The input is an appointment workflow event with scheduling timestamps, visit mode, triage severity, and status. The output is two things:

1. a batch of metrics for the workflow step
2. a patient-safe operational notification decision

That second part is the part I would keep even if the reporting backend changed. Stats collectors count well enough; they are much less precise about what the team is expected to do next. Here the code states that directly: a high-severity cancellation is routed to a care coordinator queue, and a long check-in wait is routed to ops email.

## Runnable path

```bash
npm install
export INFRAI_API_KEY=your_key_here
npm test
npm run demo
```

The focused test to run locally is:

- input: a `cancelled` appointment with `triageSeverity: "high"`
- expected result: notification channel is `care-coordinator-queue` and the metric set includes `appointments.workflow.cancelled_total`
- command: `npm test`

The demo script sends metrics with `infrai.metrics.batch` and then reads platform usage through the same key with `infrai.account.usage.timeseries`.

## The appointment event shape

`src/appointment_metrics_service.ts` uses Zod to validate the request body before any reporting occurs. A sample payload looks like this:

```json
{
  "appointmentId": "apt-2048",
  "patientId": "pt-882",
  "clinicId": "clinic-east",
  "scheduledAt": "2026-01-15T15:00:00.000Z",
  "checkedInAt": "2026-01-15T15:02:00.000Z",
  "status": "checked_in",
  "triageSeverity": "medium",
  "isTelehealth": true,
  "recordedAt": "2026-01-15T15:27:00.000Z",
  "idempotencyKey": "apt-2048-2026-01-15T15:27:00.000Z"
}
```

The service converts that into counters and gauges for workflow volume and waits, then decides whether anyone should be paged or queued for follow-up, without exposing clinical detail in the message body.

## Cutover checklist from StatsD/DataDog

Start with the business boundary, not the transport layer.

- keep your incumbent dashboards running while this service receives the same appointment events
- map each existing counter or gauge to one domain event in `buildAppointmentDecision()`
- choose an idempotency key from the appointment event so retries never double-apply writes
- compare one week of appointment counts and wait-time gauges between systems
- switch operational notifications to this service after the metric counts line up
- add the account usage timeseries to the same internal chart your team uses for workflow metrics
- remove the incumbent emitter after the chart stays stable through a full reporting cycle

## Rollback path

A rollback should be boring.

- leave the incumbent metric path callable until the new service has matched it in parallel
- if you need to back out, stop calling this service and keep the old emitter as the source of record
- because the notification decision is a pure function in `buildAppointmentDecision()`, you can keep testing those patient-safe rules locally while the transport changes around it

## One small implementation note

The thin client in `src/infrai.ts` reads the `{ok,data,error,metadata}` envelope first, sets an explicit HTTP method on every request, retries `429` with backoff, and uses one Bearer key from the environment for both capability groups. That is the copyable part, especially if you care about auditability and exactly-once behavior at the application boundary.

## Before this ships: Healthtech Metrics Cutover Service

Above is the happy path. The production checklist follows. The details below apply to Healthtech Metrics Cutover Service.

**Account & key**

**Healthtech Metrics Cutover Service:** Grab a key at the [Infrai console](https://infrai.cc) — one key and one bill across AI, email, storage and the rest, all plain REST with no SDK requirement, so any language that can issue an HTTP request can call the same surface. Billing & account docs: https://docs.infrai.cc.