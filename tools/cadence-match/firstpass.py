#!/usr/bin/env python3
# First-pass cadence breakdown — dependency-free (stdlib only).
# Reads a mono 16-bit WAV (decode mp3 first: afconvert -f WAVE -d LEI16 in.mp3 out.wav)
# and reports talk/silence rhythm + pause structure. This is the cheap layer; F0
# (pitch contour), per-word alignment, and speaker diarization come with the full
# harness (parselmouth + whisperx). Mixed mono = both speakers combined — pauses
# here include turn gaps, not just one speaker's phrasing.
import sys, wave, math, array

def main(path):
    w = wave.open(path, 'rb')
    sr, n, ch = w.getframerate(), w.getnframes(), w.getnchannels()
    raw = w.readframes(n); w.close()
    s = array.array('h'); s.frombytes(raw)
    if ch > 1:
        s = s[0::ch]
    dur = len(s) / sr

    fr = int(0.02 * sr)                      # 20 ms frames
    nf = len(s) // fr
    rms = [0.0] * nf
    for i in range(nf):
        acc = 0
        base = i * fr
        for k in range(fr):
            v = s[base + k]; acc += v * v
        rms[i] = math.sqrt(acc / fr)

    srt = sorted(rms)
    floor = srt[int(0.10 * nf)]              # noise floor
    peak = srt[int(0.95 * nf)]
    thr = floor + 0.10 * (peak - floor)      # silence/speech threshold
    voiced = [r > thr for r in rms]
    # Hangover smoothing: bridge sub-120ms energy dips (intra-word, not real pauses)
    # and drop sub-80ms speech blips, so bursts/pauses reflect real phrasing.
    def close_runs(arr, val, maxrun):
        i = 0
        while i < len(arr):
            if arr[i] == val:
                j = i
                while j < len(arr) and arr[j] == val:
                    j += 1
                if (j - i) <= maxrun:
                    for k in range(i, j):
                        arr[k] = not val
                i = j
            else:
                i += 1
    close_runs(voiced, False, 6)   # fill <=120ms silence dips
    close_runs(voiced, True, 4)    # drop <=80ms speech blips

    pauses, i = [], 0
    while i < nf:
        if not voiced[i]:
            j = i
            while j < nf and not voiced[j]:
                j += 1
            pauses.append((i * 0.02, (j - i) * 0.02))
            i = j
        else:
            i += 1

    speech_ratio = sum(voiced) / nf
    sig = sorted(d for _, d in pauses if d >= 0.20)   # "real" pauses
    def pct(a, p): return a[min(len(a) - 1, int(p * len(a)))] if a else 0.0
    longest = sorted(pauses, key=lambda x: -x[1])[:8]

    # Speech bursts: runs of voiced frames (>=120ms) — "how long they talk before a beat".
    bursts, i = [], 0
    while i < nf:
        if voiced[i]:
            j = i
            while j < nf and voiced[j]:
                j += 1
            if (j - i) * 0.02 >= 0.12:
                bursts.append((j - i) * 0.02)
            i = j
        else:
            i += 1
    bursts.sort()

    # Pause-length histogram (the rhythm signature).
    buckets = [(0.2, 0.4), (0.4, 0.7), (0.7, 1.2), (1.2, 99)]
    hist = [sum(1 for d in sig if lo <= d < hi) for lo, hi in buckets]

    # (Syllable/articulation rate needs real word/phone timing — that's the whisperx
    #  layer, not energy peaks. Omitted here rather than reported unreliably.)

    print(f"file              {path}")
    print(f"duration          {dur:6.1f} s   ({sr} Hz mono)")
    print(f"talking            {speech_ratio*100:5.1f}% of the call   silence {100-speech_ratio*100:5.1f}%")
    print(f"pauses >=200ms     {len(sig)}   "
          f"median {pct(sig,.5):.2f}s  p90 {pct(sig,.9):.2f}s  max {sig[-1] if sig else 0:.2f}s")
    rate = len(sig) / dur * 60
    print(f"pause cadence      ~{rate:.0f} pauses/min")
    print(f"speech bursts      {len(bursts)}   median {pct(bursts,.5):.2f}s  p90 {pct(bursts,.9):.2f}s  "
          f"(talk this long, then a beat)")
    print(f"pause rhythm       0.2-0.4s:{hist[0]}   0.4-0.7s:{hist[1]}   0.7-1.2s:{hist[2]}   1.2s+:{hist[3]}")
    print("longest gaps (likely turn boundaries):")
    for t, d in longest:
        m, sec = divmod(t, 60)
        print(f"   {int(m):d}:{sec:04.1f}   {d:.2f}s")

if __name__ == '__main__':
    main(sys.argv[1])
