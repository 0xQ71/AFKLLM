package com.afkllm.core.settings

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.floatPreferencesKey
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.afkllm.core.i18n.StringKey
import com.afkllm.core.i18n.UiLanguage
import com.afkllm.core.theme.UiTheme
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import org.json.JSONArray
import org.json.JSONObject

private val Context.dataStore: DataStore<Preferences> by preferencesDataStore(name = "afkllm_settings")

enum class FlashAttnMode { ON, OFF, AUTO }
enum class CacheQuant { F16, Q8_0, Q4_0, Q4_1, Q5_0, BF16 }
enum class LoadMode { MMAP, MMAP_MLOCK, NONE }
enum class ContextOverflow { TRUNCATE_MIDDLE, CONTEXT_SHIFT, STOP }

data class McpServerConfig(
    val id: String,
    val name: String,
    val enabled: Boolean = true,
    val command: String = "",
    val args: String = "",
    val env: String = ""
)

/** Desktop-parity AppSettings (src/shared/settings.ts). */
data class AppSettings(
    val baseUrl: String = "http://127.0.0.1:8080",
    val host: String = "127.0.0.1",
    val port: Int = 8080,
    val modelPath: String = "",
    val modelsDir: String = "",
    val llamaServerPath: String = "",
    val llamaRuntimeVariant: String = "auto",
    val autoStart: Boolean = false,
    val uiTheme: UiTheme = UiTheme.CLASSIC,
    val uiLanguage: UiLanguage = UiLanguage.EN,
    val recentRoots: List<String> = emptyList(),
    val systemPrompt: String = "",
    val fitHardware: Boolean = true,
    val ctxSize: Int = 8192,
    val nGpuLayers: Int = 999,
    val threads: Int = 6,
    val batchSize: Int = 2048,
    val ubatchSize: Int = 512,
    val parallel: Int = 1,
    val flashAttn: FlashAttnMode = FlashAttnMode.ON,
    val kvOffload: Boolean = true,
    val kvUnified: Boolean = true,
    val ctxCheckpoints: Int = 32,
    val cacheTypeK: CacheQuant = CacheQuant.Q8_0,
    val cacheTypeV: CacheQuant = CacheQuant.Q8_0,
    val loadMode: LoadMode = LoadMode.MMAP,
    val temperature: Float = 0.1f,
    val topK: Int = 50,
    val topP: Float = 0.1f,
    val topPEnabled: Boolean = true,
    val minP: Float = 0.05f,
    val minPEnabled: Boolean = false,
    val repeatPenalty: Float = 1.05f,
    val repeatPenaltyEnabled: Boolean = true,
    val presencePenalty: Float = 0f,
    val presencePenaltyEnabled: Boolean = false,
    val limitResponseLength: Boolean = false,
    val maxTokens: Int = 4096,
    val contextOverflow: ContextOverflow = ContextOverflow.TRUNCATE_MIDDLE,
    val stopStrings: String = "",
    val reasoningBudgetEnabled: Boolean = true,
    val reasoningBudget: Int = 8192,
    val reasoningBudgetMessage: String = "I have to answer now.",
    val agentAutoApprove: Boolean = false,
    val agentThinkThrough: Boolean = true,
    val agentPlanMode: Boolean = false,
    val setupComplete: Boolean = false,
    val localApiEnabled: Boolean = false,
    val collectLogsToFile: Boolean = true,
    val mcpServers: List<McpServerConfig> = emptyList(),
    val lastSeenVersion: String = "",
    val workspaceRootUri: String = ""
)

enum class SettingsPageId {
    GENERAL, APPEARANCE, AGENT, MODEL, PERFORMANCE, MEMORY, GENERATION, RUNTIME, MCP
}

data class SettingsNavGroup(
    val labelKey: StringKey,
    val items: List<Pair<SettingsPageId, StringKey>>
)

val SETTINGS_NAV = listOf(
    SettingsNavGroup(
        StringKey.GROUP_SETTINGS,
        listOf(
            SettingsPageId.GENERAL to StringKey.NAV_GENERAL,
            SettingsPageId.APPEARANCE to StringKey.NAV_APPEARANCE,
            SettingsPageId.AGENT to StringKey.NAV_AGENT
        )
    ),
    SettingsNavGroup(
        StringKey.GROUP_MODEL,
        listOf(
            SettingsPageId.MODEL to StringKey.NAV_MODEL,
            SettingsPageId.PERFORMANCE to StringKey.NAV_PERFORMANCE,
            SettingsPageId.MEMORY to StringKey.NAV_MEMORY,
            SettingsPageId.GENERATION to StringKey.NAV_GENERATION,
            SettingsPageId.RUNTIME to StringKey.NAV_RUNTIME
        )
    ),
    SettingsNavGroup(
        StringKey.GROUP_INTEGRATIONS,
        listOf(SettingsPageId.MCP to StringKey.NAV_MCP)
    )
)

