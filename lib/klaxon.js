/**
 * Built-in klaxon for themes without one: an original two-tone horn synthesized here
 * (not the TV show's sound). Same algorithm as the desktop app; generated once and cached.
 */
let cached = null;

export function builtInKlaxon() {
    if (cached) return cached;
    const rate = 44100, seconds = 2.8, count = Math.floor(rate * seconds);
    const tones = [330.0, 415.3];
    const samples = new Float64Array(count);
    let peak = 0;
    for (let i = 0; i < count; i++) {
        const t = i / rate;
        let v = 0;
        for (const f of tones) for (let k = 1; k <= 12; k++) v += Math.sin(2 * Math.PI * k * f * t) / k;
        v *= 1 - 0.25 * (0.5 + 0.5 * Math.sin(2 * Math.PI * 24 * t));
        const attack = Math.min(1, t / 0.03);
        const release = Math.max(0, Math.min(1, (seconds - t) / 0.25));
        samples[i] = Math.tanh(1.6 * v / 3) * attack * release;
        peak = Math.max(peak, Math.abs(samples[i]));
    }
    const gain = peak > 0 ? 0.85 / peak : 1;
    const data = count * 2;
    const buf = Buffer.alloc(44 + data);
    buf.write('RIFF', 0); buf.writeUInt32LE(36 + data, 4); buf.write('WAVE', 8);
    buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
    buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
    buf.write('data', 36); buf.writeUInt32LE(data, 40);
    for (let i = 0; i < count; i++) buf.writeInt16LE(Math.round(samples[i] * gain * 32767), 44 + i * 2);
    cached = buf;
    return buf;
}
