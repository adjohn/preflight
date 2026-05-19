import { createLogger } from '@nr-ai-observatory/shared';

const logger = createLogger('multimodal-tracker');

export interface MultiModalMetrics {
  readonly inputModalities: string[];
  readonly imageCount: number;
  readonly imageTokenEstimate: number;
  readonly pdfCount: number;
  readonly pdfPageCount: number;
  readonly audioSeconds: number;
  readonly videoSeconds: number;
  readonly textTokens: number;
}

// Helper: detect image dimensions from base64 data
function getImageDimensionsFromBase64(base64Data: string): { width: number; height: number } | null {
  try {
    // PNG: bytes 16-24 contain width/height as big-endian 32-bit ints
    if (base64Data.startsWith('iVBORw0KGgo')) {
      const binaryString = Buffer.from(base64Data, 'base64').toString('binary');
      if (binaryString.length >= 24) {
        const width = (binaryString.charCodeAt(16) << 24) | (binaryString.charCodeAt(17) << 16) |
                      (binaryString.charCodeAt(18) << 8) | binaryString.charCodeAt(19);
        const height = (binaryString.charCodeAt(20) << 24) | (binaryString.charCodeAt(21) << 16) |
                       (binaryString.charCodeAt(22) << 8) | binaryString.charCodeAt(23);
        return { width: width >>> 0, height: height >>> 0 };
      }
    }

    // JPEG: look for SOF marker (0xFFC0-0xFFC9) which contains dimensions
    if (base64Data.startsWith('/9j/')) {
      const buffer = Buffer.from(base64Data, 'base64');
      // Simplified: just estimate from file size
      // Real JPEG parsing would decode SOF marker
      const estimatedPixels = Math.sqrt((buffer.length * 8) / 24); // rough estimate
      return { width: Math.round(estimatedPixels), height: Math.round(estimatedPixels) };
    }

    // WebP: similar approach
    if (base64Data.startsWith('UklGR')) {
      const buffer = Buffer.from(base64Data, 'base64');
      const estimatedPixels = Math.sqrt((buffer.length * 8) / 32);
      return { width: Math.round(estimatedPixels), height: Math.round(estimatedPixels) };
    }

    return null;
  } catch {
    return null;
  }
}

// Helper: estimate image tokens using Anthropic's formula
function estimateImageTokens(width: number, height: number): number {
  return Math.ceil((width * height) / 750);
}

// Helper: detect image dimensions or estimate from base64 size
function getImageTokenEstimate(imageData: Record<string, unknown>): number {
  const width = imageData.width as number | undefined;
  const height = imageData.height as number | undefined;

  // If dimensions are provided, use them
  if (width && height) {
    return estimateImageTokens(width, height);
  }

  // Try to extract base64 data
  let base64Data = imageData.base64 as string | undefined;
  const source = imageData.source as Record<string, unknown> | undefined;

  if (!base64Data && source?.type === 'base64' && source?.data) {
    base64Data = source.data as string;
  }

  if (base64Data) {
    // Try to detect dimensions from base64 header
    const dims = getImageDimensionsFromBase64(base64Data);
    if (dims) {
      return estimateImageTokens(dims.width, dims.height);
    }

    // Fallback: estimate from base64 size
    // Base64 encoding is ~4/3 larger; assume ~4 bytes per pixel
    const binarySize = (base64Data.length * 3) / 4;
    const estimatedPixels = binarySize / 4;
    const estimatedDim = Math.sqrt(estimatedPixels);
    return estimateImageTokens(Math.round(estimatedDim), Math.round(estimatedDim));
  }

  // Default estimate for images without size info
  logger.warn('Unable to determine image dimensions, using default estimate', {
    hasBase64: !!imageData.base64,
    hasSource: !!imageData.source,
  });
  return 512; // Conservative default
}

// Helper: parse PDF page count from metadata or filename
function parsePdfPageCount(metadata?: Record<string, unknown>): number {
  if (metadata?.pages && typeof metadata.pages === 'number') {
    return metadata.pages;
  }
  return 1; // Default to 1 if unknown
}

// Helper: parse audio duration in seconds
function parseAudioSeconds(metadata?: Record<string, unknown>): number {
  if (metadata?.duration_seconds && typeof metadata.duration_seconds === 'number') {
    return metadata.duration_seconds;
  }
  if (metadata?.duration && typeof metadata.duration === 'number') {
    return metadata.duration;
  }
  return 0;
}

