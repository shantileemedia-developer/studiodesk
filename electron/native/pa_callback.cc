// pa_callback.cc — PortAudio callback-mode playback engine
//
// Links against naudiodon's pre-compiled portaudio_x64.dll (Windows x64, ASIO+WASAPI).
// This avoids recompiling PortAudio or bundling the ASIO SDK.
//
// JS API (all synchronous unless noted):
//   play(deviceId, sampleRate, startSample, tracks[], onPos, onLevels, onTrLev, onEnded)
//   seek(samplePos)          — atomic; takes effect at next callback frame
//   abort()                  — Pa_AbortStream; silence immediately, no drain
//   getPosition() → number   — current engine position in samples
//   setTrackParam(idx, vol, panL, panR, muted)
//   dispose()                — Pa_AbortStream + Pa_CloseStream + release TSFNs
//
// Track JS object shape:
//   { left: Float32Array, right: Float32Array,
//     startSample, endSample, offsetSamples, srcRatio }
//
// Thread model:
//   Audio thread  — PortAudio callback: reads atomics + track PCM data (read-only after play).
//   V8 thread     — all JS calls, TSFN callbacks.
//   Atomics are the only cross-thread synchronisation.

#define NAPI_VERSION 6
#include <napi.h>
#include <portaudio.h>

#include <atomic>
#include <cmath>
#include <cstring>
#include <vector>
#include <string>
#include <memory>

// ── Track state (native heap, written once before play, read-only in callback) ──

struct Track {
    float   *left          = nullptr;
    float   *right         = nullptr;
    int64_t  numFrames     = 0;
    int64_t  startSample   = 0;
    int64_t  endSample     = 0;
    int64_t  offsetSamples = 0;
    double   srcRatio      = 1.0;

    // Writable from JS thread via setTrackParam (read in callback via atomics)
    std::atomic<float> volume{1.f};
    std::atomic<float> panL{0.707f};
    std::atomic<float> panR{0.707f};
    std::atomic<int>   muted{0};

    ~Track() { delete[] left; delete[] right; }
    Track() = default;
    Track(const Track&) = delete;
    Track& operator=(const Track&) = delete;
};

// ── Data packets sent through ThreadSafeFunction queues ──────────────────────

struct PosPacket  { double   pos;      };
struct LevPacket  { float    l, r;     };
struct TrLPacket  { int      n;
                    float    lr[64*2]; };  // [L0,R0, L1,R1, …]
struct EndPacket  { double   pos;      };

// ── Engine (one global instance) ──────────────────────────────────────────────

static struct Engine {
    // Track array: written before Pa_StartStream, read-only after
    std::vector<Track*> tracks;
    int numTracks = 0;

    // Atomics: read by audio callback, written by JS thread
    std::atomic<int64_t> position{0};
    std::atomic<int64_t> seekTarget{-1};
    std::atomic<int>     shouldAbort{0};
    std::atomic<int>     active{0};

    int sampleRate = 48000;
    PaStream *stream = nullptr;

    Napi::ThreadSafeFunction tsfPos;
    Napi::ThreadSafeFunction tsfLevels;
    Napi::ThreadSafeFunction tsfTrLev;
    Napi::ThreadSafeFunction tsfEnded;
    bool tsfCreated = false;

    void releaseTsfns() {
        if (!tsfCreated) return;
        tsfPos.Release();
        tsfLevels.Release();
        tsfTrLev.Release();
        tsfEnded.Release();
        tsfCreated = false;
    }

    void clearTracks() {
        for (auto *t : tracks) delete t;
        tracks.clear();
        numTracks = 0;
    }

    // Full teardown: abort stream, close, release TSFNs, free track data.
    // Safe to call from any thread (Pa_AbortStream is thread-safe per PortAudio docs).
    void teardown() {
        shouldAbort.store(1, std::memory_order_relaxed);
        active.store(0, std::memory_order_relaxed);
        if (stream) {
            Pa_AbortStream(stream);
            Pa_CloseStream(stream);
            stream = nullptr;
        }
        releaseTsfns();
        clearTracks();
    }

} gEng;

