// pa_callback.cc — PortAudio callback-mode playback + full-duplex recording engine
//
// Thread model:
//   Audio thread  — PortAudio callback: mixes tracks, captures input, pushes ring buffer.
//   Write thread  — drains ring buffer → 24-bit PCM WAV on disk (std::thread).
//   V8 thread     — all N-API calls; TSFN callbacks; StopRecordWorker::OnOK.
//   libuv pool    — StopRecordWorker::Execute (joins write thread, patches WAV header).
//
// JS API:
//   play(deviceId, sr, startSample, tracks[], onPos, onLevels, onTrLev, onEnded)
//   record(inDev, outDev, sr, startSample, filePath, tracks[],
//          onPos, onLevels, onTrLev, onInputLevels, onEnded)
//   stopRecord()           → Promise<{filePath:string, duration:number}>
//   seek(samplePos)        — atomic; next callback frame
//   abort()                — Pa_AbortStream; immediate silence
//   getPosition()          → number (samples)
//   setTrackParam(idx, vol, panL, panR, muted)
//   isActive()             → bool
//   dispose()              — full teardown

#define NAPI_VERSION 6
#include <napi.h>
#include <portaudio.h>

#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdint>
#include <cstring>
#include <string>
#include <thread>
#include <vector>

// ── Track ─────────────────────────────────────────────────────────────────────

struct Track {
    float   *left          = nullptr;
    float   *right         = nullptr;
    int64_t  numFrames     = 0;
    int64_t  startSample   = 0;
    int64_t  endSample     = 0;
    int64_t  offsetSamples = 0;
    double   srcRatio      = 1.0;

    std::atomic<float> volume{1.f};
    std::atomic<float> panL{0.707f};
    std::atomic<float> panR{0.707f};
    std::atomic<int>   muted{0};

    ~Track() { delete[] left; delete[] right; }
    Track() = default;
    Track(const Track&)            = delete;
    Track& operator=(const Track&) = delete;
};

// ── TSFN data packets ─────────────────────────────────────────────────────────

struct PosPacket  { double  pos; };
struct LevPacket  { float   l, r; };
struct TrLPacket  { int n; float lr[64 * 2]; };
struct EndPacket  { double  pos; };

// ── Runtime diagnostics (atomic — read from audio thread, polled from V8 thread) ─
// getDiag() returns these without locking; values are slightly racy but fine for logging.

static std::atomic<uint64_t> gTotalCallbacks{0};   // never resets; proves callback is alive
static std::atomic<uint64_t> gLastCbMs{0};          // milliseconds-since-epoch of last callback

// ── Lock-free SPSC ring buffer (float samples, interleaved L/R) ───────────────
// Size must be a power of 2. 1<<20 = 1M floats = 4MB = ~10.4s stereo @ 48kHz.

static const int RING_CAP = 1 << 20;

struct RingBuffer {
    float            data[RING_CAP];
    std::atomic<int> head{0};   // write cursor — producer (audio callback)
    std::atomic<int> tail{0};   // read  cursor — consumer (write thread)

    int push(const float *src, int count) {
        int h     = head.load(std::memory_order_relaxed);
        int t     = tail.load(std::memory_order_acquire);
        int avail = (t - h - 1 + RING_CAP) & (RING_CAP - 1);
        if (count > avail) count = avail;   // drop if overflowing (prefer glitch over block)
        for (int i = 0; i < count; i++)
            data[(h + i) & (RING_CAP - 1)] = src[i];
        head.store((h + count) & (RING_CAP - 1), std::memory_order_release);
        return count;
    }

    int pop(float *dst, int maxCount) {
        int t     = tail.load(std::memory_order_relaxed);
        int h     = head.load(std::memory_order_acquire);
        int avail = (h - t + RING_CAP) & (RING_CAP - 1);
        if (avail > maxCount) avail = maxCount;
        for (int i = 0; i < avail; i++)
            dst[i] = data[(t + i) & (RING_CAP - 1)];
        tail.store((t + avail) & (RING_CAP - 1), std::memory_order_release);
        return avail;
    }
};

// ── WAV helpers ───────────────────────────────────────────────────────────────

