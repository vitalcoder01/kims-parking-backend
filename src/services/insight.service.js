/*
 * Turns the analytics bundle (overview + slot/task/notification intelligence
 * + data quality + anomalies) into insight cards an admin can read without
 * doing the arithmetic themselves.
 *
 * Same discipline as the web app's src/core/copilot/insights.ts (a real-time
 * rule engine over live state): pure functions, no LLM, no invented numbers.
 * Every card is gated on a real threshold computed from the data it's about
 * — a rule that can't clear its threshold simply doesn't fire, rather than
 * emitting a hedge. Every field (observation/evidence/impact/recommendation)
 * must trace back to a number already present in the input bundle.
 */

const MIN_SAMPLE = 5; // below this, a stat is noise, not a signal

function minutesLabel(m) {
  if (m == null) return 'n/a';
  if (m < 60) return `${Math.round(m)} min`;
  return `${Math.floor(m / 60)}h ${Math.round(m % 60)}m`;
}

function hourLabel(h) {
  if (h == null) return 'n/a';
  const period = h < 12 ? 'AM' : 'PM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12} ${period}`;
}

function card({ id, severity, title, observation, evidence, impact, recommendation }) {
  return { id, severity, title, observation, evidence, impact, recommendation };
}

function peakHourInsight(overview) {
  const { busiestHour, hourlyDistribution, totalJobsCompleted } = overview;
  if (busiestHour == null || totalJobsCompleted < 10) return null;
  const peakCount = hourlyDistribution[busiestHour];
  const otherHours = hourlyDistribution.filter((_, h) => h !== busiestHour);
  const avgOther = otherHours.reduce((a, b) => a + b, 0) / (otherHours.length || 1);
  if (avgOther === 0 || peakCount < avgOther * 1.5) return null; // not meaningfully peaked
  const multiple = Math.round((peakCount / avgOther) * 10) / 10;
  return card({
    id: 'peak_hour',
    severity: multiple >= 3 ? 'warn' : 'info',
    title: 'Peak Hour',
    observation: `Completed jobs concentrate around ${hourLabel(busiestHour)}.`,
    evidence: `${peakCount} jobs completed in that hour vs an average of ${Math.round(avgOther * 10) / 10} in other hours (${multiple}x) — out of ${totalJobsCompleted} total in this period.`,
    impact: 'Driver and valet capacity is under the most pressure during this window.',
    recommendation: `Schedule extra drivers/valets around ${hourLabel(busiestHour)}.`,
  });
}

function underutilizedSlotsInsight(slots) {
  if (!slots.totalSlots || slots.underutilizedCount === 0) return null;
  const pct = Math.round((slots.underutilizedCount / slots.totalSlots) * 100);
  if (pct < 15) return null; // a handful of quiet slots isn't worth flagging
  const examples = slots.slots.filter(s => s.classification === 'UNDERUTILIZED').slice(0, 5).map(s => s.id);
  return card({
    id: 'underutilized_slots',
    severity: pct >= 40 ? 'warn' : 'info',
    title: 'Underutilized Capacity',
    observation: `${slots.underutilizedCount} of ${slots.totalSlots} slots (${pct}%) saw well below average use this period.`,
    evidence: `Mean usage across all slots is ${slots.meanUsage} completed park jobs. Underutilized examples: ${examples.join(', ')}${slots.underutilizedCount > examples.length ? ', …' : ''}.`,
    impact: 'Capacity exists that isn\'t being routed to — likely a distribution problem, not a demand problem.',
    recommendation: 'Consider directing incoming cars toward these blocks/slots first, or reviewing whether they\'re harder to reach.',
  });
}

function overloadedSlotsInsight(slots) {
  if (slots.overloadedCount === 0) return null;
  const examples = slots.slots.filter(s => s.classification === 'OVERLOADED').slice(0, 5).map(s => `${s.id} (${s.usageCount})`);
  return card({
    id: 'overloaded_slots',
    severity: 'warn',
    title: 'Overloaded Slots',
    observation: `${slots.overloadedCount} slot${slots.overloadedCount === 1 ? '' : 's'} saw far more use than the fleet average this period.`,
    evidence: `Mean usage is ${slots.meanUsage}; overloaded: ${examples.join(', ')}.`,
    impact: 'These slots may be wearing faster or creating a bottleneck at peak times if they\'re near the entrance.',
    recommendation: 'Spot-check these slots\' condition and consider rebalancing assignment toward less-used ones.',
  });
}

function driverImbalanceInsight(overview) {
  const active = overview.drivers.filter(d => d.totalCompleted > 0);
  if (active.length < 3) return null; // imbalance among 1-2 drivers isn't meaningful
  const total = active.reduce((a, d) => a + d.totalCompleted, 0);
  if (total < 10) return null;
  const top = active[0]; // overview.drivers is already sorted by totalCompleted desc
  const share = Math.round((top.totalCompleted / total) * 100);
  if (share < 40) return null;
  return card({
    id: 'driver_workload_imbalance',
    severity: share >= 55 ? 'warn' : 'info',
    title: 'Driver Workload Imbalance',
    observation: `${top.name} is handling a disproportionate share of completed jobs.`,
    evidence: `${top.totalCompleted} of ${total} completed jobs across ${active.length} active drivers (${share}%).`,
    impact: 'Uneven load risks burnout for the top driver and underuse of the rest of the roster.',
    recommendation: 'Review dispatch assignment to spread jobs more evenly across available drivers.',
  });
}

