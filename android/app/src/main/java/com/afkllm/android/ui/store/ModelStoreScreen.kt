package com.afkllm.android.ui.store

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.afkllm.android.MainViewModel
import com.afkllm.core.hf.HfListItem
import com.afkllm.core.hf.HfRepoFile
import com.afkllm.core.hf.formatBytes
import com.afkllm.core.i18n.StringKey
import com.afkllm.core.i18n.UiLanguage
import com.afkllm.core.i18n.t
import kotlinx.coroutines.delay

@Composable
fun ModelStoreScreen(vm: MainViewModel, lang: UiLanguage) {
    val ui by vm.ui.collectAsStateWithLifecycle()

    LaunchedEffect(ui.storeQuery) {
        delay(300)
        vm.refreshStoreHome()
    }

    Column(
        Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
    ) {
        Row(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 4.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                t(lang, StringKey.STORE_TITLE),
                style = MaterialTheme.typography.titleSmall,
                modifier = Modifier.weight(1f),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
            IconButton(onClick = { vm.openModelStore(false) }) {
                Icon(Icons.Outlined.Close, contentDescription = t(lang, StringKey.BACK))
            }
        }

        OutlinedTextField(
            value = ui.storeQuery,
            onValueChange = vm::setStoreQuery,
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 8.dp),
            singleLine = true,
            leadingIcon = { Icon(Icons.Outlined.Search, contentDescription = null) },
            placeholder = { Text(t(lang, StringKey.STORE_SEARCH)) },
            textStyle = MaterialTheme.typography.bodySmall
        )

        if (ui.storeError != null) {
            Text(
                ui.storeError ?: "",
                color = MaterialTheme.colorScheme.error,
                modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
                style = MaterialTheme.typography.labelSmall
            )
        }

        BoxWithConstraints(Modifier.weight(1f).fillMaxWidth()) {
            val sideBySide = maxWidth >= 560.dp
            val showDetail = ui.storeSelectedId != null

            if (sideBySide) {
                Row(Modifier.fillMaxSize()) {
                    StoreListPane(
                        vm = vm,
                        lang = lang,
                        items = ui.storeItems,
                        selectedId = ui.storeSelectedId,
                        loading = ui.storeLoading,
                        queryBlank = ui.storeQuery.isBlank(),
                        modifier = Modifier
                            .width(140.dp)
                            .fillMaxHeight()
                    )
                    StoreDetailPane(
                        vm = vm,
                        lang = lang,
                        selected = ui.storeItems.find { it.id == ui.storeSelectedId },
                        files = ui.storeFiles,
                        filePath = ui.storeFilePath,
                        downloading = ui.storeDownloading,
                        progress = ui.storeProgress,
                        progressLabel = ui.storeProgressLabel,
                        modifier = Modifier.weight(1f).fillMaxHeight().widthIn(min = 0.dp),
                        showBack = false
                    )
                }
            } else if (!showDetail) {
                StoreListPane(
                    vm = vm,
                    lang = lang,
                    items = ui.storeItems,
                    selectedId = ui.storeSelectedId,
                    loading = ui.storeLoading,
                    queryBlank = ui.storeQuery.isBlank(),
                    modifier = Modifier.fillMaxSize(),
                    onPick = { id -> vm.selectStoreModel(id) }
                )
            } else {
                StoreDetailPane(
                    vm = vm,
                    lang = lang,
                    selected = ui.storeItems.find { it.id == ui.storeSelectedId },
                    files = ui.storeFiles,
                    filePath = ui.storeFilePath,
                    downloading = ui.storeDownloading,
                    progress = ui.storeProgress,
                    progressLabel = ui.storeProgressLabel,
                    modifier = Modifier.fillMaxSize(),
                    showBack = true,
                    onBack = vm::clearStoreSelection
                )
            }
        }
    }
}