static void writeWavHeader(FILE *f, int sr, int ch) {
    uint32_t byteRate   = (uint32_t)(sr * ch * 3);
    uint16_t blockAlign = (uint16_t)(ch * 3);
    uint16_t bitsPerSample = 24;
    uint16_t audioFmt   = 1;  // PCM
    uint16_t numCh      = (uint16_t)ch;
    uint32_t fmtSize    = 16;
    uint32_t placeholder = 0;

    fwrite("RIFF",       1, 4, f);
    fwrite(&placeholder, 4, 1, f);   // RIFF size — patched on stop
    fwrite("WAVE",       1, 4, f);
    fwrite("fmt ",       1, 4, f);
    fwrite(&fmtSize,     4, 1, f);
    fwrite(&audioFmt,    2, 1, f);
    fwrite(&numCh,       2, 1, f);
    fwrite(&sr,          4, 1, f);
    fwrite(&byteRate,    4, 1, f);
    fwrite(&blockAlign,  2, 1, f);
    fwrite(&bitsPerSample, 2, 1, f);
    fwrite("data",       1, 4, f);
    fwrite(&placeholder, 4, 1, f);   // data size — patched on stop
}

static void patchWavHeader(FILE *f, uint64_t dataBytes) {
    uint32_t riffSize = (uint32_t)(dataBytes + 36);
    uint32_t dataSize = (uint32_t)dataBytes;
    fseek(f, 4,  SEEK_SET); fwrite(&riffSize, 4, 1, f);
    fseek(f, 40, SEEK_SET); fwrite(&dataSize, 4, 1, f);
}

// ── Engine (one global instance) ──────────────────────────────────────────────

static struct Engine {
    // ── Playback ──
    std::vector<Track*> tracks;
    int numTracks = 0;

    std::atomic<int64_t> position{0};
    std::atomic<int64_t> seekTarget{-1};
    std::atomic<int>     shouldAbort{0};
    std::atomic<int>     active{0};
    int sampleRate = 48000;
    PaStream *stream = nullptr;

    // ── Recording ──
    std::atomic<int>  isRecording{0};
    int               recSr  = 48000;
    int               recCh  = 2;
    int               recInputNumCh    = 2;  // channels opened on the input stream
    int               recInputChOffset = 0;  // 0-indexed channel to capture (mono)
    char              recFilePath[1024] = {};
    FILE             *recFile = nullptr;
    uint64_t          recBytesWritten = 0;
    int64_t           recStartSample  = 0;

    RingBuffer       ring;
    std::thread      writeThread;
    std::atomic<int> writeThreadStop{0};

    // ── Throttling (audio thread only — no sync needed) ──
    int cbCount = 0;

    // ── TSFNs ──
    Napi::ThreadSafeFunction tsfPos;
    Napi::ThreadSafeFunction tsfLevels;
    Napi::ThreadSafeFunction tsfTrLev;
    Napi::ThreadSafeFunction tsfEnded;
    Napi::ThreadSafeFunction tsfInputLevels;
    bool tsfCreated         = false;
    bool tsfInputLevCreated = false;

    // Must be called from V8 thread only.
    void releaseTsfns() {
        if (tsfCreated) {
            tsfPos.Release();
            tsfLevels.Release();
            tsfTrLev.Release();
            tsfEnded.Release();
            tsfCreated = false;
        }
        if (tsfInputLevCreated) {
            tsfInputLevels.Release();
            tsfInputLevCreated = false;
        }
    }

    void clearTracks() {
        for (auto *t : tracks) delete t;
        tracks.clear();
        numTracks = 0;
    }

    // Full teardown — called from V8 thread before starting a new session.
    // Aborts the stream, joins the write thread (≤1ms wait), discards any
    // incomplete take, releases TSFNs, frees track PCM.
    void teardown() {
        shouldAbort.store(1, std::memory_order_relaxed);
        isRecording.store(0, std::memory_order_relaxed);
        active.store(0, std::memory_order_relaxed);

        if (stream) {
            Pa_AbortStream(stream);
            Pa_CloseStream(stream);
            stream = nullptr;
        }

        if (writeThread.joinable()) {
            writeThreadStop.store(1, std::memory_order_relaxed);
            writeThread.join();
        }

        if (recFile) {
            fclose(recFile);   // no patch — discard incomplete take on force-teardown
            recFile = nullptr;
        }
        recBytesWritten = 0;
        cbCount         = 0;
        ring.head.store(0, std::memory_order_relaxed);
        ring.tail.store(0, std::memory_order_relaxed);

        releaseTsfns();
        clearTracks();
    }

} gEng;

// ── Write thread ──────────────────────────────────────────────────────────────
// Runs on its own std::thread. Drains the ring buffer and writes 24-bit PCM WAV.
// Exits cleanly after writeThreadStop is set, draining whatever remains.

