plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

val enableNative =
    (findProperty("afkllm.native") as String?)?.equals("false", ignoreCase = true) != true

val llamaCppDir = rootProject.projectDir.resolve("../third_party/llama.cpp")
val withLlama =
    enableNative &&
        (findProperty("afkllm.withLlama") as String?)?.equals("false", ignoreCase = true) != true &&
        llamaCppDir.resolve("CMakeLists.txt").exists()

android {
    namespace = "com.afkllm.llama"
    compileSdk = 35

    defaultConfig {
        minSdk = 26
        consumerProguardFiles("consumer-rules.pro")
        if (enableNative) {
            externalNativeBuild {
                cmake {
                    cppFlags += listOf("-std=c++17", "-O2", "-fexceptions")
                    arguments += listOf("-DANDROID_STL=c++_shared")
                    if (withLlama) {
                        arguments += listOf(
                            "-DAFKLLM_WITH_LLAMA=ON",
                            "-DLLAMA_CPP_DIR=${llamaCppDir.absolutePath.replace('\\', '/')}"
                        )
                    }
                }
            }
            ndk {
                // Phone devices only — faster link / smaller APK
                abiFilters += listOf("arm64-v8a")
            }
        }
        buildConfigField("boolean", "HAS_NATIVE", if (enableNative) "true" else "false")
        buildConfigField("boolean", "HAS_LLAMA", if (withLlama) "true" else "false")
    }

    buildFeatures {
        buildConfig = true
    }

    if (enableNative) {
        externalNativeBuild {
            cmake {
                path = file("src/main/cpp/CMakeLists.txt")
                version = "3.22.1"
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
}
