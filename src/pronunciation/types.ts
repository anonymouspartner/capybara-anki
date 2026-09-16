/** D14/D18: the three honest buckets a Whisper transcript comparison can support
 * — "right", "close", "wrong", never a percentage (a 0-100 number would imply a
 * precision transcription-versus-target doesn't have). */
export type PronunciationBucket = "right" | "close" | "wrong";

/** A recording could not be transcribed. Message is safe to show a user. */
export class TranscriptionError extends Error {}