static void writeThreadFn() {
    float tbuf[4096];
    while (!gEng.writeThreadStop.load(std::memory_order_relaxed)) {
        int got = gEng.ring.pop(tbuf, 4096);
        if (got > 0) {
            for (int i = 0; i < got; i++) {
                float   f = tbuf[i];
                if (f >  1.f) f =  1.f;
                if (f < -1.f) f = -1.f;
                int32_t s = (int32_t)(f * 8388607.f);
                uint8_t b[3] = {
                    (uint8_t)( s        & 0xFF),
                    (uint8_t)((s >>  8) & 0xFF),
                    (uint8_t)((s >> 16) & 0xFF)
                };
                fwrite(b, 1, 3, gEng.recFile);
            }
            gEng.recBytesWritten += (uint64_t)got * 3;
        } else {
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
    }
    // Drain remaining samples after stop signal.
    int got;
    while ((got = gEng.ring.pop(tbuf, 4096)) > 0) {
        for (int i = 0; i < got; i++) {
            float   f = tbuf[i];
            if (f >  1.f) f =  1.f;
            if (f < -1.f) f = -1.f;
            int32_t s = (int32_t)(f * 8388607.f);
            uint8_t b[3] = {
                (uint8_t)( s        & 0xFF),
                (uint8_t)((s >>  8) & 0xFF),
                (uint8_t)((s >> 16) & 0xFF)
            };
            fwrite(b, 1, 3, gEng.recFile);
        }
        gEng.recBytesWritten += (uint64_t)got * 3;
    }
}

// ── PortAudio callback ────────────────────────────────────────────────────────
// Called by PortAudio on the audio thread ~every 512 frames (≈10ms @ 48kHz).
// NO IPC, NO allocations for the hot path, NO blocking calls allowed here.
// Position posted every 2 callbacks (~47fps), levels every 3 (~31fps).

static int paCallback(
    const void *in_,
    void       *out_,
    unsigned long frames,
    const PaStreamCallbackTimeInfo *,
    PaStreamCallbackFlags,
    void *
) {
    Engine    &e   = gEng;
    float     *out = static_cast<float *>(out_);
    const int  n   = static_cast<int>(frames);

    // ── Diagnostic counters — first thing in every callback invocation ──────────
    gTotalCallbacks.fetch_add(1, std::memory_order_relaxed);
    gLastCbMs.store(
        (uint64_t)std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::steady_clock::now().time_since_epoch()).count(),
        std::memory_order_relaxed);

    if (e.shouldAbort.load(std::memory_order_relaxed)) {
        if (out) memset(out, 0, n * 2 * sizeof(float));
        return paAbort;
    }

    // Apply any pending seek atomically.
    {
        int64_t st = e.seekTarget.load(std::memory_order_relaxed);
        if (st >= 0) {
            e.position.store(st, std::memory_order_relaxed);
            e.seekTarget.store(-1, std::memory_order_relaxed);
        }
    }

    const int64_t pos = e.position.load(std::memory_order_relaxed);
    const int     nt  = e.numTracks;

    if (out) memset(out, 0, n * 2 * sizeof(float));

    // Per-track and master RMS accumulators.
    float tL[64] = {};
    float tR[64] = {};
    float masterL = 0.f, masterR = 0.f;
    const int ntc = nt < 64 ? nt : 64;

    for (int t = 0; t < ntc; t++) {
        const Track &tr = *e.tracks[t];
        if (tr.muted.load(std::memory_order_relaxed)) continue;

        const float  vol      = tr.volume.load(std::memory_order_relaxed);
        const float  panL     = tr.panL.load(std::memory_order_relaxed);
        const float  panR     = tr.panR.load(std::memory_order_relaxed);
        const double srcRatio = tr.srcRatio;

        float trL = 0.f, trR = 0.f;

        for (int i = 0; i < n; i++) {
            const int64_t p = pos + i;
            if (p < tr.startSample || p >= tr.endSample) continue;

            const int64_t srcIdx = tr.offsetSamples +
                static_cast<int64_t>((double)(p - tr.startSample) * srcRatio + 0.5);
            if (srcIdx < 0 || srcIdx >= tr.numFrames) continue;

            const float l = tr.left[srcIdx]  * vol * panL;
            const float r = tr.right[srcIdx] * vol * panR;
            if (out) {
                out[i * 2]     += l;
                out[i * 2 + 1] += r;
            }
            trL += l * l;
            trR += r * r;
        }
        tL[t]   = trL;
        tR[t]   = trR;
        masterL += trL;
        masterR += trR;
    }

    // Hard clip output.
    if (out) {
        for (int i = 0; i < n; i++) {
            if (out[i*2]   >  1.f) out[i*2]   =  1.f;
            if (out[i*2]   < -1.f) out[i*2]   = -1.f;
            if (out[i*2+1] >  1.f) out[i*2+1] =  1.f;
            if (out[i*2+1] < -1.f) out[i*2+1] = -1.f;
        }
    }

    const int64_t newPos = pos + n;
    e.position.store(newPos, std::memory_order_relaxed);

    // Recording input: push to ring buffer and compute input RMS.
    // De-interleave the selected mono channel into a stereo WAV stream.
    float inRmsL = 0.f, inRmsR = 0.f;
    const bool rec = e.isRecording.load(std::memory_order_relaxed) != 0;
    if (rec && in_) {
        const float *inp   = static_cast<const float *>(in_);
        const int    inCh  = e.recInputNumCh;
        const int    chOff = e.recInputChOffset;
        // Use a stack buffer: max 4096 frames × 2 (stereo WAV output)
        float monoBuf[4096 * 2];
        const int nCap = n < 4096 ? n : 4096;
        for (int i = 0; i < nCap; i++) {
            float s = inp[i * inCh + chOff];
            monoBuf[i*2]   = s;
            monoBuf[i*2+1] = s;
            inRmsL += s * s;
            inRmsR += s * s;
        }
        e.ring.push(monoBuf, nCap * 2);
    }

    // Auto-end (playback-only sessions; recording runs until stopRecord).
    if (!rec && nt > 0) {
        bool allEnded = true;
        for (int t = 0; t < nt && allEnded; t++)
            if (newPos < e.tracks[t]->endSample) allEnded = false;

        if (allEnded) {
            if (out) memset(out, 0, n * 2 * sizeof(float));
            e.active.store(0, std::memory_order_relaxed);

            auto *pkt = new EndPacket{(double)newPos / e.sampleRate};
            e.tsfEnded.NonBlockingCall(pkt,
                [](Napi::Env env, Napi::Function cb, EndPacket *d) {
                    cb.Call({Napi::Number::New(env, d->pos)});
                    delete d;
                });
            return paComplete;
        }
    }

    // Throttled event dispatch.
    e.cbCount++;

    // Position: every 2 callbacks (~47fps @ 512fr/48kHz).
    if (e.cbCount % 2 == 0) {
        auto *pkt = new PosPacket{(double)newPos / e.sampleRate};
        e.tsfPos.NonBlockingCall(pkt,
            [](Napi::Env env, Napi::Function cb, PosPacket *d) {
                cb.Call({Napi::Number::New(env, d->pos)});
                delete d;
            });
    }

    // Master levels + per-track levels: every 3 callbacks (~31fps).
    if (e.cbCount % 3 == 0) {
        {
            auto *pkt = new LevPacket{
                std::sqrt(masterL / n),
                std::sqrt(masterR / n)
            };
            e.tsfLevels.NonBlockingCall(pkt,
                [](Napi::Env env, Napi::Function cb, LevPacket *d) {
                    Napi::Array a = Napi::Array::New(env, 2);
                    a.Set(0u, Napi::Number::New(env, d->l));
                    a.Set(1u, Napi::Number::New(env, d->r));
                    cb.Call({a});
                    delete d;
                });
        }
        {
            auto *pkt = new TrLPacket{};
            pkt->n = ntc;
            for (int t = 0; t < ntc; t++) {
                pkt->lr[t*2]     = std::sqrt(tL[t] / n);
                pkt->lr[t*2 + 1] = std::sqrt(tR[t] / n);
            }
            e.tsfTrLev.NonBlockingCall(pkt,
                [](Napi::Env env, Napi::Function cb, TrLPacket *d) {
                    Napi::Array a = Napi::Array::New(env, d->n * 2);
                    for (int i = 0; i < d->n * 2; i++)
                        a.Set((uint32_t)i, Napi::Number::New(env, d->lr[i]));
                    cb.Call({a});
                    delete d;
                });
        }

        // Input levels (recording only).
        if (rec && e.tsfInputLevCreated) {
            auto *pkt = new LevPacket{
                std::sqrt(inRmsL / n),
                std::sqrt(inRmsR / n)
            };
            e.tsfInputLevels.NonBlockingCall(pkt,
                [](Napi::Env env, Napi::Function cb, LevPacket *d) {
                    Napi::Array a = Napi::Array::New(env, 2);
                    a.Set(0u, Napi::Number::New(env, d->l));
                    a.Set(1u, Napi::Number::New(env, d->r));
                    cb.Call({a});
                    delete d;
                });
        }
    }

    return paContinue;
}