enum class WorkspaceId {
    AGENT, EXPLORER, CODE, TERMINAL, BROWSER, GIT, CONSOLE, SETTINGS
}

class SettingsStore(private val context: Context) {
    private object Keys {
        val json = stringPreferencesKey("appSettingsJson")
        // legacy keys for migration
        val theme = stringPreferencesKey("uiTheme")
        val language = stringPreferencesKey("uiLanguage")
        val auto = booleanPreferencesKey("agentAutoApprove")
        val think = booleanPreferencesKey("agentThinkThrough")
        val modelPath = stringPreferencesKey("modelPath")
        val temperature = floatPreferencesKey("temperature")
        val topP = floatPreferencesKey("topP")
        val maxTokens = intPreferencesKey("maxTokens")
    }

    val settings: Flow<AppSettings> = context.dataStore.data.map { prefs ->
        prefs[Keys.json]?.let { decode(it) } ?: migrateLegacy(prefs)
    }

    suspend fun update(transform: (AppSettings) -> AppSettings) {
        context.dataStore.edit { prefs ->
            val current = prefs[Keys.json]?.let { decode(it) } ?: migrateLegacy(prefs)
            prefs[Keys.json] = encode(transform(current))
        }
    }

    private fun migrateLegacy(p: Preferences): AppSettings = AppSettings(
        uiTheme = UiTheme.fromId(p[Keys.theme]),
        uiLanguage = UiLanguage.fromId(p[Keys.language]),
        agentAutoApprove = p[Keys.auto] ?: false,
        agentThinkThrough = p[Keys.think] ?: true,
        modelPath = p[Keys.modelPath] ?: "",
        temperature = p[Keys.temperature] ?: 0.1f,
        topP = p[Keys.topP] ?: 0.1f,
        maxTokens = p[Keys.maxTokens] ?: 4096
    )

    private fun encode(s: AppSettings): String = JSONObject().apply {
        put("baseUrl", s.baseUrl)
        put("host", s.host)
        put("port", s.port)
        put("modelPath", s.modelPath)
        put("modelsDir", s.modelsDir)
        put("llamaServerPath", s.llamaServerPath)
        put("llamaRuntimeVariant", s.llamaRuntimeVariant)
        put("autoStart", s.autoStart)
        put("uiTheme", s.uiTheme.id)
        put("uiLanguage", s.uiLanguage.id)
        put("recentRoots", JSONArray(s.recentRoots))
        put("systemPrompt", s.systemPrompt)
        put("fitHardware", s.fitHardware)
        put("ctxSize", s.ctxSize)
        put("nGpuLayers", s.nGpuLayers)
        put("threads", s.threads)
        put("batchSize", s.batchSize)
        put("ubatchSize", s.ubatchSize)
        put("parallel", s.parallel)
        put("flashAttn", s.flashAttn.name)
        put("kvOffload", s.kvOffload)
        put("kvUnified", s.kvUnified)
        put("ctxCheckpoints", s.ctxCheckpoints)
        put("cacheTypeK", s.cacheTypeK.name)
        put("cacheTypeV", s.cacheTypeV.name)
        put("loadMode", s.loadMode.name)
        put("temperature", s.temperature.toDouble())
        put("topK", s.topK)
        put("topP", s.topP.toDouble())
        put("topPEnabled", s.topPEnabled)
        put("minP", s.minP.toDouble())
        put("minPEnabled", s.minPEnabled)
        put("repeatPenalty", s.repeatPenalty.toDouble())
        put("repeatPenaltyEnabled", s.repeatPenaltyEnabled)
        put("presencePenalty", s.presencePenalty.toDouble())
        put("presencePenaltyEnabled", s.presencePenaltyEnabled)
        put("limitResponseLength", s.limitResponseLength)
        put("maxTokens", s.maxTokens)
        put("contextOverflow", s.contextOverflow.name)
        put("stopStrings", s.stopStrings)
        put("reasoningBudgetEnabled", s.reasoningBudgetEnabled)
        put("reasoningBudget", s.reasoningBudget)
        put("reasoningBudgetMessage", s.reasoningBudgetMessage)
        put("agentAutoApprove", s.agentAutoApprove)
        put("agentThinkThrough", s.agentThinkThrough)
        put("agentPlanMode", s.agentPlanMode)
        put("setupComplete", s.setupComplete)
        put("localApiEnabled", s.localApiEnabled)
        put("collectLogsToFile", s.collectLogsToFile)
        put("lastSeenVersion", s.lastSeenVersion)
        put("workspaceRootUri", s.workspaceRootUri)
        val mcp = JSONArray()
        s.mcpServers.forEach { m ->
            mcp.put(JSONObject().apply {
                put("id", m.id)
                put("name", m.name)
                put("enabled", m.enabled)
                put("command", m.command)
                put("args", m.args)
                put("env", m.env)
            })
        }
        put("mcpServers", mcp)
    }.toString()

