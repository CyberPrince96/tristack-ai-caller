/**
 * Locale helpers — fully generic. The host passes a BCP-47 locale string
 * (`"en-US"`, `"hi-IN"`, `"es-ES"`, …); nothing here is language-specific.
 */
import type { Locale } from '../types'

/** Normalise a locale tag: `hi_IN` / `HI-in` → `hi-in`. */
export const normLocale = (s: string): string => s.replace(/_/g, '-').toLowerCase()

/** Language prefix of a tag: `hi-IN` → `hi`. */
export const languageOf = (s: string): string => normLocale(s).split('-')[0] ?? ''

/**
 * Any Unicode LETTER counts toward the min-length gates (every script — Latin,
 * Devanagari, Arabic, CJK, Cyrillic …), so the package is script-agnostic. Used
 * to reject 1-char spurious partials the recognizer emits on room noise while
 * still accepting a real single-syllable word.
 */
export const WORD_CHAR = /\p{L}/u

/** The tag we hand the recognizer/TTS is the caller's locale, verbatim. */
export const localeTag = (locale: Locale): string => locale
