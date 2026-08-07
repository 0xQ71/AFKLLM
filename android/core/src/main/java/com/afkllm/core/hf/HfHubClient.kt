package com.afkllm.core.hf

import com.afkllm.core.model.HF_RECOMMENDED_MODELS
import com.afkllm.core.model.HfRecommendedModel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

data class HfListItem(
    val id: String,
    val downloads: Long = 0,
    val likes: Long = 0,
    val description: String = "",
    val preferredFile: String? = null,
    val sizeGb: Double? = null,
    val recommended: Boolean = false,
    val title: String? = null,
    val installed: Boolean = false,
    val installedPath: String? = null,
    val installedFileName: String? = null
)

data class HfRepoFile(val path: String, val size: Long)

object HfHubClient {
    private const val API = "https://huggingface.co/api"
    private const val UA = "AFKLLM-Android/0.1 (model store)"

    fun staffHome(langRu: Boolean): List<HfListItem> =
        HF_RECOMMENDED_MODELS.map { it.toListItem(langRu) }

    suspend fun search(query: String, limit: Int = 30): List<HfListItem> = withContext(Dispatchers.IO) {
        val sp = buildString {
            append("filter=gguf&sort=downloads&direction=-1&limit=")
            append(limit.coerceIn(1, 50))
            val q = query.trim()
            if (q.isNotEmpty()) {
                append("&search=")
                append(URLEncoder.encode(q, Charsets.UTF_8.name()))
            }
        }
        val raw = getJsonArray("$API/models?$sp")
        val out = ArrayList<HfListItem>(raw.length())
        for (i in 0 until raw.length()) {
            val o = raw.getJSONObject(i)
            val id = o.optString("id")
            val rec = HF_RECOMMENDED_MODELS.find { it.repoId == id }
            out += HfListItem(
                id = id,
                downloads = o.optLong("downloads"),
                likes = o.optLong("likes"),
                description = rec?.description.orEmpty(),
                preferredFile = rec?.preferredFile,
                sizeGb = rec?.sizeGb,
                recommended = rec != null,
                title = rec?.title
            )
        }
        out
    }

    suspend fun listGgufFiles(repoId: String): List<HfRepoFile> = withContext(Dispatchers.IO) {
        val id = pathId(repoId)
        val arr = getJsonArray("$API/models/$id/tree/main?recursive=1")
        val files = mutableListOf<HfRepoFile>()
        for (i in 0 until arr.length()) {
            val o = arr.getJSONObject(i)
            if (o.optString("type") != "file") continue
            val path = o.optString("path")
            if (!path.endsWith(".gguf", ignoreCase = true)) continue
            files += HfRepoFile(path, o.optLong("size"))
        }
        files.sortedBy { it.path.lowercase() }
    }

    /**
     * Download GGUF into [destFile]. [onProgress] fraction 0..1, bytes received, total (0 if unknown).
     */
    suspend fun download(
        repoId: String,
        filename: String,
        destFile: File,
        onProgress: (fraction: Float, received: Long, total: Long) -> Unit
    ): File = withContext(Dispatchers.IO) {
        destFile.parentFile?.mkdirs()
        val part = File(destFile.absolutePath + ".part")
        val url = URL(
            "https://huggingface.co/${pathId(repoId)}/resolve/main/${filename.split('/').joinToString("/") { URLEncoder.encode(it, "UTF-8").replace("+", "%20") }}"
        )
        val conn = (url.openConnection() as HttpURLConnection).apply {
            instanceFollowRedirects = true
            connectTimeout = 30_000
            readTimeout = 60_000
            setRequestProperty("User-Agent", UA)
            setRequestProperty("Accept", "*/*")
        }
        conn.connect()
        if (conn.responseCode !in 200..299) {
            throw IllegalStateException("HF download HTTP ${conn.responseCode}")
        }
        val total = conn.contentLengthLong.coerceAtLeast(0L)
        conn.inputStream.use { input ->
            FileOutputStream(part).use { output ->
                val buf = ByteArray(256 * 1024)
                var received = 0L
                while (true) {
                    val n = input.read(buf)
                    if (n <= 0) break
                    output.write(buf, 0, n)
                    received += n
                    val frac = if (total > 0) (received.toDouble() / total).toFloat().coerceIn(0f, 1f) else 0f
                    onProgress(frac, received, total)
                }
            }
        }
        if (destFile.exists()) destFile.delete()
        if (!part.renameTo(destFile)) {
            part.copyTo(destFile, overwrite = true)
            part.delete()
        }
        onProgress(1f, destFile.length(), destFile.length())
        destFile
    }

    private fun HfRecommendedModel.toListItem(langRu: Boolean) = HfListItem(
        id = repoId,
        description = if (langRu) descriptionRu else description,
        preferredFile = preferredFile,
        sizeGb = sizeGb,
        recommended = true,
        title = title
    )

    private fun pathId(repoId: String): String =
        repoId.trim()
            .removePrefix("https://huggingface.co/")
            .removePrefix("http://huggingface.co/")
            .substringBefore('?')
            .split('/')
            .filter { it.isNotBlank() }
            .joinToString("/") { URLEncoder.encode(it, "UTF-8") }

    private fun getJsonArray(url: String): JSONArray {
        val conn = (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 20_000
            readTimeout = 30_000
            setRequestProperty("Accept", "application/json")
            setRequestProperty("User-Agent", UA)
        }
        conn.connect()
        if (conn.responseCode !in 200..299) {
            throw IllegalStateException("HF API ${conn.responseCode}")
        }
        val body = conn.inputStream.bufferedReader().use { it.readText() }
        return JSONArray(body)
    }
}

fun formatBytes(n: Long): String {
    if (n <= 0) return "—"
    if (n < 1024) return "$n B"
    if (n < 1024 * 1024) return "${n / 1024} KB"
    if (n < 1024L * 1024 * 1024) return String.format("%.1f MB", n / (1024.0 * 1024))
    return String.format("%.2f GB", n / (1024.0 * 1024 * 1024))
}