// ── StopRecordWorker ──────────────────────────────────────────────────────────
// Execute() runs on libuv pool: aborts stream, joins write thread, patches WAV.
// OnOK() runs on V8 thread: releases TSFNs, resolves Promise.

class StopRecordWorker : public Napi::AsyncWorker {
public:
    std::string resultPath;
    double      resultDuration = 0.0;

    StopRecordWorker(Napi::Env env, Napi::Promise::Deferred def)
        : Napi::AsyncWorker(env), _def(std::move(def)) {}

    void Execute() override {
        gEng.isRecording.store(0, std::memory_order_relaxed);
        gEng.active.store(0, std::memory_order_relaxed);

        if (gEng.stream) {
            Pa_AbortStream(gEng.stream);
            Pa_CloseStream(gEng.stream);
        }

        gEng.writeThreadStop.store(1, std::memory_order_relaxed);
        if (gEng.writeThread.joinable())
            gEng.writeThread.join();

        if (gEng.recFile) {
            patchWavHeader(gEng.recFile, gEng.recBytesWritten);
            fclose(gEng.recFile);
            gEng.recFile = nullptr;
        }

        resultPath     = gEng.recFilePath;
        resultDuration = (gEng.recSr > 0 && gEng.recCh > 0)
            ? (double)gEng.recBytesWritten / ((double)gEng.recSr * gEng.recCh * 3.0)
            : 0.0;
    }

