package com.afkllm.android.ui.workspace

import android.content.Intent
import android.net.Uri
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.outlined.InsertDriveFile
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.afkllm.android.MainViewModel
import com.afkllm.core.i18n.StringKey
import com.afkllm.core.i18n.UiLanguage
import com.afkllm.core.i18n.t

@Composable
fun ExplorerScreen(vm: MainViewModel, lang: UiLanguage) {
    val ui by vm.ui.collectAsStateWithLifecycle()
    val settings by vm.settings.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val openTree = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenDocumentTree()
    ) { uri: Uri? ->
        if (uri == null) return@rememberLauncherForActivityResult
        try {
            context.contentResolver.takePersistableUriPermission(
                uri,
                Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            )
        } catch (_: SecurityException) {
        }
        vm.setWorkspaceRoot(uri.toString())
    }

    Column(Modifier.fillMaxSize().padding(12.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = { openTree.launch(null) }) {
                Text(t(lang, StringKey.EXPLORER_OPEN))
            }
            if (settings.workspaceRootUri.isNotBlank()) {
                OutlinedButton(onClick = { vm.loadTree(settings.workspaceRootUri) }) {
                    Text(t(lang, StringKey.GIT_REFRESH))
                }
            }
        }
        Spacer(Modifier.height(8.dp))
        if (ui.treeNodes.isEmpty()) {
            Text(t(lang, StringKey.EXPLORER_EMPTY), color = MaterialTheme.colorScheme.onSurfaceVariant)
        } else {
            LazyColumn {
                items(ui.treeNodes, key = { it.uri }) { node ->
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .clickable { vm.openTreeChild(node) }
                            .padding(vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Icon(
                            if (node.isDirectory) Icons.Outlined.Folder else Icons.Outlined.InsertDriveFile,
                            contentDescription = null
                        )
                        Text(node.name, modifier = Modifier.padding(start = 8.dp))
                    }
                }
            }
        }
    }
}

@Composable
fun CodeScreen(vm: MainViewModel, lang: UiLanguage) {
    val ui by vm.ui.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val openFile = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenDocument()
    ) { uri: Uri? ->
        if (uri == null) return@rememberLauncherForActivityResult
        try {
            context.contentResolver.takePersistableUriPermission(
                uri,
                Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            )
        } catch (_: SecurityException) {
        }
        val name = uri.lastPathSegment?.substringAfterLast(':')?.substringAfterLast('/') ?: "file"
        vm.openEditor(uri.toString(), name)
    }

    Column(Modifier.fillMaxSize().padding(12.dp)) {
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                (ui.openFileName.ifBlank { t(lang, StringKey.CODE_UNTITLED) }) +
                    if (ui.editorDirty) " *" else "",
                style = MaterialTheme.typography.titleSmall,
                modifier = Modifier.weight(1f)
            )
            OutlinedButton(onClick = { openFile.launch(arrayOf("*/*")) }) {
                Text(t(lang, StringKey.CODE_OPEN))
            }
            Button(onClick = vm::saveEditor, enabled = ui.openFileUri != null && ui.editorDirty) {
                Text(t(lang, StringKey.CODE_SAVE))
            }
        }
        Spacer(Modifier.height(8.dp))
        OutlinedTextField(
            value = ui.editorText,
            onValueChange = vm::setEditorText,
            modifier = Modifier.weight(1f).fillMaxWidth(),
            textStyle = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
            placeholder = { Text(t(lang, StringKey.CODE_OPEN)) }
        )
    }
}

@Composable
fun TerminalScreen(vm: MainViewModel, lang: UiLanguage) {
    val ui by vm.ui.collectAsStateWithLifecycle()
    Column(Modifier.fillMaxSize().padding(12.dp)) {
        Text(
            ui.terminalOutput.ifBlank { "$ sh\n" },
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth()
                .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f))
                .padding(8.dp)
                .verticalScroll(rememberScrollState())
                .horizontalScroll(rememberScrollState()),
            style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace)
        )
        Spacer(Modifier.height(8.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                value = ui.terminalInput,
                onValueChange = vm::setTerminalInput,
                modifier = Modifier.weight(1f),
                placeholder = { Text(t(lang, StringKey.TERM_HINT)) },
                singleLine = true
            )
            Spacer(Modifier.height(8.dp))
            Button(onClick = vm::runTerminal, modifier = Modifier.padding(start = 8.dp)) {
                Text(t(lang, StringKey.TERM_RUN))
            }
        }
    }
}

@Composable
fun BrowserScreen(vm: MainViewModel, lang: UiLanguage) {
    val ui by vm.ui.collectAsStateWithLifecycle()
    Column(Modifier.fillMaxSize()) {
        Row(
            Modifier.fillMaxWidth().padding(8.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            OutlinedTextField(
                value = ui.browserUrl,
                onValueChange = vm::setBrowserUrl,
                modifier = Modifier.weight(1f),
                singleLine = true,
                placeholder = { Text(t(lang, StringKey.BROWSER_HINT)) }
            )
            Button(onClick = vm::navigateBrowser, modifier = Modifier.padding(start = 8.dp)) {
                Text(t(lang, StringKey.BROWSER_GO))
            }
        }
        AndroidView(
            factory = { ctx ->
                WebView(ctx).apply {
                    settings.javaScriptEnabled = true
                    webViewClient = WebViewClient()
                    loadUrl(ui.browserNavigate)
                }
            },
            update = { web ->
                if (web.url != ui.browserNavigate) web.loadUrl(ui.browserNavigate)
            },
            modifier = Modifier.fillMaxSize()
        )
    }
}

@Composable
fun GitScreen(vm: MainViewModel, lang: UiLanguage) {
    val ui by vm.ui.collectAsStateWithLifecycle()
    Column(Modifier.fillMaxSize().padding(12.dp)) {
        Button(onClick = vm::refreshGit) { Text(t(lang, StringKey.GIT_REFRESH)) }
        Spacer(Modifier.height(8.dp))
        Text(
            ui.gitOutput.ifBlank { t(lang, StringKey.GIT_EMPTY) },
            style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
        )
    }
}

@Composable
fun ConsoleScreen(vm: MainViewModel, lang: UiLanguage) {
    val ui by vm.ui.collectAsStateWithLifecycle()
    Column(Modifier.fillMaxSize().padding(12.dp)) {
        OutlinedButton(onClick = vm::clearConsole) { Text(t(lang, StringKey.CONSOLE_CLEAR)) }
        Spacer(Modifier.height(8.dp))
        if (ui.consoleLines.isEmpty()) {
            Text(t(lang, StringKey.CONSOLE_EMPTY), color = MaterialTheme.colorScheme.onSurfaceVariant)
        } else {
            LazyColumn(Modifier.fillMaxSize()) {
                items(ui.consoleLines.size) { i ->
                    Text(
                        ui.consoleLines[i],
                        style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace)
                    )
                }
            }
        }
    }
}
