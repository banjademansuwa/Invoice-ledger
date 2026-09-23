// Stage A — pull raw text out of a receipt photo, entirely on-device.
//
// Uses QVAC's EasyOCR pipeline. OCR_LATIN is the Latin-script recognizer;
// the SDK auto-derives the matching CRAFT text detector from the same
// descriptor, so we only load one model here.
import { loadModel, ocr, unloadModel, OCR_LATIN, MODEL_TYPES } from "@qvac/sdk";
import { existsSync } from "node:fs";

export async function extractText(imagePath) {
  if (!existsSync(imagePath)) {
    throw new Error(`Image not found: ${imagePath}`);
  }

  const modelId = await loadModel({
    modelSrc: OCR_LATIN.src,
    modelType: MODEL_TYPES.ggmlOcr,
  });

  try {
    const { blocks } = ocr({ modelId, image: imagePath });
    const detected = await blocks;
    return detected
      .map((b) => (b && typeof b.text === "string" ? b.text.trim() : ""))
      .filter(Boolean)
      .join("\n");
  } finally {
    await unloadModel({ modelId }).catch(() => {});
  }
}
