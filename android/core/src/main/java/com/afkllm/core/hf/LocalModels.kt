package com.afkllm.core.hf

import java.io.File

/** Local GGUF inventory under app models dir (and optional extra dirs). */
object LocalModels {
    fun listGgufs(vararg dirs: File): List<File> =
        dirs.flatMap { dir ->
            dir.listFiles()
                ?.filter { it.isFile && it.name.endsWith(".gguf", ignoreCase = true) }
                ?.toList()
                .orEmpty()
        }

    /** Strip trailing quant tag: name-Q4_K_M.gguf → name */
    fun modelStem(filename: String): String {
        val leaf = filename.substringAfterLast('/').substringAfterLast('\\')
        return leaf
            .replace(Regex("""-[QI]Q?[0-9][A-Za-z0-9_.]*\.gguf$""", RegexOption.IGNORE_CASE), "")
            .replace(Regex("""\.gguf$""", RegexOption.IGNORE_CASE), "")
    }

    fun findInstalled(
        localFiles: List<File>,
        preferredFile: String?,
        repoId: String
    ): File? {
        if (localFiles.isEmpty()) return null
        val preferredLeaf = preferredFile?.substringAfterLast('/')?.substringAfterLast('\\')
        if (!preferredLeaf.isNullOrBlank()) {
            localFiles.find { it.name.equals(preferredLeaf, ignoreCase = true) }?.let { return it }
            val stem = modelStem(preferredLeaf)
            if (stem.isNotBlank()) {
                localFiles.find { modelStem(it.name).equals(stem, ignoreCase = true) }?.let { return it }
            }
        }
        // Fallback: repo leaf without -GGUF (e.g. google_gemma-4-E2B-it)
        val repoLeaf = repoId.substringAfterLast('/')
            .removeSuffix("-GGUF")
            .removeSuffix("-gguf")
        if (repoLeaf.isNotBlank()) {
            localFiles.find {
                it.name.contains(repoLeaf, ignoreCase = true) ||
                    modelStem(it.name).contains(repoLeaf, ignoreCase = true)
            }?.let { return it }
        }
        return null
    }

    fun annotate(item: HfListItem, localFiles: List<File>): HfListItem {
        val hit = findInstalled(localFiles, item.preferredFile, item.id) ?: return item
        return item.copy(
            installed = true,
            installedPath = hit.absolutePath,
            installedFileName = hit.name
        )
    }
}
