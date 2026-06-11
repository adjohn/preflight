import { SpanStatusCode, context } from '@opentelemetry/api';
import type { ToolCallRecord } from '../storage/types.js';
import { emitToolCallSpan } from './tool-call-span.js';

const mockSpan = {
  setAttributes: jest.fn(),
  setStatus: jest.fn(),
  recordException: jest.fn(),
  end: jest.fn(),
};

const mockTracer = { startSpan: jest.fn(() => mockSpan) };

jest.mock('./mcp-tracer.js', () => ({ getMcpTracer: () => mockTracer }));

const makeRecord = (overrides: Partial<ToolCallRecord> = {}): ToolCallRecord =>
  ({
    sessionId: 'session-1',
    toolUseId: 'tool-use-1',
    toolName: 'Read',
    timestamp: 1000,
    durationMs: 100,
    success: true,
    inputSizeBytes: 10,
    outputSizeBytes: 20,
    error: undefined,
    errorType: undefined,
    filePath: undefined,
    ...overrides,
  }) as ToolCallRecord;

describe('emitToolCallSpan', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('emits span with correct attributes for successful tool call', () => {
    const record = makeRecord({
      toolName: 'Bash',
      success: true,
      inputSizeBytes: 50,
      outputSizeBytes: 100,
    });

    const parentContext = context.active();
    emitToolCallSpan(record, parentContext, 'task-1');

    expect(mockTracer.startSpan).toHaveBeenCalledWith(
      'mcp.tool.Bash',
      expect.objectContaining({
        attributes: expect.objectContaining({
          'mcp.tool.name': 'Bash',
          'mcp.tool.use_id': 'tool-use-1',
          'ai.session.id': 'session-1',
          'mcp.tool.success': true,
          'mcp.tool.input_size_bytes': 50,
          'mcp.tool.output_size_bytes': 100,
          'ai.task.id': 'task-1',
        }),
      }),
      parentContext,
    );
  });

  test('sets OK status for successful tool call', () => {
    const record = makeRecord({ success: true });
    const parentContext = context.active();

    emitToolCallSpan(record, parentContext);

    expect(mockSpan.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.OK });
  });

  test('sets ERROR status for failed tool call', () => {
    const record = makeRecord({
      success: false,
      error: 'File not found',
    });
    const parentContext = context.active();

    emitToolCallSpan(record, parentContext);

    expect(mockSpan.setStatus).toHaveBeenCalledWith({
      code: SpanStatusCode.ERROR,
      message: 'File not found',
    });
    expect(mockSpan.recordException).toHaveBeenCalledWith(new Error('File not found'));
  });

  test('records exception for failed tool call with error', () => {
    const record = makeRecord({
      success: false,
      error: 'Connection timeout',
    });
    const parentContext = context.active();

    emitToolCallSpan(record, parentContext);

    expect(mockSpan.recordException).toHaveBeenCalledWith(new Error('Connection timeout'));
  });

  test('handles orphaned tool call (no post event)', () => {
    const record = makeRecord({
      durationMs: null,
    });
    const parentContext = context.active();

    emitToolCallSpan(record, parentContext);

    expect(mockSpan.setStatus).toHaveBeenCalledWith({
      code: SpanStatusCode.ERROR,
      message: 'orphaned tool call (no post event)',
    });
    expect(mockSpan.end).toHaveBeenCalledWith();
  });

  test('ends span with end time based on duration', () => {
    const record = makeRecord({
      timestamp: 1000,
      durationMs: 250,
      success: true,
    });
    const parentContext = context.active();

    emitToolCallSpan(record, parentContext);

    expect(mockSpan.end).toHaveBeenCalledWith(1250);
  });

  test('omits I/O size bytes when undefined', () => {
    const record = makeRecord({
      inputSizeBytes: undefined,
      outputSizeBytes: undefined,
    });
    const parentContext = context.active();

    emitToolCallSpan(record, parentContext);

    const callArgs = mockTracer.startSpan.mock.calls[0] as unknown[];
    const attributes = (callArgs[1] as { attributes?: Record<string, unknown> })?.attributes;
    expect(attributes).not.toHaveProperty('mcp.tool.input_size_bytes');
    expect(attributes).not.toHaveProperty('mcp.tool.output_size_bytes');
  });

  test('omits task ID when not provided', () => {
    const record = makeRecord();
    const parentContext = context.active();

    emitToolCallSpan(record, parentContext);

    const callArgs = mockTracer.startSpan.mock.calls[0] as unknown[];
    const attributes = (callArgs[1] as { attributes?: Record<string, unknown> })?.attributes;
    expect(attributes).not.toHaveProperty('ai.task.id');
  });

  test('emits bash.* attributes for Bash tool call when classifier fields are present', () => {
    const record = makeRecord({
      toolName: 'Bash',
      bashCategory: 'test-runner',
      bashLeading: 'jest',
      bashDestructive: false,
      bashNetwork: false,
    });
    emitToolCallSpan(record, context.active());

    const callArgs = mockTracer.startSpan.mock.calls[0] as unknown[];
    const attributes = (callArgs[1] as { attributes?: Record<string, unknown> })?.attributes;
    expect(attributes).toMatchObject({
      'bash.category': 'test-runner',
      'bash.leading': 'jest',
      'bash.destructive': false,
      'bash.network': false,
    });
  });

  test('does NOT emit bash.* attributes for non-Bash tool calls (gating)', () => {
    // Even if a stray bashCategory landed on a non-Bash record (it shouldn't,
    // but defense in depth), the span must not advertise bash.* attributes.
    const record = makeRecord({
      toolName: 'Read',
      bashCategory: 'git',
      bashLeading: 'git',
      bashDestructive: true,
      bashNetwork: true,
    });
    emitToolCallSpan(record, context.active());

    const callArgs = mockTracer.startSpan.mock.calls[0] as unknown[];
    const attributes = (callArgs[1] as { attributes?: Record<string, unknown> })?.attributes;
    expect(attributes).not.toHaveProperty('bash.category');
    expect(attributes).not.toHaveProperty('bash.leading');
    expect(attributes).not.toHaveProperty('bash.destructive');
    expect(attributes).not.toHaveProperty('bash.network');
  });

  test('omits bash.* attributes for Bash calls that have no classifier fields', () => {
    // If a Bash record arrives without bashCategory etc. (older recorder,
    // proxy/replay path), no bash.* attrs should be emitted.
    const record = makeRecord({ toolName: 'Bash' });
    emitToolCallSpan(record, context.active());

    const callArgs = mockTracer.startSpan.mock.calls[0] as unknown[];
    const attributes = (callArgs[1] as { attributes?: Record<string, unknown> })?.attributes;
    expect(attributes).not.toHaveProperty('bash.category');
    expect(attributes).not.toHaveProperty('bash.leading');
    expect(attributes).not.toHaveProperty('bash.destructive');
    expect(attributes).not.toHaveProperty('bash.network');
  });
});
