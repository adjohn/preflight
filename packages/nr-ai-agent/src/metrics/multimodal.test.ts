import { detectModalities, modalityMetricsToCustomAttributes } from './multimodal.js';

describe('detectModalities', () => {
  it('should detect text-only messages', () => {
    const messages = [
      {
        role: 'user',
        content: [{ type: 'text', text: 'Hello world' }],
      },
    ];

    const metrics = detectModalities(messages);

    expect(metrics.inputModalities).toEqual(['text']);
    expect(metrics.imageCount).toBe(0);
    expect(metrics.pdfCount).toBe(0);
    expect(metrics.audioSeconds).toBe(0);
    expect(metrics.videoSeconds).toBe(0);
    expect(metrics.imageTokenEstimate).toBe(0);
  });

  it('should detect Anthropic-style images with base64 data', () => {
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Look at this image' },
          {
            type: 'image',
            source: { type: 'base64', data: 'iVBORw0KGgo=' + 'A'.repeat(100) }, // PNG header
          },
          {
            type: 'image',
            source: { type: 'base64', data: '/9j/4AAQSkZ' + 'A'.repeat(100) }, // JPEG header
          },
        ],
      },
    ];

    const metrics = detectModalities(messages);

    expect(metrics.inputModalities).toContain('text');
    expect(metrics.inputModalities).toContain('image');
    expect(metrics.imageCount).toBe(2);
    expect(metrics.imageTokenEstimate).toBeGreaterThan(0);
  });

  it('should detect Anthropic-style PDFs', () => {
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Review this document' },
          {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0x' },
            metadata: { pages: 5 },
          },
        ],
      },
    ];

    const metrics = detectModalities(messages);

    expect(metrics.inputModalities).toContain('text');
    expect(metrics.inputModalities).toContain('pdf');
    expect(metrics.pdfCount).toBe(1);
    expect(metrics.pdfPageCount).toBe(5);
  });

  it('should detect Gemini-style audio messages', () => {
    const messages = [
      {
        role: 'user',
        parts: [
          { text: 'What do you hear?' },
          {
            inlineData: {
              mimeType: 'audio/mp3',
              data: 'SUQzBA==', // MP3-like data
              duration_seconds: 30.5,
            },
          },
        ],
      },
    ];

    const metrics = detectModalities(messages);

    expect(metrics.inputModalities).toContain('text');
    expect(metrics.inputModalities).toContain('audio');
    expect(metrics.audioSeconds).toBeCloseTo(30.5, 1);
  });

  it('should detect Gemini-style video messages', () => {
    const messages = [
      {
        role: 'user',
        parts: [
          { text: 'Describe the video' },
          {
            inlineData: {
              mimeType: 'video/mp4',
              data: 'AAAAIG1vb3Y=', // MP4-like data
              duration: 45.0,
            },
          },
        ],
      },
    ];

    const metrics = detectModalities(messages);

    expect(metrics.inputModalities).toContain('text');
    expect(metrics.inputModalities).toContain('video');
    expect(metrics.videoSeconds).toBeCloseTo(45.0, 1);
  });

  it('should detect mixed modalities', () => {
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Analyze this package' },
          {
            type: 'image',
            source: { type: 'base64', data: '/9j/' + 'B'.repeat(100) },
          },
          {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0x' },
            metadata: { pages: 10 },
          },
        ],
      },
    ];

    const metrics = detectModalities(messages);

    expect(metrics.inputModalities).toContain('text');
    expect(metrics.inputModalities).toContain('image');
    expect(metrics.inputModalities).toContain('pdf');
    expect(metrics.imageCount).toBe(1);
    expect(metrics.pdfCount).toBe(1);
    expect(metrics.pdfPageCount).toBe(10);
  });

  it('should estimate image tokens using Anthropic formula', () => {
    // 1000x1000 image should use (1000*1000)/750 = 1333 tokens
    const messages = [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            width: 1000,
            height: 1000,
          },
        ],
      },
    ];

    const metrics = detectModalities(messages);

    // Should be ceiling of (1000*1000)/750 = 1334
    expect(metrics.imageTokenEstimate).toBe(1334);
  });

  it('should handle multiple images with different sizes', () => {
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'image', width: 800, height: 600 }, // 640 tokens
          { type: 'image', width: 1200, height: 900 }, // 1440 tokens
        ],
      },
    ];

    const metrics = detectModalities(messages);

    expect(metrics.imageCount).toBe(2);
    // 640 + 1440 = 2080
    expect(metrics.imageTokenEstimate).toBe(2080);
  });

  it('should estimate tokens for image without dimensions', () => {
    const messages = [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', data: 'somebase64data' },
          },
        ],
      },
    ];

    const metrics = detectModalities(messages);

    expect(metrics.imageCount).toBe(1);
    expect(metrics.imageTokenEstimate).toBeGreaterThan(0); // Should have conservative estimate
  });

  it('should handle Gemini fileData with PDF', () => {
    const messages = [
      {
        role: 'user',
        parts: [
          { text: 'Check this file' },
          {
            fileData: {
              mimeType: 'application/pdf',
              fileUri: 'gs://bucket/document.pdf',
              pages: 15,
            },
          },
        ],
      },
    ];

    const metrics = detectModalities(messages);

    expect(metrics.inputModalities).toContain('pdf');
    expect(metrics.pdfCount).toBe(1);
    expect(metrics.pdfPageCount).toBe(15);
  });

  it('should handle empty message arrays', () => {
    const messages: unknown[] = [];

    const metrics = detectModalities(messages);

    expect(metrics.inputModalities).toEqual(['text']); // Default to text
    expect(metrics.imageCount).toBe(0);
    expect(metrics.pdfCount).toBe(0);
  });

  it('should handle non-array input', () => {
    const metrics = detectModalities(null as unknown as unknown[]);

    expect(metrics.inputModalities).toEqual(['text']);
    expect(metrics.imageCount).toBe(0);
  });

  it('should handle malformed content blocks', () => {
    const messages = [
      {
        role: 'user',
        content: [
          null,
          undefined,
          { type: 'text', text: 'Valid text' },
          { type: 'unknown', data: 'something' },
        ],
      },
    ];

    const metrics = detectModalities(messages);

    expect(metrics.inputModalities).toContain('text');
    expect(metrics.imageCount).toBe(0);
  });

  it('should calculate text tokens from multiple text blocks', () => {
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Hello world' }, // ~3 tokens
          { type: 'text', text: 'This is a test message' }, // ~4 tokens
        ],
      },
    ];

    const metrics = detectModalities(messages);

    expect(metrics.textTokens).toBeGreaterThan(0);
  });

  it('should detect modalities in Gemini parts array', () => {
    const messages = [
      {
        role: 'user',
        parts: [
          { text: 'Process these' },
          {
            inlineData: {
              mimeType: 'image/jpeg',
              data: '/9j/4AAQSkZ' + 'X'.repeat(50),
            },
          },
          {
            inlineData: {
              mimeType: 'audio/wav',
              data: 'UklGRi4=',
              duration_seconds: 5.0,
            },
          },
        ],
      },
    ];

    const metrics = detectModalities(messages);

    expect(metrics.inputModalities).toContain('text');
    expect(metrics.inputModalities).toContain('image');
    expect(metrics.inputModalities).toContain('audio');
    expect(metrics.imageCount).toBe(1);
    expect(metrics.audioSeconds).toBeCloseTo(5.0, 1);
  });

  it('should sort modalities alphabetically', () => {
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Test' },
          { type: 'image', width: 100, height: 100 },
          { type: 'document', metadata: { pages: 1 } },
        ],
      },
    ];

    const metrics = detectModalities(messages);

    // Should be sorted: image, pdf, text
    expect(metrics.inputModalities).toEqual(['image', 'pdf', 'text']);
  });

  it('should default to 1 page for PDF without metadata', () => {
    const messages = [
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0x' },
          },
        ],
      },
    ];

    const metrics = detectModalities(messages);

    expect(metrics.pdfCount).toBe(1);
    expect(metrics.pdfPageCount).toBe(1);
  });
});