@Composable
private fun StoreListPane(
    vm: MainViewModel,
    lang: UiLanguage,
    items: List<HfListItem>,
    selectedId: String?,
    loading: Boolean,
    queryBlank: Boolean,
    modifier: Modifier = Modifier,
    onPick: ((String) -> Unit)? = null
) {
    Column(modifier.background(MaterialTheme.colorScheme.surface)) {
        Text(
            if (queryBlank) t(lang, StringKey.STORE_STAFF) else t(lang, StringKey.STORE_RESULTS),
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 6.dp)
        )
        if (loading && items.isEmpty()) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(Modifier.size(28.dp))
            }
        } else {
            LazyColumn(Modifier.fillMaxSize()) {
                items(items, key = { it.id + "|" + (it.preferredFile ?: "") }) { item ->
                    val selected = item.id == selectedId
                    Column(
                        Modifier
                            .fillMaxWidth()
                            .background(
                                if (selected) MaterialTheme.colorScheme.primary.copy(alpha = 0.15f)
                                else MaterialTheme.colorScheme.surface
                            )
                            .clickable {
                                if (onPick != null) onPick(item.id) else vm.selectStoreModel(item.id)
                            }
                            .padding(horizontal = 8.dp, vertical = 8.dp)
                    ) {
                        Text(
                            item.title ?: item.id.substringAfterLast('/'),
                            style = MaterialTheme.typography.bodySmall,
                        )
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            if (item.installed) {
                                Text(
                                    t(lang, StringKey.STORE_INSTALLED),
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.primary
                                )
                            } else if (item.recommended) {
                                Text(
                                    "★",
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.primary
                                )
                            }
                            if (item.sizeGb != null && !item.installed) {
                                Text(
                                    String.format("%.1f GB", item.sizeGb),
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant
                                )
                            }
                            if (item.installed && item.installedFileName != null) {
                                Text(
                                    item.installedFileName!!,
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                    modifier = Modifier.weight(1f, fill = false)
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun StoreDetailPane(
    vm: MainViewModel,
    lang: UiLanguage,
    selected: HfListItem?,
    files: List<HfRepoFile>,
    filePath: String,
    downloading: Boolean,
    progress: Float,
    progressLabel: String,
    modifier: Modifier = Modifier,
    showBack: Boolean,
    onBack: (() -> Unit)? = null
) {
    Column(
        modifier
            .verticalScroll(rememberScrollState())
            .padding(10.dp)
    ) {
        if (showBack && onBack != null) {
            IconButton(onClick = onBack) {
                Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = t(lang, StringKey.BACK))
            }
        }

        if (selected == null) {
            Text(t(lang, StringKey.STORE_PICK), color = MaterialTheme.colorScheme.onSurfaceVariant)
            return
        }

        Text(selected.title ?: selected.id, style = MaterialTheme.typography.titleSmall)
        Text(
            selected.id,
            style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace),
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        Spacer(Modifier.height(8.dp))
        Text(
            selected.description.ifBlank { t(lang, StringKey.STORE_NO_DESC) },
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        Spacer(Modifier.height(12.dp))
        Text(t(lang, StringKey.STORE_FILE), style = MaterialTheme.typography.labelMedium)
        Spacer(Modifier.height(6.dp))

        val shownFiles = if (files.isEmpty() && filePath.isNotBlank()) {
            listOf(HfRepoFile(filePath, 0))
        } else files

        shownFiles.forEach { f ->
            FileChoice(
                path = f.path,
                sizeLabel = if (f.size > 0) formatBytes(f.size) else null,
                selected = filePath == f.path,
                onClick = { vm.setStoreFilePath(f.path) }
            )
        }

        Spacer(Modifier.height(16.dp))
        if (downloading) {
            LinearProgressIndicator(progress = { progress }, modifier = Modifier.fillMaxWidth())
            Text(progressLabel, style = MaterialTheme.typography.labelSmall)
            Spacer(Modifier.height(8.dp))
        }
        Row(
            Modifier.horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            if (selected.installed && selected.installedPath != null) {
                Button(
                    onClick = {
                        vm.setModelPath(selected.installedPath!!)
                        vm.loadModel()
                        vm.openModelStore(false)
                    }
                ) {
                    Text(t(lang, StringKey.STORE_USE))
                }
                Text(
                    t(lang, StringKey.STORE_INSTALLED) +
                        (selected.installedFileName?.let { ": $it" } ?: ""),
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.align(Alignment.CenterVertically)
                )
            } else {
                Button(
                    onClick = vm::downloadStoreModel,
                    enabled = !downloading && filePath.isNotBlank()
                ) {
                    Text(t(lang, StringKey.STORE_DOWNLOAD))
                }
            }
            OutlinedButton(onClick = { vm.openModelStore(false) }) {
                Text(t(lang, StringKey.BACK))
            }
        }
        Spacer(Modifier.height(12.dp))
    }
}

@Composable
private fun FileChoice(
    path: String,
    sizeLabel: String?,
    selected: Boolean,
    onClick: () -> Unit
) {
    Column(
        Modifier
            .fillMaxWidth()
            .padding(vertical = 3.dp)
            .clip(RoundedCornerShape(8.dp))
            .background(
                if (selected) MaterialTheme.colorScheme.primary.copy(alpha = 0.18f)
                else MaterialTheme.colorScheme.surfaceVariant
            )
            .clickable(onClick = onClick)
            .padding(10.dp)
    ) {
        Text(
            path,
            style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
            // full quant filename visible
        )
        if (sizeLabel != null) {
            Text(
                sizeLabel,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}