    private fun decode(raw: String): AppSettings {
        val o = JSONObject(raw)
        fun bool(k: String, d: Boolean) = if (o.has(k)) o.getBoolean(k) else d
        fun int(k: String, d: Int) = if (o.has(k)) o.getInt(k) else d
        fun str(k: String, d: String = "") = if (o.has(k)) o.optString(k, d) else d
        fun flt(k: String, d: Float) = if (o.has(k)) o.getDouble(k).toFloat() else d
        val roots = mutableListOf<String>()
        o.optJSONArray("recentRoots")?.let { arr ->
            for (i in 0 until arr.length()) roots += arr.getString(i)
        }
        val mcp = mutableListOf<McpServerConfig>()
        o.optJSONArray("mcpServers")?.let { arr ->
            for (i in 0 until arr.length()) {
                val m = arr.getJSONObject(i)
                mcp += McpServerConfig(
                    id = m.optString("id"),
                    name = m.optString("name"),
                    enabled = m.optBoolean("enabled", true),
                    command = m.optString("command"),
                    args = m.optString("args"),
                    env = m.optString("env")
                )
            }
        }
        return AppSettings(
            baseUrl = str("baseUrl", "http://127.0.0.1:8080"),
            host = str("host", "127.0.0.1"),
            port = int("port", 8080),
            modelPath = str("modelPath"),
            modelsDir = str("modelsDir"),
            llamaServerPath = str("llamaServerPath"),
            llamaRuntimeVariant = str("llamaRuntimeVariant", "auto"),
            autoStart = bool("autoStart", false),
            uiTheme = UiTheme.fromId(str("uiTheme", "classic")),
            uiLanguage = UiLanguage.fromId(str("uiLanguage", "en")),
            recentRoots = roots,
            systemPrompt = str("systemPrompt"),
            fitHardware = bool("fitHardware", true),
            ctxSize = int("ctxSize", 8192),
            nGpuLayers = int("nGpuLayers", 999),
            threads = int("threads", 6),
            batchSize = int("batchSize", 2048),
            ubatchSize = int("ubatchSize", 512),
            parallel = int("parallel", 1),
            flashAttn = runCatching { FlashAttnMode.valueOf(str("flashAttn", "ON")) }.getOrDefault(FlashAttnMode.ON),
            kvOffload = bool("kvOffload", true),
            kvUnified = bool("kvUnified", true),
            ctxCheckpoints = int("ctxCheckpoints", 32),
            cacheTypeK = runCatching { CacheQuant.valueOf(str("cacheTypeK", "Q8_0")) }.getOrDefault(CacheQuant.Q8_0),
            cacheTypeV = runCatching { CacheQuant.valueOf(str("cacheTypeV", "Q8_0")) }.getOrDefault(CacheQuant.Q8_0),
            loadMode = runCatching { LoadMode.valueOf(str("loadMode", "MMAP")) }.getOrDefault(LoadMode.MMAP),
            temperature = flt("temperature", 0.1f),
            topK = int("topK", 50),
            topP = flt("topP", 0.1f),
            topPEnabled = bool("topPEnabled", true),
            minP = flt("minP", 0.05f),
            minPEnabled = bool("minPEnabled", false),
            repeatPenalty = flt("repeatPenalty", 1.05f),
            repeatPenaltyEnabled = bool("repeatPenaltyEnabled", true),
            presencePenalty = flt("presencePenalty", 0f),
            presencePenaltyEnabled = bool("presencePenaltyEnabled", false),
            limitResponseLength = bool("limitResponseLength", false),
            maxTokens = int("maxTokens", 4096),
            contextOverflow = runCatching {
                ContextOverflow.valueOf(str("contextOverflow", "TRUNCATE_MIDDLE"))
            }.getOrDefault(ContextOverflow.TRUNCATE_MIDDLE),
            stopStrings = str("stopStrings"),
            reasoningBudgetEnabled = bool("reasoningBudgetEnabled", true),
            reasoningBudget = int("reasoningBudget", 8192),
            reasoningBudgetMessage = str("reasoningBudgetMessage", "I have to answer now."),
            agentAutoApprove = bool("agentAutoApprove", false),
            agentThinkThrough = bool("agentThinkThrough", true),
            agentPlanMode = bool("agentPlanMode", false),
            setupComplete = bool("setupComplete", false),
            localApiEnabled = bool("localApiEnabled", false),
            collectLogsToFile = bool("collectLogsToFile", true),
            mcpServers = mcp,
            lastSeenVersion = str("lastSeenVersion"),
            workspaceRootUri = str("workspaceRootUri")
        )
    }
}