describe('modalityMetricsToCustomAttributes', () => {
  it('should convert metrics to custom attributes', () => {
    const metrics = {
      inputModalities: ['text', 'image'],
      imageCount: 2,
      imageTokenEstimate: 1000,
      pdfCount: 1,
      pdfPageCount: 5,
      audioSeconds: 30.5,
      videoSeconds: 0,
      textTokens: 100,
    };

    const attrs = modalityMetricsToCustomAttributes(metrics);

    expect(attrs['ai.input.modalities']).toBe('text,image');
    expect(attrs['ai.input.image_count']).toBe(2);
    expect(attrs['ai.input.image_token_estimate']).toBe(1000);
    expect(attrs['ai.input.pdf_count']).toBe(1);
    expect(attrs['ai.input.pdf_page_count']).toBe(5);
    expect(attrs['ai.input.audio_seconds']).toBe(30.5);
    expect(attrs['ai.input.video_seconds']).toBe(0);
    expect(attrs['ai.input.text_tokens']).toBe(100);
  });

  it('should handle zero values', () => {
    const metrics = {
      inputModalities: ['text'],
      imageCount: 0,
      imageTokenEstimate: 0,
      pdfCount: 0,
      pdfPageCount: 0,
      audioSeconds: 0,
      videoSeconds: 0,
      textTokens: 0,
    };

    const attrs = modalityMetricsToCustomAttributes(metrics);

    expect(attrs['ai.input.image_count']).toBe(0);
    expect(attrs['ai.input.pdf_count']).toBe(0);
    expect(attrs['ai.input.audio_seconds']).toBe(0);
  });

  it('should round audio and video seconds to 2 decimals', () => {
    const metrics = {
      inputModalities: ['audio', 'video'],
      imageCount: 0,
      imageTokenEstimate: 0,
      pdfCount: 0,
      pdfPageCount: 0,
      audioSeconds: 12.3456,
      videoSeconds: 45.6789,
      textTokens: 0,
    };

    const attrs = modalityMetricsToCustomAttributes(metrics);

    expect(attrs['ai.input.audio_seconds']).toBe(12.35);
    expect(attrs['ai.input.video_seconds']).toBe(45.68);
  });
});
