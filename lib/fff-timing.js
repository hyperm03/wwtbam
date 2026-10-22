export function latencySummary(samples) {
    const sorted = samples.filter(v => Number.isFinite(v) && v >= 0 && v <= 5000).sort((a, b) => a - b);
    if (!sorted.length) return { rtt: 0, uncertaintyMs: 250, unstable: true };
    const rtt = sorted[Math.floor(sorted.length / 2)];
    const spread = sorted[sorted.length - 1] - sorted[0];
    return { rtt, uncertaintyMs: Math.min(1000, Math.max(30, spread / 2)), unstable: sorted.length < 3 || spread > 150 || rtt > 500 };
}
export function measuredAnswer(serverElapsed, samples) {
    const latency = latencySummary(samples);
    // The client-reported elapsed time is diagnostic only, never used to decide a winner.
    const elapsed = Math.max(0, serverElapsed - Math.min(100, latency.rtt / 2));
    return { time: Math.round(elapsed / 10) / 100, uncertaintyMs: latency.uncertaintyMs, unstable: latency.unstable };
}
export function tiedSeats(rows) {
    const correct = rows.filter(row => row.correct && row.time != null).sort((a, b) => a.time - b.time);
    if (!correct.length) return [];
    const best = correct[0];
    return correct.filter(row => (row.time - best.time) * 1000 <= Math.max(10, best.uncertaintyMs || 0, row.uncertaintyMs || 0)).map(row => row.seat);
}
