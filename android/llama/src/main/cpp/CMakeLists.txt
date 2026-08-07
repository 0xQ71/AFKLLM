cmake_minimum_required(VERSION 3.22.1)
project(afkllm_llama)

add_library(afkllm_llama SHARED
    afkllm_llama_jni.cpp
)

find_library(log-lib log)
target_link_libraries(afkllm_llama ${log-lib})

option(AFKLLM_WITH_LLAMA "Link against llama.cpp" OFF)
if(AFKLLM_WITH_LLAMA)
    if(NOT DEFINED LLAMA_CPP_DIR)
        message(FATAL_ERROR "LLAMA_CPP_DIR must be set when AFKLLM_WITH_LLAMA=ON")
    endif()

    set(LLAMA_BUILD_COMMON OFF CACHE BOOL "" FORCE)
    set(LLAMA_BUILD_TESTS OFF CACHE BOOL "" FORCE)
    set(LLAMA_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
    set(LLAMA_BUILD_TOOLS OFF CACHE BOOL "" FORCE)
    set(LLAMA_BUILD_SERVER OFF CACHE BOOL "" FORCE)
    set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
    set(GGML_NATIVE OFF CACHE BOOL "" FORCE)

    add_subdirectory(${LLAMA_CPP_DIR} llama_build EXCLUDE_FROM_ALL)

    target_compile_definitions(afkllm_llama PRIVATE AFKLLM_WITH_LLAMA=1)
    target_include_directories(afkllm_llama PRIVATE ${LLAMA_CPP_DIR}/include ${LLAMA_CPP_DIR}/ggml/include)
    target_link_libraries(afkllm_llama llama ggml)
endif()