    void OnOK() override {
        // V8 thread — safe to release TSFNs here.
        gEng.stream = nullptr;
        gEng.releaseTsfns();
        gEng.clearTracks();

        Napi::Object r = Napi::Object::New(Env());
        r.Set("filePath", Napi::String::New(Env(), resultPath));
        r.Set("duration", Napi::Number::New(Env(), resultDuration));
        _def.Resolve(r);
    }

    void OnError(const Napi::Error &e) override {
        _def.Reject(e.Value());
    }

private:
    Napi::Promise::Deferred _def;
};

// ── Helper: parse and copy tracks from JS array ───────────────────────────────

static void parseTracks(const Napi::Array &arr) {
    uint32_t num = arr.Length();
    gEng.tracks.reserve(num);
    for (uint32_t i = 0; i < num; i++) {
        Napi::Object       obj  = arr.Get(i).As<Napi::Object>();
        Napi::Float32Array lArr = obj.Get("left").As<Napi::Float32Array>();
        Napi::Float32Array rArr = obj.Get("right").As<Napi::Float32Array>();

        auto *tr       = new Track{};
        tr->numFrames  = static_cast<int64_t>(lArr.ElementLength());
        tr->left       = new float[tr->numFrames];
        tr->right      = new float[tr->numFrames];
        memcpy(tr->left,  lArr.Data(), tr->numFrames * sizeof(float));
        memcpy(tr->right, rArr.Data(), tr->numFrames * sizeof(float));

        tr->startSample   = static_cast<int64_t>(obj.Get("startSample").As<Napi::Number>().DoubleValue());
        tr->endSample     = static_cast<int64_t>(obj.Get("endSample").As<Napi::Number>().DoubleValue());
        tr->offsetSamples = static_cast<int64_t>(obj.Get("offsetSamples").As<Napi::Number>().DoubleValue());
        tr->srcRatio      = obj.Get("srcRatio").As<Napi::Number>().DoubleValue();
        tr->volume.store(obj.Get("volume").As<Napi::Number>().FloatValue(), std::memory_order_relaxed);
        tr->panL.store(  obj.Get("panL").As<Napi::Number>().FloatValue(),   std::memory_order_relaxed);
        tr->panR.store(  obj.Get("panR").As<Napi::Number>().FloatValue(),   std::memory_order_relaxed);
        tr->muted.store( obj.Get("muted").As<Napi::Number>().Int32Value(),  std::memory_order_relaxed);
        gEng.tracks.push_back(tr);
    }
    gEng.numTracks = static_cast<int>(num);
}

// ── N-API exports ─────────────────────────────────────────────────────────────