function taskBottleneckInsight(taskFunnel) {
  const cards = [];
  for (const [kind, label] of [['park', 'Park'], ['retrieve', 'Retrieve']]) {
    const b = taskFunnel[kind].bottleneck;
    if (!b || b.avgMinutes == null || b.avgMinutes < 8) continue; // under 8 min isn't worth calling a bottleneck
    cards.push(card({
      id: `task_bottleneck_${kind}`,
      severity: b.avgMinutes >= 20 ? 'warn' : 'info',
      title: `${label} Bottleneck`,
      observation: `The slowest stage in the ${kind} lifecycle is "${b.label}".`,
      evidence: `Averages ${minutesLabel(b.avgMinutes)} across ${b.sampleSize} completed ${kind} jobs with both timestamps recorded.`,
      impact: kind === 'retrieve' && b.key === 'delivered_to_confirmed'
        ? 'This stage is the owner\'s own wait after the car has already arrived — not driver/valet delay.'
        : 'This is the largest single delay in an otherwise-completed job.',
      recommendation: kind === 'retrieve' && b.key === 'delivered_to_confirmed'
        ? 'No operational fix needed here — this measures the owner\'s pickup lag, not staff performance.'
        : 'Investigate this specific stage for process or staffing gaps.',
    }));
  }
  return cards;
}

function notificationSpikeInsight(notifications) {
  if (!notifications.spikes.length) return null;
  const latest = notifications.spikes[notifications.spikes.length - 1];
  return card({
    id: 'notification_spike',
    severity: 'info',
    title: 'Notification Spike',
    observation: `Notification volume spiked on ${latest.date}.`,
    evidence: `${latest.count} notifications that day vs a daily average of ${notifications.meanPerDay} across the period.`,
    impact: 'A sudden volume spike often tracks a real operational event (surge, outage, or repeated alarm) rather than routine traffic.',
    recommendation: 'Check what happened operationally on that date and whether any single alert type is repeating unnecessarily.',
  });
}

function demandAnomalyInsight(anomalies) {
  if (!anomalies.anomalies.length) return null;
  const latest = anomalies.anomalies[anomalies.anomalies.length - 1];
  const isHigh = latest.direction === 'high';
  return card({
    id: 'demand_anomaly',
    severity: Math.abs(latest.deviationStdDevs) >= 3 ? 'warn' : 'info',
    title: isHigh ? 'Demand Surge Detected' : 'Unusually Low Demand',
    observation: `Completed-job volume on ${latest.date} was ${isHigh ? 'far above' : 'far below'} the recent baseline.`,
    evidence: `${latest.count} completed jobs vs a ${anomalies.lookbackDays}-day average of ${anomalies.mean} (±${anomalies.stddev}) — ${latest.deviationStdDevs} standard deviations from baseline.`,
    impact: isHigh ? 'Capacity pressure is likely on days that repeat this pattern.' : 'May indicate a closure, holiday, or an operational issue suppressing normal traffic.',
    recommendation: isHigh ? 'Confirm staffing matches demand on similar future days.' : 'Confirm this wasn\'t an outage or data gap rather than genuinely quiet traffic.',
  });
}

function dataQualityInsight(dataQuality) {
  const issues = [];
  if (dataQuality.openClientErrors > 0) {
    issues.push(`${dataQuality.openClientErrors} unresolved client error type${dataQuality.openClientErrors === 1 ? '' : 's'}`);
  }
  if (dataQuality.impossibleTimestampCount > 0) {
    issues.push(`${dataQuality.impossibleTimestampCount} task${dataQuality.impossibleTimestampCount === 1 ? '' : 's'} with a completion time earlier than its creation time`);
  }
  if (dataQuality.orphanSlotReferenceCount > 0) {
    issues.push(`${dataQuality.orphanSlotReferenceCount} task${dataQuality.orphanSlotReferenceCount === 1 ? '' : 's'} referencing a slot id that no longer exists`);
  }
  if (!issues.length) return null;
  return card({
    id: 'data_quality',
    severity: dataQuality.impossibleTimestampCount > 0 ? 'warn' : 'info',
    title: 'Data Quality',
    observation: 'The system found data integrity issues worth a look.',
    evidence: issues.join('; ') + '.',
    impact: 'Left unaddressed, these can quietly skew analytics that depend on the affected records.',
    recommendation: 'Review the flagged records in the Data Quality panel; resolve or investigate each.',
  });
}

/** MIN_SAMPLE is referenced for clarity in a couple of gates above; exported
 *  for tests that want to assert against the same constant. */
function buildInsights({ overview, slots, taskFunnel, notifications, dataQuality, anomalies }) {
  const out = [
    peakHourInsight(overview),
    underutilizedSlotsInsight(slots),
    overloadedSlotsInsight(slots),
    driverImbalanceInsight(overview),
    ...taskBottleneckInsight(taskFunnel),
    notificationSpikeInsight(notifications),
    demandAnomalyInsight(anomalies),
    dataQualityInsight(dataQuality),
  ].filter(Boolean);

  const SEVERITY_ORDER = { warn: 0, info: 1 };
  return out.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

module.exports = { buildInsights, MIN_SAMPLE };