// Main detection function - generic message format
export function detectModalities(messages: unknown[]): MultiModalMetrics {
  const modalities = new Set<string>();
  let imageCount = 0;
  let imageTokenEstimate = 0;
  let pdfCount = 0;
  let pdfPageCount = 0;
  let audioSeconds = 0;
  let videoSeconds = 0;
  let textTokens = 0;

  if (!Array.isArray(messages)) {
    modalities.add('text');
    return {
      inputModalities: Array.from(modalities),
      imageCount,
      imageTokenEstimate,
      pdfCount,
      pdfPageCount,
      audioSeconds,
      videoSeconds,
      textTokens,
    };
  }

  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;

    const msg = message as Record<string, unknown>;

    // Handle Anthropic-style messages (content array with blocks)
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (!block || typeof block !== 'object') continue;

        const contentBlock = block as Record<string, unknown>;

        if (contentBlock.type === 'text' && typeof contentBlock.text === 'string') {
          modalities.add('text');
          textTokens += Math.ceil(contentBlock.text.length / 4);
        }

        if (contentBlock.type === 'image') {
          modalities.add('image');
          imageCount += 1;
          imageTokenEstimate += getImageTokenEstimate(contentBlock);
        }

        if (contentBlock.type === 'document') {
          modalities.add('pdf');
          pdfCount += 1;
          const pdfMeta = contentBlock.metadata as Record<string, unknown> | undefined;
          pdfPageCount += parsePdfPageCount(pdfMeta);
        }
      }
    }

    // Handle Gemini-style messages (parts array)
    if (Array.isArray(msg.parts)) {
      for (const part of msg.parts) {
        if (!part || typeof part !== 'object') continue;

        const partData = part as Record<string, unknown>;

        if (partData.text && typeof partData.text === 'string') {
          modalities.add('text');
          textTokens += Math.ceil(partData.text.length / 4);
        }

        // Gemini inlineData
        if (partData.inlineData && typeof partData.inlineData === 'object') {
          const inlineData = partData.inlineData as Record<string, unknown>;
          const mimeType = typeof inlineData.mimeType === 'string' ? inlineData.mimeType : '';

          if (mimeType.startsWith('image/')) {
            modalities.add('image');
            imageCount += 1;
            // Estimate from data field
            if (typeof inlineData.data === 'string') {
              imageTokenEstimate += getImageTokenEstimate({ base64: inlineData.data });
            } else {
              imageTokenEstimate += 512; // Conservative default
            }
          }

          if (mimeType.startsWith('audio/')) {
            modalities.add('audio');
            audioSeconds += parseAudioSeconds(inlineData);
          }

          if (mimeType.startsWith('video/')) {
            modalities.add('video');
            videoSeconds += parseAudioSeconds(inlineData);
          }
        }

        // Gemini fileData
        if (partData.fileData && typeof partData.fileData === 'object') {
          const fileData = partData.fileData as Record<string, unknown>;
          const mimeType = typeof fileData.mimeType === 'string' ? fileData.mimeType : '';

          if (mimeType.startsWith('image/')) {
            modalities.add('image');
            imageCount += 1;
            imageTokenEstimate += 512; // Default for uploaded files
          }

          if (mimeType.startsWith('application/pdf')) {
            modalities.add('pdf');
            pdfCount += 1;
            pdfPageCount += parsePdfPageCount(fileData);
          }

          if (mimeType.startsWith('audio/')) {
            modalities.add('audio');
            audioSeconds += parseAudioSeconds(fileData);
          }

          if (mimeType.startsWith('video/')) {
            modalities.add('video');
            videoSeconds += parseAudioSeconds(fileData);
          }
        }
      }
    }
  }

  // Always include text if no other modalities detected
  if (modalities.size === 0) {
    modalities.add('text');
  }

  return {
    inputModalities: Array.from(modalities).sort(),
    imageCount,
    imageTokenEstimate,
    pdfCount,
    pdfPageCount,
    audioSeconds,
    videoSeconds,
    textTokens,
  };
}

export function modalityMetricsToCustomAttributes(metrics: MultiModalMetrics): Record<string, string | number> {
  const attrs: Record<string, string | number> = {
    'ai.input.modalities': metrics.inputModalities.join(','),
    'ai.input.image_count': metrics.imageCount,
    'ai.input.image_token_estimate': metrics.imageTokenEstimate,
    'ai.input.pdf_count': metrics.pdfCount,
    'ai.input.pdf_page_count': metrics.pdfPageCount,
    'ai.input.audio_seconds': Math.round(metrics.audioSeconds * 100) / 100,
    'ai.input.video_seconds': Math.round(metrics.videoSeconds * 100) / 100,
    'ai.input.text_tokens': metrics.textTokens,
  };

  return attrs;
}