// play(deviceId, sampleRate, startSample, tracks[], onPos, onLevels, onTrLev, onEnded)
Napi::Value Play(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (info.Length() < 8) {
        Napi::TypeError::New(env, "play: expected 8 args").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    int     deviceId    = info[0].As<Napi::Number>().Int32Value();
    int     sampleRate  = info[1].As<Napi::Number>().Int32Value();
    int64_t startSample = static_cast<int64_t>(info[2].As<Napi::Number>().DoubleValue());

    gEng.teardown();
    gEng.sampleRate = sampleRate;
    parseTracks(info[3].As<Napi::Array>());

    gEng.position.store(startSample, std::memory_order_relaxed);
    gEng.seekTarget.store(-1, std::memory_order_relaxed);
    gEng.shouldAbort.store(0, std::memory_order_relaxed);
    gEng.active.store(1, std::memory_order_relaxed);
    gEng.cbCount = 0;

    gEng.tsfPos    = Napi::ThreadSafeFunction::New(env, info[4].As<Napi::Function>(), "pa:pos",   0, 1);
    gEng.tsfLevels = Napi::ThreadSafeFunction::New(env, info[5].As<Napi::Function>(), "pa:lev",   0, 1);
    gEng.tsfTrLev  = Napi::ThreadSafeFunction::New(env, info[6].As<Napi::Function>(), "pa:trlev", 0, 1);
    gEng.tsfEnded  = Napi::ThreadSafeFunction::New(env, info[7].As<Napi::Function>(), "pa:ended", 0, 1);
    gEng.tsfCreated = true;

    PaStreamParameters outP{};
    outP.device           = (deviceId >= 0) ? deviceId : Pa_GetDefaultOutputDevice();
    outP.channelCount     = 2;
    outP.sampleFormat     = paFloat32;
    outP.suggestedLatency = Pa_GetDeviceInfo(outP.device)
        ? Pa_GetDeviceInfo(outP.device)->defaultLowOutputLatency : 0.02;
    outP.hostApiSpecificStreamInfo = nullptr;

    PaError err = Pa_OpenStream(&gEng.stream, nullptr, &outP,
                                 sampleRate, 512, paNoFlag, paCallback, nullptr);
    if (err != paNoError) {
        gEng.teardown();
        Napi::Error::New(env, std::string("Pa_OpenStream: ") + Pa_GetErrorText(err))
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    err = Pa_StartStream(gEng.stream);
    if (err != paNoError) {
        gEng.teardown();
        Napi::Error::New(env, std::string("Pa_StartStream: ") + Pa_GetErrorText(err))
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    return env.Undefined();
}

// record(inDev, outDev, sampleRate, startSample, filePath, tracks[],
//        onPos, onLevels, onTrLev, onInputLevels, onEnded [, channelOffset=0])
//
// channelOffset (optional 12th arg): 0-indexed input channel to record from.
// The input stream is opened with max(channelOffset+1, 2) channels so the
// selected channel is always in range. Mono capture is written as stereo WAV
// (same sample on L and R) so the rest of the pipeline is unchanged.
//
// For ASIO: inDev and outDev must be the same physical device (ASIO is exclusive,
// single-stream). Pa_OpenStream opens a single full-duplex stream over that device.
// For WASAPI fallback: they may differ.
Napi::Value Record(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (info.Length() < 11) {
        Napi::TypeError::New(env, "record: expected 11 args").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    int     inDevId     = info[0].As<Napi::Number>().Int32Value();
    int     outDevId    = info[1].As<Napi::Number>().Int32Value();
    int     sampleRate  = info[2].As<Napi::Number>().Int32Value();
    int64_t startSample = static_cast<int64_t>(info[3].As<Napi::Number>().DoubleValue());
    std::string filePath = info[4].As<Napi::String>().Utf8Value();

    // Optional 12th arg: 0-indexed input channel to capture (default = 0).
    int chOffset = 0;
    if (info.Length() >= 12 && info[11].IsNumber())
        chOffset = info[11].As<Napi::Number>().Int32Value();
    if (chOffset < 0) chOffset = 0;

    gEng.teardown();
    gEng.sampleRate          = sampleRate;
    gEng.recSr               = sampleRate;
    gEng.recCh               = 2;
    gEng.recInputChOffset    = chOffset;
    gEng.recInputNumCh       = (chOffset + 1 > 2) ? chOffset + 1 : 2;
    gEng.recBytesWritten     = 0;
    strncpy(gEng.recFilePath, filePath.c_str(), sizeof(gEng.recFilePath) - 1);
    gEng.recFilePath[sizeof(gEng.recFilePath) - 1] = '\0';

    // Open WAV file.
    gEng.recFile = fopen(gEng.recFilePath, "wb");
    if (!gEng.recFile) {
        Napi::Error::New(env, std::string("Cannot open file for recording: ") + gEng.recFilePath)
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }
    writeWavHeader(gEng.recFile, sampleRate, 2);

    // Reset ring buffer.
    gEng.ring.head.store(0, std::memory_order_relaxed);
    gEng.ring.tail.store(0, std::memory_order_relaxed);

    parseTracks(info[5].As<Napi::Array>());

    gEng.position.store(startSample, std::memory_order_relaxed);
    gEng.recStartSample = startSample;
    gEng.seekTarget.store(-1, std::memory_order_relaxed);
    gEng.shouldAbort.store(0, std::memory_order_relaxed);
    gEng.active.store(1, std::memory_order_relaxed);
    gEng.cbCount = 0;

    gEng.tsfPos    = Napi::ThreadSafeFunction::New(env, info[6].As<Napi::Function>(),  "pa:pos",   0, 1);
    gEng.tsfLevels = Napi::ThreadSafeFunction::New(env, info[7].As<Napi::Function>(),  "pa:lev",   0, 1);
    gEng.tsfTrLev  = Napi::ThreadSafeFunction::New(env, info[8].As<Napi::Function>(),  "pa:trlev", 0, 1);
    gEng.tsfEnded  = Napi::ThreadSafeFunction::New(env, info[10].As<Napi::Function>(), "pa:ended", 0, 1);
    gEng.tsfCreated = true;

    gEng.tsfInputLevels    = Napi::ThreadSafeFunction::New(env, info[9].As<Napi::Function>(), "pa:inlev", 0, 1);
    gEng.tsfInputLevCreated = true;

    // Start write thread before opening stream so it's ready immediately.
    gEng.writeThreadStop.store(0, std::memory_order_relaxed);
    gEng.writeThread = std::thread(writeThreadFn);

    // Build stream params.
    PaStreamParameters inP{};
    inP.device         = (inDevId >= 0) ? inDevId : Pa_GetDefaultInputDevice();
    inP.channelCount   = gEng.recInputNumCh;   // enough channels to reach the chosen offset
    inP.sampleFormat   = paFloat32;
    inP.suggestedLatency = Pa_GetDeviceInfo(inP.device)
        ? Pa_GetDeviceInfo(inP.device)->defaultLowInputLatency : 0.02;
    inP.hostApiSpecificStreamInfo = nullptr;

    // Output is optional — pass nullptr if no output device (input-only recording).
    PaStreamParameters outP{};
    const PaStreamParameters *pOut = nullptr;
    if (outDevId >= 0) {
        outP.device         = outDevId;
        outP.channelCount   = 2;
        outP.sampleFormat   = paFloat32;
        outP.suggestedLatency = Pa_GetDeviceInfo(outP.device)
            ? Pa_GetDeviceInfo(outP.device)->defaultLowOutputLatency : 0.02;
        outP.hostApiSpecificStreamInfo = nullptr;
        pOut = &outP;
    }

    gEng.isRecording.store(1, std::memory_order_relaxed);

    PaError err = Pa_OpenStream(&gEng.stream, &inP, pOut,
                                 sampleRate, 512, paNoFlag, paCallback, nullptr);
    if (err != paNoError) {
        gEng.teardown();
        Napi::Error::New(env, std::string("Pa_OpenStream (record): ") + Pa_GetErrorText(err))
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    err = Pa_StartStream(gEng.stream);
    if (err != paNoError) {
        gEng.teardown();
        Napi::Error::New(env, std::string("Pa_StartStream (record): ") + Pa_GetErrorText(err))
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    return env.Undefined();
}

// stopRecord() → Promise<{filePath:string, duration:number}>
Napi::Value StopRecord(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    auto def      = Napi::Promise::Deferred::New(env);
    auto *worker  = new StopRecordWorker(env, def);
    worker->Queue();
    return def.Promise();
}

// seek(samplePos) — atomic; effective at next callback frame
Napi::Value Seek(const Napi::CallbackInfo &info) {
    int64_t target = static_cast<int64_t>(info[0].As<Napi::Number>().DoubleValue());
    if (target < 0) target = 0;
    gEng.seekTarget.store(target, std::memory_order_relaxed);
    return info.Env().Undefined();
}

// abort() — Pa_AbortStream + immediate cleanup
Napi::Value Abort(const Napi::CallbackInfo &info) {
    gEng.shouldAbort.store(1, std::memory_order_relaxed);
    gEng.active.store(0, std::memory_order_relaxed);
    if (gEng.stream) {
        Pa_AbortStream(gEng.stream);
        Pa_CloseStream(gEng.stream);
        gEng.stream = nullptr;
    }
    // If a write thread is running, stop it (incomplete take — no header patch).
    if (gEng.writeThread.joinable()) {
        gEng.writeThreadStop.store(1, std::memory_order_relaxed);
        gEng.writeThread.join();
    }
    if (gEng.recFile) { fclose(gEng.recFile); gEng.recFile = nullptr; }
    gEng.isRecording.store(0, std::memory_order_relaxed);
    gEng.releaseTsfns();
    gEng.clearTracks();
    return info.Env().Undefined();
}

// getPosition() → number (samples)
Napi::Value GetPosition(const Napi::CallbackInfo &info) {
    return Napi::Number::New(info.Env(),
        static_cast<double>(gEng.position.load(std::memory_order_relaxed)));
}

// setTrackParam(idx, volume, panL, panR, muted)
Napi::Value SetTrackParam(const Napi::CallbackInfo &info) {
    int idx = info[0].As<Napi::Number>().Int32Value();
    if (idx < 0 || idx >= gEng.numTracks) return info.Env().Undefined();
    Track *tr = gEng.tracks[idx];
    tr->volume.store(info[1].As<Napi::Number>().FloatValue(), std::memory_order_relaxed);
    tr->panL.store(  info[2].As<Napi::Number>().FloatValue(), std::memory_order_relaxed);
    tr->panR.store(  info[3].As<Napi::Number>().FloatValue(), std::memory_order_relaxed);
    tr->muted.store( info[4].As<Napi::Number>().Int32Value(), std::memory_order_relaxed);
    return info.Env().Undefined();
}

// isActive() → bool
Napi::Value IsActive(const Napi::CallbackInfo &info) {
    return Napi::Boolean::New(info.Env(),
        gEng.active.load(std::memory_order_relaxed) != 0);
}

// dispose() — full teardown (called on Electron quit / renderer reload)
Napi::Value Dispose(const Napi::CallbackInfo &info) {
    gEng.teardown();
    return info.Env().Undefined();
}

// getDiag() → { totalCallbacks, lastCbMs, positionSecs, streamActive, isRecording }
// Polls the atomic counters written by paCallback. Safe to call any time from V8 thread.
Napi::Value GetDiag(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    const uint64_t total   = gTotalCallbacks.load(std::memory_order_relaxed);
    const uint64_t lastMs  = gLastCbMs.load(std::memory_order_relaxed);
    const int64_t  posSmp  = gEng.position.load(std::memory_order_relaxed);
    const bool     active  = gEng.active.load(std::memory_order_relaxed) != 0;
    const bool     rec     = gEng.isRecording.load(std::memory_order_relaxed) != 0;
    const int      sr      = gEng.sampleRate > 0 ? gEng.sampleRate : 48000;

    Napi::Object r = Napi::Object::New(env);
    r.Set("totalCallbacks", Napi::Number::New(env, (double)total));
    r.Set("lastCbMs",       Napi::Number::New(env, (double)lastMs));
    r.Set("positionSecs",   Napi::Number::New(env, (double)posSmp / sr));
    r.Set("streamActive",   Napi::Boolean::New(env, active));
    r.Set("isRecording",    Napi::Boolean::New(env, rec));
    return r;
}

// ── Module init ───────────────────────────────────────────────────────────────

static bool gPaInitialized = false;

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    if (!gPaInitialized) {
        PaError err = Pa_Initialize();
        if (err == paNoError) gPaInitialized = true;
        // If already initialized by naudiodon, that's fine — Pa_Initialize is ref-counted.
    }

    exports.Set("play",          Napi::Function::New(env, Play));
    exports.Set("record",        Napi::Function::New(env, Record));
    exports.Set("stopRecord",    Napi::Function::New(env, StopRecord));
    exports.Set("seek",          Napi::Function::New(env, Seek));
    exports.Set("abort",         Napi::Function::New(env, Abort));
    exports.Set("getPosition",   Napi::Function::New(env, GetPosition));
    exports.Set("setTrackParam", Napi::Function::New(env, SetTrackParam));
    exports.Set("isActive",      Napi::Function::New(env, IsActive));
    exports.Set("dispose",       Napi::Function::New(env, Dispose));
    exports.Set("getDiag",       Napi::Function::New(env, GetDiag));

    return exports;
}

NODE_API_MODULE(pa_callback, Init)
