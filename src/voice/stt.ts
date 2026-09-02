/**
 * STT capability layer over `expo-speech-recognition` (MIT). Permission,
 * on-device support, and offline-model probing/remediation — no recognition
 * session here (that's `duplex.ts`). No audio leaves the device; zero network.
 */
import { Platform } from 'react-native'
import { ExpoSpeechRecognitionModule as SR } from 'expo-speech-recognition'
import type { Locale, SttModelDownloadStatus } from '../types'
import { localeTag, normLocale, languageOf } from './locale'

/** Any recognizer present at all on this device. */
export function isRecognitionAvailable(): boolean {
  try {
    return SR.isRecognitionAvailable()
  } catch {
    return false
  }
}

/** Whether the private, free on-device model path is supported. */
export function supportsOnDevice(): boolean {
  try {
    return SR.supportsOnDeviceRecognition()
  } catch {
    return false
  }
}

/** Current mic permission WITHOUT prompting (safe on mount). */
export async function hasMicPermission(): Promise<boolean> {
  try {
    const p = await SR.getPermissionsAsync()
    return !!p.granted
  } catch {
    return false
  }
}

/** Request RECORD_AUDIO (+ speech on iOS) — presents the system dialog. */
export async function requestMicPermission(): Promise<boolean> {
  try {
    const p = await SR.requestPermissionsAsync()
    return !!p.granted
  } catch {
    return false
  }
}

/**
 * Is the OFFLINE model for the locale installed? On Android 13+ `installedLocales`
 * is frequently `[]` even when usable, so an empty list is treated as
 * "offer the download first" (returns false), never a hard failure. iOS manages
 * its own on-device dictation, so we don't block on a pack there.
 *
 * `servicePackage` optionally pins a specific recognizer package (e.g. Google's
 * on-device `com.google.android.as`); omit to use the system default.
 */
export async function isOfflineModelInstalled(
  locale: Locale,
  servicePackage?: string,
): Promise<boolean> {
  if (Platform.OS !== 'android') return true
  try {
    const opts = servicePackage ? { androidRecognitionServicePackage: servicePackage } : undefined
    const { installedLocales } = await SR.getSupportedLocales(opts as never)
    if (!installedLocales.length) return false
    const want = localeTag(locale)
    return (
      installedLocales.some((l: string) => normLocale(l) === normLocale(want)) ||
      installedLocales.some((l: string) => languageOf(l) === languageOf(want))
    )
  } catch {
    return false
  }
}

/** Trigger the offline-model download for the locale (Android 13+ only). */
export async function downloadSttModel(locale: Locale): Promise<SttModelDownloadStatus> {
  if (Platform.OS !== 'android' || !isRecognitionAvailable()) return 'unsupported'
  try {
    const res = await SR.androidTriggerOfflineModelDownload({ locale: localeTag(locale) })
    return res.status as SttModelDownloadStatus
  } catch {
    return 'unsupported'
  }
}
