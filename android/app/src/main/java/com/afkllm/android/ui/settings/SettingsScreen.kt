package com.afkllm.android.ui.settings

import android.content.Intent
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Slider
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.afkllm.android.MainViewModel
import com.afkllm.core.i18n.StringKey
import com.afkllm.core.i18n.UiLanguage
import com.afkllm.core.i18n.t
import com.afkllm.core.i18n.themeLabel
import com.afkllm.core.settings.CacheQuant
import com.afkllm.core.settings.ContextOverflow
import com.afkllm.core.settings.FlashAttnMode
import com.afkllm.core.settings.LoadMode
import com.afkllm.core.settings.SETTINGS_NAV
import com.afkllm.core.settings.SettingsPageId
import com.afkllm.core.theme.UiTheme
import java.io.File

@Composable
fun SettingsScreen(vm: MainViewModel, lang: UiLanguage, embedded: Boolean = false) {
    val settings by vm.settings.collectAsStateWithLifecycle()
    val ui by vm.ui.collectAsStateWithLifecycle()
    val context = LocalContext.current

    val pickGguf = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenDocument()
    ) { uri: Uri? ->
        if (uri == null) return@rememberLauncherForActivityResult
        try {
            context.contentResolver.takePersistableUriPermission(
                uri,
                Intent.FLAG_GRANT_READ_URI_PERMISSION
            )
        } catch (_: SecurityException) {
        }
        val dest = File(context.filesDir, "models").also { it.mkdirs() }
        val name = uri.lastPathSegment?.substringAfterLast(':')?.substringAfterLast('/') ?: "model.gguf"
        val out = File(dest, name.ifBlank { "model.gguf" })
        context.contentResolver.openInputStream(uri)?.use { input ->
            out.outputStream().use { output -> input.copyTo(output) }
        }
        vm.setModelPath(out.absolutePath)
    }

    val allPages = SETTINGS_NAV.flatMap { it.items }

    BoxWithConstraints(
        Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
    ) {
        val useSideNav = maxWidth >= 720.dp

        if (useSideNav) {
            Row(Modifier.fillMaxSize()) {
                Column(
                    Modifier
                        .width(96.dp)
                        .fillMaxHeight()
                        .background(MaterialTheme.colorScheme.surface)
                        .padding(4.dp)
                        .verticalScroll(rememberScrollState())
                ) {
                    Text(
                        t(lang, StringKey.SETTINGS_TITLE),
                        style = MaterialTheme.typography.labelMedium,
                        modifier = Modifier.padding(horizontal = 6.dp, vertical = 6.dp),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )
                    SETTINGS_NAV.forEach { group ->
                        Text(
                            t(lang, group.labelKey),
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(horizontal = 6.dp, vertical = 4.dp),
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis
                        )
                        group.items.forEach { (page, key) ->
                            val selected = ui.settingsPage == page
                            Text(
                                t(lang, key),
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clip(RoundedCornerShape(6.dp))
                                    .background(
                                        if (selected) MaterialTheme.colorScheme.primary.copy(alpha = 0.18f)
                                        else MaterialTheme.colorScheme.surface
                                    )
                                    .clickable { vm.setSettingsPage(page) }
                                    .padding(horizontal = 6.dp, vertical = 8.dp),
                                style = MaterialTheme.typography.labelMedium,
                                maxLines = 2,
                                overflow = TextOverflow.Ellipsis,
                                color = MaterialTheme.colorScheme.onSurface
                            )
                        }
                    }
                }
                SettingsBody(
                    vm = vm,
                    lang = lang,
                    settings = settings,
                    ui = ui,
                    pickGguf = { pickGguf.launch(arrayOf("*/*", "application/octet-stream")) },
                    modifier = Modifier.weight(1f).fillMaxHeight().widthIn(min = 0.dp)
                )
            }
        } else {
            Column(Modifier.fillMaxSize()) {
                Row(
                    Modifier
                        .fillMaxWidth()
                        .horizontalScroll(rememberScrollState())
                        .padding(horizontal = 8.dp, vertical = 4.dp),
                    horizontalArrangement = Arrangement.spacedBy(6.dp)
                ) {
                    allPages.forEach { (page, key) ->
                        FilterChip(
                            selected = ui.settingsPage == page,
                            onClick = { vm.setSettingsPage(page) },
                            label = {
                                Text(
                                    t(lang, key),
                                    style = MaterialTheme.typography.labelMedium,
                                    maxLines = 1
                                )
                            }
                        )
                    }
                }
                SettingsBody(
                    vm = vm,
                    lang = lang,
                    settings = settings,
                    ui = ui,
                    pickGguf = { pickGguf.launch(arrayOf("*/*", "application/octet-stream")) },
                    modifier = Modifier.weight(1f).fillMaxWidth()
                )
            }
        }
    }
}