// ── PortAudio callback (audio thread, ~10ms period at 512 frames/48kHz) ──────

static int paCallback(
    const void *, void *out_,
    unsigned long frames,
    const PaStreamCallbackTimeInfo *,
    PaStreamCallbackFlags,
    void *
) {
    Engine &e   = gEng;
    float  *out = static_cast<float *>(out_);
    const int n = static_cast<int>(frames);

    if (e.shouldAbort.load(std::memory_order_relaxed)) {
        memset(out, 0, n * 2 * sizeof(float));
        return paAbort;
    }

    // Apply pending seek atomically
    {
        int64_t st = e.seekTarget.load(std::memory_order_relaxed);
        if (st >= 0) {
            e.position.store(st, std::memory_order_relaxed);
            e.seekTarget.store(-1, std::memory_order_relaxed);
        }
    }

    const int64_t pos = e.position.load(std::memory_order_relaxed);
    const int     nt  = e.numTracks;

    memset(out, 0, n * 2 * sizeof(float));

    // Per-track RMS accumulators (stack, max 64 tracks)
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
            out[i * 2]     += l;
            out[i * 2 + 1] += r;
            trL += l * l;
            trR += r * r;
        }

        tL[t] = trL;
        tR[t] = trR;
        masterL += trL;
        masterR += trR;
    }

    // Hard clip
    for (int i = 0; i < n; i++) {
        if (out[i*2]   >  1.f) out[i*2]   =  1.f;
        if (out[i*2]   < -1.f) out[i*2]   = -1.f;
        if (out[i*2+1] >  1.f) out[i*2+1] =  1.f;
        if (out[i*2+1] < -1.f) out[i*2+1] = -1.f;
    }

    // Advance position
    const int64_t newPos = pos + n;
    e.position.store(newPos, std::memory_order_relaxed);

    // Auto-end: all clips past their end sample
    bool allEnded = (nt > 0);
    for (int t = 0; t < nt && allEnded; t++) {
        if (newPos < e.tracks[t]->endSample) allEnded = false;
    }

    if (allEnded) {
        memset(out, 0, n * 2 * sizeof(float));
        e.active.store(0, std::memory_order_relaxed);

        auto *pkt = new EndPacket{(double)newPos / e.sampleRate};
        e.tsfEnded.NonBlockingCall(pkt,
            [](Napi::Env env, Napi::Function cb, EndPacket *d) {
                cb.Call({Napi::Number::New(env, d->pos)});
                delete d;
            });
        return paComplete;
    }

    // Post position (every callback = ~10ms)
    {
        auto *pkt = new PosPacket{(double)newPos / e.sampleRate};
        e.tsfPos.NonBlockingCall(pkt,
            [](Napi::Env env, Napi::Function cb, PosPacket *d) {
                cb.Call({Napi::Number::New(env, d->pos)});
                delete d;
            });
    }

    // Post master levels
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

    // Post per-track levels (flat [L0,R0, L1,R1, …])
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

    return paContinue;
}

// ── N-API exported functions ──────────────────────────────────────────────────

