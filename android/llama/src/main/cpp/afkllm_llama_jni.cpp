#include <jni.h>
#include <string>
#include <mutex>
#include <atomic>
#include <vector>
#include <algorithm>
#include <unistd.h>
#include <android/log.h>

#define LOG_TAG "afkllm_llama"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

static std::mutex g_mu;
static std::string g_model_path;
static std::atomic<bool> g_loaded{false};
static std::atomic<bool> g_cancel{false};

#ifdef AFKLLM_WITH_LLAMA
#include "llama.h"

static llama_model * g_model = nullptr;
static llama_context * g_ctx = nullptr;
static const llama_vocab * g_vocab = nullptr;

static void free_llama_locked() {
    if (g_ctx) {
        llama_free(g_ctx);
        g_ctx = nullptr;
    }
    if (g_model) {
        llama_model_free(g_model);
        g_model = nullptr;
    }
    g_vocab = nullptr;
    g_loaded = false;
}
#endif

extern "C" JNIEXPORT jboolean JNICALL
Java_com_afkllm_llama_NativeLlama_nativeAvailable(JNIEnv *, jclass) {
#ifdef AFKLLM_WITH_LLAMA
    return JNI_TRUE;
#else
    return JNI_FALSE;
#endif
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_afkllm_llama_NativeLlama_nativeLoad(JNIEnv *env, jclass, jstring path) {
    const char *cpath = env->GetStringUTFChars(path, nullptr);
    std::string pathStr = cpath ? cpath : "";
    env->ReleaseStringUTFChars(path, cpath);

    std::lock_guard<std::mutex> lock(g_mu);
    g_model_path = pathStr;
    g_cancel = false;

#ifdef AFKLLM_WITH_LLAMA
    free_llama_locked();
    if (pathStr.empty()) {
        return env->NewStringUTF("empty path");
    }

    LOGI("loading model: %s", pathStr.c_str());
    ggml_backend_load_all();

    llama_model_params model_params = llama_model_default_params();
    model_params.n_gpu_layers = 0;

    g_model = llama_model_load_from_file(pathStr.c_str(), model_params);
    if (!g_model) {
        LOGE("failed to load model: %s", pathStr.c_str());
        return env->NewStringUTF("failed to load model");
    }
    g_vocab = llama_model_get_vocab(g_model);

    llama_context_params ctx_params = llama_context_default_params();
    ctx_params.n_ctx = 1024;
    ctx_params.n_batch = 128;
    ctx_params.n_ubatch = 128;
    const int cores = std::max(2, (int) sysconf(_SC_NPROCESSORS_ONLN));
    // OnePlus-class SoCs: use more cores for prompt eval (still leave headroom for UI)
    ctx_params.n_threads = std::min(cores, 6);
    ctx_params.n_threads_batch = ctx_params.n_threads;

    g_ctx = llama_init_from_model(g_model, ctx_params);
    if (!g_ctx) {
        LOGE("failed to create context");
        llama_model_free(g_model);
        g_model = nullptr;
        g_vocab = nullptr;
        return env->NewStringUTF("failed to create context");
    }

    g_loaded = true;
    LOGI("loaded ok ctx=%u threads=%d", llama_n_ctx(g_ctx), (int) ctx_params.n_threads);
    return env->NewStringUTF("ok");
#else
    g_loaded = !g_model_path.empty();
    if (!g_loaded) return env->NewStringUTF("empty path");
    LOGI("stub load: %s", g_model_path.c_str());
    return env->NewStringUTF("ok-stub");
#endif
}

extern "C" JNIEXPORT void JNICALL
Java_com_afkllm_llama_NativeLlama_nativeUnload(JNIEnv *, jclass) {
    std::lock_guard<std::mutex> lock(g_mu);
#ifdef AFKLLM_WITH_LLAMA
    free_llama_locked();
#else
    g_loaded = false;
#endif
    g_model_path.clear();
    g_cancel = true;
}

extern "C" JNIEXPORT jboolean JNICALL
Java_com_afkllm_llama_NativeLlama_nativeIsLoaded(JNIEnv *, jclass) {
    return g_loaded.load() ? JNI_TRUE : JNI_FALSE;
}

extern "C" JNIEXPORT void JNICALL
Java_com_afkllm_llama_NativeLlama_nativeCancel(JNIEnv *, jclass) {
    g_cancel = true;
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_afkllm_llama_NativeLlama_nativeComplete(
        JNIEnv *env,
        jclass,
        jstring prompt,
        jfloat /*temperature*/,
        jfloat /*topP*/,
        jint maxTokens,
        jobject tokenCallback
) {
    if (!g_loaded.load()) {
        return env->NewStringUTF("failed: not loaded");
    }
    g_cancel = false;
    const char *cp = env->GetStringUTFChars(prompt, nullptr);
    std::string promptStr = cp ? cp : "";
    env->ReleaseStringUTFChars(prompt, cp);

    jclass cbClass = env->GetObjectClass(tokenCallback);
    jmethodID onToken = env->GetMethodID(cbClass, "onToken", "(Ljava/lang/String;)V");

    auto emit = [&](const std::string &piece) {
        if (!onToken || piece.empty()) return;
        jstring jpiece = env->NewStringUTF(piece.c_str());
        env->CallVoidMethod(tokenCallback, onToken, jpiece);
        env->DeleteLocalRef(jpiece);
    };

#ifdef AFKLLM_WITH_LLAMA
    LOGI("complete start chars=%zu", promptStr.size());
    std::lock_guard<std::mutex> lock(g_mu);
    if (!g_model || !g_ctx || !g_vocab) {
        return env->NewStringUTF("failed: not loaded");
    }

    llama_memory_clear(llama_get_memory(g_ctx), true);

    int n_predict = maxTokens > 0 ? maxTokens : 96;
    if (n_predict > 256) n_predict = 256;

    const int n_prompt = -llama_tokenize(g_vocab, promptStr.c_str(), (int32_t) promptStr.size(), nullptr, 0, true, true);
    LOGI("n_prompt=%d ctx=%u batch=%u", n_prompt, llama_n_ctx(g_ctx), llama_n_batch(g_ctx));
    if (n_prompt <= 0) return env->NewStringUTF("tokenize failed");
    if (n_prompt >= (int) llama_n_ctx(g_ctx) - 16) {
        return env->NewStringUTF("prompt too long for context");
    }

    std::vector<llama_token> prompt_tokens((size_t) n_prompt);
    if (llama_tokenize(g_vocab, promptStr.c_str(), (int32_t) promptStr.size(),
                       prompt_tokens.data(), (int32_t) prompt_tokens.size(), true, true) < 0) {
        return env->NewStringUTF("tokenize failed");
    }

    auto sparams = llama_sampler_chain_default_params();
    llama_sampler * smpl = llama_sampler_chain_init(sparams);
    llama_sampler_chain_add(smpl, llama_sampler_init_greedy());

    const int n_batch_max = (int) llama_n_batch(g_ctx);
    int n_pos = 0;
    int step = 0;
    const int steps = (n_prompt + n_batch_max - 1) / std::max(1, n_batch_max);
    while (n_pos < n_prompt) {
        if (g_cancel.load()) {
            llama_sampler_free(smpl);
            return env->NewStringUTF("");
        }
        int n_eval = std::min(n_batch_max, n_prompt - n_pos);
        step += 1;
        {
            char prog[80];
            snprintf(prog, sizeof(prog), "<<<PROGRESS>>>Evaluating %d/%d…", step, steps);
            emit(prog);
        }
        LOGI("prompt chunk %d/%d n_eval=%d", step, steps, n_eval);
        llama_batch batch = llama_batch_get_one(prompt_tokens.data() + n_pos, n_eval);
        if (llama_decode(g_ctx, batch)) {
            LOGE("decode(prompt) failed @%d", n_pos);
            llama_sampler_free(smpl);
            return env->NewStringUTF("decode failed");
        }
        n_pos += n_eval;
    }

    emit("<<<CLEAR>>>");

    std::string full;
    int n_decode = 0;
    while (n_decode < n_predict) {
        if (g_cancel.load()) break;
        llama_token id = llama_sampler_sample(smpl, g_ctx, -1);
        if (llama_vocab_is_eog(g_vocab, id)) break;

        char buf[256];
        int n = llama_token_to_piece(g_vocab, id, buf, sizeof(buf), 0, true);
        if (n < 0) break;
        std::string piece(buf, n);
        full += piece;
        emit(piece);

        llama_batch batch = llama_batch_get_one(&id, 1);
        if (llama_decode(g_ctx, batch)) {
            LOGE("decode(gen) failed");
            break;
        }
        n_decode += 1;
    }

    llama_sampler_free(smpl);
    LOGI("done tokens=%d", n_decode);
    return env->NewStringUTF(full.c_str());
#else
    (void) maxTokens;
    std::string reply = "stub: " + promptStr.substr(0, 200);
    emit(reply);
    return env->NewStringUTF(reply.c_str());
#endif
}
