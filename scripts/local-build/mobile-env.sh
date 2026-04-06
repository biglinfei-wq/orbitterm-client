#!/usr/bin/env bash
set -euo pipefail

# Shared env for local mobile builds (Android + iOS).
export PATH="/opt/homebrew/opt/openjdk@17/bin:${PATH}"
export JAVA_HOME="/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home"

export ANDROID_HOME="${ANDROID_HOME:-${HOME}/Library/Android/sdk}"
export ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-${ANDROID_HOME}}"

ANDROID_NDK_VERSION="${ANDROID_NDK_VERSION:-29.0.14206865}"
export NDK_HOME="${NDK_HOME:-${ANDROID_HOME}/ndk/${ANDROID_NDK_VERSION}}"

export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