// play(deviceId, sampleRate, startSample, tracks[], onPos, onLevels, onTrLev, onEnded)
//
// tracks[] element shape:
//   { left: Float32Array, right: Float32Array,
//     startSample, endSample, offsetSamples, srcRatio,
//     volume, panL, panR, muted }
Napi::Value Play(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();

    if (info.Length() < 8) {
        Napi::TypeError::New(env, "play: expected 8 arguments").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    int     deviceId    = info[0].As<Napi::Number>().Int32Value();
    int     sampleRate  = info[1].As<Napi::Number>().Int32Value();
    int64_t startSample = static_cast<int64_t>(info[2].As<Napi::Number>().DoubleValue());

    Napi::Array tracksArr = info[3].As<Napi::Array>();
    Napi::Function cbPos     = info[4].As<Napi::Function>();
    Napi::Function cbLevels  = info[5].As<Napi::Function>();
    Napi::Function cbTrLev   = info[6].As<Napi::Function>();
    Napi::Function cbEnded   = info[7].As<Napi::Function>();

    // Teardown any active session
    gEng.teardown();

    gEng.sampleRate = sampleRate;

    // Parse track data and copy PCM to native heap
    uint32_t numTracks = tracksArr.Length();
    gEng.tracks.reserve(numTracks);

    for (uint32_t i = 0; i < numTracks; i++) {
        Napi::Object obj = tracksArr.Get(i).As<Napi::Object>();

        Napi::Float32Array leftArr  = obj.Get("left").As<Napi::Float32Array>();
        Napi::Float32Array rightArr = obj.Get("right").As<Napi::Float32Array>();

        auto *tr = new Track{};
        tr->numFrames     = static_cast<int64_t>(leftArr.ElementLength());
        tr->left          = new float[tr->numFrames];
        tr->right         = new float[tr->numFrames];
        memcpy(tr->left,  leftArr.Data(),  tr->numFrames * sizeof(float));
        memcpy(tr->right, rightArr.Data(), tr->numFrames * sizeof(float));

        tr->startSample   = static_cast<int64_t>(obj.Get("startSample").As<Napi::Number>().DoubleValue());
        tr->endSample     = static_cast<int64_t>(obj.Get("endSample").As<Napi::Number>().DoubleValue());
        tr->offsetSamples = static_cast<int64_t>(obj.Get("offsetSamples").As<Napi::Number>().DoubleValue());
        tr->srcRatio      = obj.Get("srcRatio").As<Napi::Number>().DoubleValue();

        tr->volume.store(obj.Get("volume").As<Napi::Number>().FloatValue(), std::memory_order_relaxed);
        tr->panL.store(obj.Get("panL").As<Napi::Number>().FloatValue(),   std::memory_order_relaxed);
        tr->panR.store(obj.Get("panR").As<Napi::Number>().FloatValue(),   std::memory_order_relaxed);
        tr->muted.store(obj.Get("muted").As<Napi::Number>().Int32Value(), std::memory_order_relaxed);

        gEng.tracks.push_back(tr);
    }
    gEng.numTracks = static_cast<int>(numTracks);

    // Set up position and control atomics
    gEng.position.store(startSample, std::memory_order_relaxed);
    gEng.seekTarget.store(-1, std::memory_order_relaxed);
    gEng.shouldAbort.store(0, std::memory_order_relaxed);
    gEng.active.store(1, std::memory_order_relaxed);

    // Create ThreadSafeFunctions
    gEng.tsfPos    = Napi::ThreadSafeFunction::New(env, cbPos,    "pa:pos",    0, 1);
    gEng.tsfLevels = Napi::ThreadSafeFunction::New(env, cbLevels, "pa:lev",    0, 1);
    gEng.tsfTrLev  = Napi::ThreadSafeFunction::New(env, cbTrLev,  "pa:trlev",  0, 1);
    gEng.tsfEnded  = Napi::ThreadSafeFunction::New(env, cbEnded,  "pa:ended",  0, 1);
    gEng.tsfCreated = true;

    // Open PortAudio stream in callback mode
    PaStreamParameters outParams{};
    outParams.device           = (deviceId >= 0) ? deviceId : Pa_GetDefaultOutputDevice();
    outParams.channelCount     = 2;
    outParams.sampleFormat     = paFloat32;
    outParams.suggestedLatency = Pa_GetDeviceInfo(outParams.device)
                                    ? Pa_GetDeviceInfo(outParams.device)->defaultLowOutputLatency
                                    : 0.02;
    outParams.hostApiSpecificStreamInfo = nullptr;

    PaError err = Pa_OpenStream(
        &gEng.stream,
        nullptr,       // no input
        &outParams,
        sampleRate,
        512,           // framesPerBuffer
        paNoFlag,
        paCallback,
        nullptr        // userData — we use the global gEng directly
    );

    if (err != paNoError) {
        gEng.teardown();
        Napi::Error::New(env, std::string("Pa_OpenStream failed: ") + Pa_GetErrorText(err))
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    err = Pa_StartStream(gEng.stream);
    if (err != paNoError) {
        gEng.teardown();
        Napi::Error::New(env, std::string("Pa_StartStream failed: ") + Pa_GetErrorText(err))
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    return env.Undefined();
}

// seek(samplePosition) — atomic; takes effect at next callback frame
Napi::Value Seek(const Napi::CallbackInfo &info) {
    int64_t target = static_cast<int64_t>(info[0].As<Napi::Number>().DoubleValue());
    if (target < 0) target = 0;
    gEng.seekTarget.store(target, std::memory_order_relaxed);
    return info.Env().Undefined();
}

// abort() — Pa_AbortStream; stops immediately, no drain
Napi::Value Abort(const Napi::CallbackInfo &info) {
    gEng.shouldAbort.store(1, std::memory_order_relaxed);
    gEng.active.store(0, std::memory_order_relaxed);
    if (gEng.stream) {
        Pa_AbortStream(gEng.stream);
        Pa_CloseStream(gEng.stream);
        gEng.stream = nullptr;
    }
    gEng.releaseTsfns();
    gEng.clearTracks();
    return info.Env().Undefined();
}

// getPosition() → number (samples)
Napi::Value GetPosition(const Napi::CallbackInfo &info) {
    double pos = static_cast<double>(gEng.position.load(std::memory_order_relaxed));
    return Napi::Number::New(info.Env(), pos);
}

// setTrackParam(idx, volume, panL, panR, muted)
Napi::Value SetTrackParam(const Napi::CallbackInfo &info) {
    int idx = info[0].As<Napi::Number>().Int32Value();
    if (idx < 0 || idx >= gEng.numTracks) return info.Env().Undefined();
    Track *tr = gEng.tracks[idx];
    tr->volume.store(info[1].As<Napi::Number>().FloatValue(), std::memory_order_relaxed);
    tr->panL.store(info[2].As<Napi::Number>().FloatValue(),   std::memory_order_relaxed);
    tr->panR.store(info[3].As<Napi::Number>().FloatValue(),   std::memory_order_relaxed);
    tr->muted.store(info[4].As<Napi::Number>().Int32Value(),  std::memory_order_relaxed);
    return info.Env().Undefined();
}

// isActive() → bool
Napi::Value IsActive(const Napi::CallbackInfo &info) {
    return Napi::Boolean::New(info.Env(), gEng.active.load(std::memory_order_relaxed) != 0);
}

// dispose() — full teardown
Napi::Value Dispose(const Napi::CallbackInfo &info) {
    gEng.teardown();
    return info.Env().Undefined();
}

// ── Module init ───────────────────────────────────────────────────────────────

static bool gPaInitialized = false;

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    // Initialize PortAudio once (if naudiodon hasn't already — Pa_Initialize is ref-counted)
    if (!gPaInitialized) {
        PaError err = Pa_Initialize();
        if (err == paNoError) gPaInitialized = true;
        // If it fails, Pa is already initialized by naudiodon — that's fine
    }

    exports.Set("play",          Napi::Function::New(env, Play));
    exports.Set("seek",          Napi::Function::New(env, Seek));
    exports.Set("abort",         Napi::Function::New(env, Abort));
    exports.Set("getPosition",   Napi::Function::New(env, GetPosition));
    exports.Set("setTrackParam", Napi::Function::New(env, SetTrackParam));
    exports.Set("isActive",      Napi::Function::New(env, IsActive));
    exports.Set("dispose",       Napi::Function::New(env, Dispose));

    return exports;
}

NODE_API_MODULE(pa_callback, Init)
