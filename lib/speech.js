// Stage A' — pull text out of an audio file (voice memo, recording, etc.),
// entirely on-device.
//
// Mirrors lib/ocr.js: load a model, run inference, unload the model.
// Uses QVAC's built-in Whisper plugin (whispercpp-transcription), which is
// included in SDK_DEFAULT_PLUGINS — no extra installation needed.
//
// transcribe() accepts EITHER a file path (string) OR an audio buffer.
// We pass a path — same pattern lib/ocr.js uses for images.
//
// SDK 0.19.1 notes:
//   - MODEL_TYPES.whispercppTranscription = "whispercpp-transcription"
//   - WHISPER_EN_TINY_Q8_0 is ~43 MB, English-only, quantized Q8_0.
//     Fast on CPU. Swap to WHISPER_EN_BASE_Q8_0 if accuracy is poor.
import { loadModel, transcribe, unloadModel, WHISPER_EN_TINY_Q8_0, MODEL_TYPES } from "@qvac/sdk";
import { existsSync } from "node:fs";

export async function transcribeAudio(audioPath) {
  if (!existsSync(audioPath)) {
    throw new Error(`Audio file not found: ${audioPath}`);
  }

  const modelId = await loadModel({
    modelSrc: WHISPER_EN_TINY_Q8_0,
    modelType: MODEL_TYPES.whispercppTranscription,
  });

  try {
    const text = await transcribe({
      modelId,
      audioChunk: audioPath,
    });
    return String(text || "").trim();
  } finally {
    await unloadModel({ modelId }).catch(() => {});
  }
}