@Composable
private fun SettingsBody(
    vm: MainViewModel,
    lang: UiLanguage,
    settings: com.afkllm.core.settings.AppSettings,
    ui: com.afkllm.android.UiState,
    pickGguf: () -> Unit,
    modifier: Modifier = Modifier
) {
    Column(
        modifier
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 12.dp, vertical = 10.dp)
    ) {
        when (ui.settingsPage) {
                SettingsPageId.GENERAL -> {
                    Text(t(lang, StringKey.NAV_GENERAL), style = MaterialTheme.typography.titleLarge)
                    Spacer(Modifier.height(12.dp))
                    Text(t(lang, StringKey.GENERAL_ABOUT), color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Spacer(Modifier.height(12.dp))
                    Text("${t(lang, StringKey.GENERAL_VERSION)}: 0.1.0-android")
                    if (!ui.engineNative) {
                        Spacer(Modifier.height(12.dp))
                        Text(t(lang, StringKey.MODEL_DEMO), color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Spacer(Modifier.height(16.dp))
                    SettingSwitch(
                        t(lang, StringKey.GENERAL_LOGS),
                        "",
                        settings.collectLogsToFile
                    ) { v -> vm.updateSettings { it.copy(collectLogsToFile = v) } }
                    SettingSwitch(
                        t(lang, StringKey.GENERAL_AUTO_START),
                        "",
                        settings.autoStart
                    ) { v -> vm.updateSettings { it.copy(autoStart = v) } }
                }

                SettingsPageId.APPEARANCE -> {
                    Text(t(lang, StringKey.NAV_APPEARANCE), style = MaterialTheme.typography.titleLarge)
                    Spacer(Modifier.height(16.dp))
                    Text(t(lang, StringKey.APPEARANCE_THEME))
                    Spacer(Modifier.height(8.dp))
                    UiTheme.ALL.forEach { theme ->
                        ChoiceRow(themeLabel(lang, theme), settings.uiTheme == theme) {
                            vm.updateSettings { it.copy(uiTheme = theme) }
                        }
                    }
                    Spacer(Modifier.height(20.dp))
                    Text(t(lang, StringKey.APPEARANCE_LANGUAGE))
                    Spacer(Modifier.height(8.dp))
                    listOf(UiLanguage.EN to StringKey.LANG_EN, UiLanguage.RU to StringKey.LANG_RU).forEach { (l, key) ->
                        ChoiceRow(t(lang, key), settings.uiLanguage == l) {
                            vm.updateSettings { it.copy(uiLanguage = l) }
                        }
                    }
                }

                SettingsPageId.AGENT -> {
                    Text(t(lang, StringKey.NAV_AGENT), style = MaterialTheme.typography.titleLarge)
                    Spacer(Modifier.height(16.dp))
                    SettingSwitch(t(lang, StringKey.AGENT_AUTO), t(lang, StringKey.AGENT_AUTO_DESC), settings.agentAutoApprove) {
                        vm.updateSettings { s -> s.copy(agentAutoApprove = it) }
                    }
                    Spacer(Modifier.height(12.dp))
                    SettingSwitch(t(lang, StringKey.AGENT_THINK), t(lang, StringKey.AGENT_THINK_DESC), settings.agentThinkThrough) {
                        vm.updateSettings { s -> s.copy(agentThinkThrough = it) }
                    }
                    Spacer(Modifier.height(12.dp))
                    SettingSwitch(t(lang, StringKey.AGENT_PLAN), t(lang, StringKey.AGENT_PLAN_DESC), settings.agentPlanMode) {
                        vm.updateSettings { s -> s.copy(agentPlanMode = it) }
                    }
                }

                SettingsPageId.MODEL -> {
                    Text(t(lang, StringKey.NAV_MODEL), style = MaterialTheme.typography.titleLarge)
                    Spacer(Modifier.height(12.dp))
                    Button(onClick = { vm.openModelStore(true) }) {
                        Text(t(lang, StringKey.STORE_OPEN))
                    }
                    Spacer(Modifier.height(16.dp))
                    Text(t(lang, StringKey.MODEL_STAFF), style = MaterialTheme.typography.titleSmall)
                    Text(
                        t(lang, StringKey.STORE_TITLE),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        style = MaterialTheme.typography.bodySmall
                    )
                    Spacer(Modifier.height(12.dp))
                    Text(t(lang, StringKey.MODEL_PATH))
                    Text(settings.modelPath.ifBlank { "—" }, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(
                        if (ui.modelLoaded) t(lang, StringKey.MODEL_LOADED) else t(lang, StringKey.MODEL_NOT_LOADED),
                        color = if (ui.modelLoaded) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    Spacer(Modifier.height(8.dp))
                    OutlinedTextField(
                        value = settings.modelsDir,
                        onValueChange = { v -> vm.updateSettings { it.copy(modelsDir = v) } },
                        label = { Text(t(lang, StringKey.MODEL_DIR)) },
                        modifier = Modifier.fillMaxWidth()
                    )
                    Spacer(Modifier.height(8.dp))
                    SettingSwitch(t(lang, StringKey.MODEL_LOCAL_API), "", settings.localApiEnabled) {
                        vm.updateSettings { s -> s.copy(localApiEnabled = it) }
                    }
                    Text("${t(lang, StringKey.MODEL_PORT)}: ${settings.port}")
                    Slider(
                        value = settings.port.toFloat(),
                        onValueChange = { v -> vm.updateSettings { it.copy(port = v.toInt().coerceIn(1024, 65535)) } },
                        valueRange = 1024f..65535f
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedButton(onClick = pickGguf) {
                            Text(t(lang, StringKey.MODEL_PICK))
                        }
                        Button(onClick = vm::loadModel, enabled = settings.modelPath.isNotBlank()) {
                            Text(t(lang, StringKey.MODEL_LOAD))
                        }
                        OutlinedButton(onClick = vm::unloadModel, enabled = ui.modelLoaded) {
                            Text(t(lang, StringKey.MODEL_UNLOAD))
                        }
                    }
                }

                SettingsPageId.PERFORMANCE -> {
                    Text(t(lang, StringKey.NAV_PERFORMANCE), style = MaterialTheme.typography.titleLarge)
                    Spacer(Modifier.height(12.dp))
                    SettingSwitch(t(lang, StringKey.PERF_FIT), "", settings.fitHardware) {
                        vm.updateSettings { s -> s.copy(fitHardware = it) }
                    }
                    OutlinedTextField(
                        value = settings.systemPrompt,
                        onValueChange = { v -> vm.updateSettings { it.copy(systemPrompt = v) } },
                        label = { Text(t(lang, StringKey.PERF_SYSTEM_PROMPT)) },
                        modifier = Modifier.fillMaxWidth(),
                        minLines = 3
                    )
                    IntSlider(t(lang, StringKey.PERF_CTX), settings.ctxSize, 512, 131072) {
                        vm.updateSettings { s -> s.copy(ctxSize = it) }
                    }
                    IntSlider(t(lang, StringKey.PERF_GPU), settings.nGpuLayers, -1, 999) {
                        vm.updateSettings { s -> s.copy(nGpuLayers = it) }
                    }
                    IntSlider(t(lang, StringKey.PERF_THREADS), settings.threads, -1, 64) {
                        vm.updateSettings { s -> s.copy(threads = it) }
                    }
                    IntSlider(t(lang, StringKey.PERF_PARALLEL), settings.parallel, 1, 16) {
                        vm.updateSettings { s -> s.copy(parallel = it) }
                    }
                    IntSlider(t(lang, StringKey.PERF_BATCH), settings.batchSize, 32, 8192) {
                        vm.updateSettings { s -> s.copy(batchSize = it) }
                    }
                    IntSlider(t(lang, StringKey.PERF_UBATCH), settings.ubatchSize, 32, 4096) {
                        vm.updateSettings { s -> s.copy(ubatchSize = it) }
                    }
                    Text(t(lang, StringKey.PERF_FLASH))
                    FlashAttnMode.entries.forEach { mode ->
                        ChoiceRow(mode.name.lowercase(), settings.flashAttn == mode) {
                            vm.updateSettings { it.copy(flashAttn = mode) }
                        }
                    }
                }

                SettingsPageId.MEMORY -> {
                    Text(t(lang, StringKey.NAV_MEMORY), style = MaterialTheme.typography.titleLarge)
                    Spacer(Modifier.height(12.dp))
                    SettingSwitch(t(lang, StringKey.MEM_KV_OFFLOAD), "", settings.kvOffload) {
                        vm.updateSettings { s -> s.copy(kvOffload = it) }
                    }
                    SettingSwitch(t(lang, StringKey.MEM_KV_UNIFIED), "", settings.kvUnified) {
                        vm.updateSettings { s -> s.copy(kvUnified = it) }
                    }
                    IntSlider(t(lang, StringKey.MEM_CHECKPOINTS), settings.ctxCheckpoints, 0, 256) {
                        vm.updateSettings { s -> s.copy(ctxCheckpoints = it) }
                    }
                    Text(t(lang, StringKey.MEM_LOAD_MODE))
                    LoadMode.entries.forEach { mode ->
                        ChoiceRow(mode.name, settings.loadMode == mode) {
                            vm.updateSettings { it.copy(loadMode = mode) }
                        }
                    }
                    Text(t(lang, StringKey.MEM_CACHE_K))
                    CacheQuant.entries.forEach { q ->
                        ChoiceRow(q.name, settings.cacheTypeK == q) {
                            vm.updateSettings { it.copy(cacheTypeK = q) }
                        }
                    }
                    Text(t(lang, StringKey.MEM_CACHE_V))
                    CacheQuant.entries.forEach { q ->
                        ChoiceRow(q.name, settings.cacheTypeV == q) {
                            vm.updateSettings { it.copy(cacheTypeV = q) }
                        }
                    }
                }

                SettingsPageId.GENERATION -> {
                    Text(t(lang, StringKey.NAV_GENERATION), style = MaterialTheme.typography.titleLarge)
                    Spacer(Modifier.height(12.dp))
                    FloatSlider(t(lang, StringKey.GEN_TEMP), settings.temperature, 0f, 2f) {
                        vm.updateSettings { s -> s.copy(temperature = it) }
                    }
                    IntSlider(t(lang, StringKey.GEN_TOP_K), settings.topK, 0, 200) {
                        vm.updateSettings { s -> s.copy(topK = it) }
                    }
                    SettingSwitch(t(lang, StringKey.GEN_TOP_P), "", settings.topPEnabled) {
                        vm.updateSettings { s -> s.copy(topPEnabled = it) }
                    }
                    FloatSlider(t(lang, StringKey.GEN_TOP_P), settings.topP, 0f, 1f) {
                        vm.updateSettings { s -> s.copy(topP = it) }
                    }
                    SettingSwitch(t(lang, StringKey.GEN_MIN_P), "", settings.minPEnabled) {
                        vm.updateSettings { s -> s.copy(minPEnabled = it) }
                    }
                    FloatSlider(t(lang, StringKey.GEN_MIN_P), settings.minP, 0f, 1f) {
                        vm.updateSettings { s -> s.copy(minP = it) }
                    }
                    SettingSwitch(t(lang, StringKey.GEN_REPEAT), "", settings.repeatPenaltyEnabled) {
                        vm.updateSettings { s -> s.copy(repeatPenaltyEnabled = it) }
                    }
                    FloatSlider(t(lang, StringKey.GEN_REPEAT), settings.repeatPenalty, 0.5f, 2f) {
                        vm.updateSettings { s -> s.copy(repeatPenalty = it) }
                    }
                    SettingSwitch(t(lang, StringKey.GEN_PRESENCE), "", settings.presencePenaltyEnabled) {
                        vm.updateSettings { s -> s.copy(presencePenaltyEnabled = it) }
                    }
                    FloatSlider(t(lang, StringKey.GEN_PRESENCE), settings.presencePenalty, -2f, 2f) {
                        vm.updateSettings { s -> s.copy(presencePenalty = it) }
                    }
                    SettingSwitch(t(lang, StringKey.GEN_LIMIT_LEN), "", settings.limitResponseLength) {
                        vm.updateSettings { s -> s.copy(limitResponseLength = it) }
                    }
                    IntSlider(t(lang, StringKey.GEN_MAX_TOKENS), settings.maxTokens, 64, 32768) {
                        vm.updateSettings { s -> s.copy(maxTokens = it) }
                    }
                    Text(t(lang, StringKey.GEN_OVERFLOW))
                    ContextOverflow.entries.forEach { o ->
                        ChoiceRow(o.name.lowercase(), settings.contextOverflow == o) {
                            vm.updateSettings { it.copy(contextOverflow = o) }
                        }
                    }
                    OutlinedTextField(
                        value = settings.stopStrings,
                        onValueChange = { v -> vm.updateSettings { it.copy(stopStrings = v) } },
                        label = { Text(t(lang, StringKey.GEN_STOP)) },
                        modifier = Modifier.fillMaxWidth()
                    )
                    SettingSwitch(t(lang, StringKey.GEN_REASONING), "", settings.reasoningBudgetEnabled) {
                        vm.updateSettings { s -> s.copy(reasoningBudgetEnabled = it) }
                    }
                    IntSlider(t(lang, StringKey.GEN_REASONING_BUDGET), settings.reasoningBudget, 0, 65536) {
                        vm.updateSettings { s -> s.copy(reasoningBudget = it) }
                    }
                    OutlinedTextField(
                        value = settings.reasoningBudgetMessage,
                        onValueChange = { v -> vm.updateSettings { it.copy(reasoningBudgetMessage = v) } },
                        label = { Text(t(lang, StringKey.GEN_REASONING_MSG)) },
                        modifier = Modifier.fillMaxWidth()
                    )
                }

                SettingsPageId.RUNTIME -> {
                    Text(t(lang, StringKey.NAV_RUNTIME), style = MaterialTheme.typography.titleLarge)
                    Spacer(Modifier.height(12.dp))
                    Text(t(lang, StringKey.RUNTIME_HINT), color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Spacer(Modifier.height(12.dp))
                    listOf("auto", "cpu", "cuda", "cuda-12.4", "vulkan").forEach { v ->
                        ChoiceRow(v, settings.llamaRuntimeVariant == v) {
                            vm.updateSettings { it.copy(llamaRuntimeVariant = v) }
                        }
                    }
                    OutlinedTextField(
                        value = settings.llamaServerPath,
                        onValueChange = { v -> vm.updateSettings { it.copy(llamaServerPath = v) } },
                        label = { Text(t(lang, StringKey.RUNTIME_PATH)) },
                        modifier = Modifier.fillMaxWidth()
                    )
                }

                SettingsPageId.MCP -> {
                    Text(t(lang, StringKey.NAV_MCP), style = MaterialTheme.typography.titleLarge)
                    Spacer(Modifier.height(12.dp))
                    if (settings.mcpServers.isEmpty()) {
                        Text(t(lang, StringKey.MCP_EMPTY), color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    settings.mcpServers.forEach { server ->
                        Column(
                            Modifier
                                .fillMaxWidth()
                                .padding(vertical = 8.dp)
                                .clip(RoundedCornerShape(8.dp))
                                .background(MaterialTheme.colorScheme.surfaceVariant)
                                .padding(12.dp)
                        ) {
                            SettingSwitch(t(lang, StringKey.MCP_ENABLED), "", server.enabled) { en ->
                                vm.updateMcpServer(server.id) { it.copy(enabled = en) }
                            }
                            OutlinedTextField(
                                value = server.name,
                                onValueChange = { v -> vm.updateMcpServer(server.id) { it.copy(name = v) } },
                                label = { Text(t(lang, StringKey.MCP_NAME)) },
                                modifier = Modifier.fillMaxWidth()
                            )
                            OutlinedTextField(
                                value = server.command,
                                onValueChange = { v -> vm.updateMcpServer(server.id) { it.copy(command = v) } },
                                label = { Text(t(lang, StringKey.MCP_COMMAND)) },
                                modifier = Modifier.fillMaxWidth()
                            )
                            OutlinedTextField(
                                value = server.args,
                                onValueChange = { v -> vm.updateMcpServer(server.id) { it.copy(args = v) } },
                                label = { Text(t(lang, StringKey.MCP_ARGS)) },
                                modifier = Modifier.fillMaxWidth()
                            )
                            OutlinedButton(onClick = { vm.removeMcpServer(server.id) }) {
                                Text(t(lang, StringKey.MCP_REMOVE))
                            }
                        }
                    }
                    Button(onClick = vm::addMcpServer) { Text(t(lang, StringKey.MCP_ADD)) }
                }
            }
        }
}

@Composable
private fun ChoiceRow(label: String, selected: Boolean, onClick: () -> Unit) {
    Text(
        label,
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 2.dp)
            .clip(RoundedCornerShape(8.dp))
            .background(
                if (selected) MaterialTheme.colorScheme.primary.copy(alpha = 0.18f)
                else MaterialTheme.colorScheme.surfaceVariant
            )
            .clickable(onClick = onClick)
            .padding(12.dp)
    )
}

@Composable
private fun SettingSwitch(title: String, desc: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(title)
            if (desc.isNotBlank()) {
                Text(desc, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        Switch(checked = checked, onCheckedChange = onChange)
    }
}

@Composable
private fun FloatSlider(label: String, value: Float, from: Float, to: Float, onChange: (Float) -> Unit) {
    Text("$label: ${"%.2f".format(value)}")
    Slider(value = value, onValueChange = onChange, valueRange = from..to)
}

@Composable
private fun IntSlider(label: String, value: Int, from: Int, to: Int, onChange: (Int) -> Unit) {
    Text("$label: $value")
    Slider(
        value = value.toFloat().coerceIn(from.toFloat(), to.toFloat()),
        onValueChange = { onChange(it.toInt().coerceIn(from, to)) },
        valueRange = from.toFloat()..to.toFloat()
    )
}
