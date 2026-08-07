package com.afkllm.android


import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.core.view.WindowCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.afkllm.android.ui.AfkRoot
import com.afkllm.android.ui.theme.AfkTheme
import com.afkllm.core.theme.resolveUiTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        WindowCompat.setDecorFitsSystemWindows(window, false)
        val app = application as AfkApp
        setContent {
            val vm: MainViewModel = viewModel(
                factory = MainViewModel.factory(app)
            )
            val settings by vm.settings.collectAsStateWithLifecycle()
            val systemLight = !isSystemInDarkTheme()
            val resolved = resolveUiTheme(settings.uiTheme, systemLight)
            AfkTheme(resolved) {
                Surface(Modifier.fillMaxSize()) {
                    AfkRoot(vm = vm)
                }
            }
        }
    }
}
