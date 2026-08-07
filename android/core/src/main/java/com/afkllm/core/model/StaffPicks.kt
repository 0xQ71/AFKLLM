package com.afkllm.core.model

/** Mirrors src/shared/hfStore.ts HF_RECOMMENDED_MODELS (+ mobile E2B/E4B). */
data class HfRecommendedModel(
    val repoId: String,
    val title: String,
    val description: String,
    val descriptionRu: String,
    val preferredFile: String,
    val sizeGb: Double,
    val minVramGb: Int,
    val tags: List<String>
)

val HF_RECOMMENDED_MODELS: List<HfRecommendedModel> = listOf(
    // OnePlus / phone-first — Gemma 4 Edge Q4_K_M (bartowski)
    HfRecommendedModel(
        "bartowski/google_gemma-4-E2B-it-GGUF",
        "Gemma 4 E2B IT (Q4_K_M)",
        "Recommended for phones (OnePlus etc.) — Q4_K_M (~3.2 GB). ~6 GB RAM.",
        "Рекомендуется для телефонов (OnePlus и др.) — Q4_K_M (~3.2 ГБ). ~6 ГБ RAM.",
        "google_gemma-4-E2B-it-Q4_K_M.gguf",
        3.2, 6, listOf("general", "popular", "phone")
    ),
    HfRecommendedModel(
        "bartowski/google_gemma-4-E4B-it-GGUF",
        "Gemma 4 E4B IT (Q4_K_M)",
        "Stronger Edge model for phones with more RAM — Q4_K_M (~5.0 GB). ~8 GB RAM.",
        "Сильнее E2B для телефонов с запасом RAM — Q4_K_M (~5.0 ГБ). ~8 ГБ RAM.",
        "google_gemma-4-E4B-it-Q4_K_M.gguf",
        5.0, 8, listOf("general", "popular", "phone")
    ),
    HfRecommendedModel(
        "bartowski/Llama-3.2-3B-Instruct-GGUF",
        "Llama 3.2 3B Instruct",
        "Tiny & fast — Q4_K_M (~2.0 GB). Good for phones / weak GPUs.",
        "Крошечная и быстрая — Q4_K_M (~2.0 ГБ). Хороша для слабых устройств.",
        "Llama-3.2-3B-Instruct-Q4_K_M.gguf",
        2.0, 4, listOf("general", "popular")
    ),
    HfRecommendedModel(
        "bartowski/Qwen2.5-Coder-7B-Instruct-GGUF",
        "Qwen2.5 Coder 7B",
        "Popular coding 7B — Q4_K_M (~4.7 GB). Strong value on 6–8 GB.",
        "Популярный coding 7B — Q4_K_M (~4.7 ГБ). Отличный вариант на 6–8 ГБ.",
        "Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf",
        4.7, 6, listOf("coding", "popular")
    ),
    HfRecommendedModel(
        "bartowski/gemma-2-9b-it-GGUF",
        "Gemma 2 9B Instruct",
        "Popular 9B instruct — Q4_K_M (~5.8 GB). Solid on 8 GB RAM.",
        "Популярный 9B instruct — Q4_K_M (~5.8 ГБ). Уверенно на 8 ГБ RAM.",
        "gemma-2-9b-it-Q4_K_M.gguf",
        5.8, 8, listOf("general", "popular")
    ),
    HfRecommendedModel(
        "bartowski/Qwen2.5-Coder-7B-Instruct-GGUF",
        "Qwen2.5 Coder 7B (Q6)",
        "Higher quality 7B — Q6_K (~6.3 GB).",
        "Более качественный 7B — Q6_K (~6.3 ГБ).",
        "Qwen2.5-Coder-7B-Instruct-Q6_K.gguf",
        6.3, 8, listOf("coding")
    ),
    HfRecommendedModel(
        "bartowski/Qwen2.5-Coder-14B-Instruct-GGUF",
        "Qwen2.5 Coder 14B",
        "Popular mid coding — Q4_K_M (~9.0 GB).",
        "Популярный mid coding — Q4_K_M (~9.0 ГБ).",
        "Qwen2.5-Coder-14B-Instruct-Q4_K_M.gguf",
        9.0, 11, listOf("coding", "popular")
    ),
    HfRecommendedModel(
        "unsloth/gpt-oss-20b-GGUF",
        "GPT-OSS 20B",
        "OpenAI open-weight MoE — Q4_K_M (~11.6 GB).",
        "OpenAI open-weight MoE — Q4_K_M (~11.6 ГБ).",
        "gpt-oss-20b-Q4_K_M.gguf",
        11.6, 12, listOf("agent", "general", "popular")
    ),
    HfRecommendedModel(
        "unsloth/Devstral-Small-2-24B-Instruct-2512-GGUF",
        "Devstral Small 2 24B",
        "Strong coding / agent — IQ4_XS (~12.8 GB).",
        "Сильный coding / agent — IQ4_XS (~12.8 ГБ).",
        "Devstral-Small-2-24B-Instruct-2512-IQ4_XS.gguf",
        12.8, 15, listOf("coding", "agent")
    )
)

data class StaffPickModel(
    val id: String,
    val title: String,
    val subtitleKey: com.afkllm.core.i18n.StringKey,
    val hfHint: String,
    val minRamGb: Int
)

val STAFF_PICKS = listOf(
    StaffPickModel(
        id = "gemma-e2b",
        title = "Gemma 4 E2B IT (Q4_K_M)",
        subtitleKey = com.afkllm.core.i18n.StringKey.MODEL_RAM_E2B,
        hfHint = "bartowski/google_gemma-4-E2B-it-GGUF",
        minRamGb = 6
    ),
    StaffPickModel(
        id = "gemma-e4b",
        title = "Gemma 4 E4B IT (Q4_K_M)",
        subtitleKey = com.afkllm.core.i18n.StringKey.MODEL_RAM_E4B,
        hfHint = "bartowski/google_gemma-4-E4B-it-GGUF",
        minRamGb = 8
    )
)
