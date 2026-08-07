import { RequestContext } from '../context/request-context';
import { JsonLoggerService } from './json-logger.service';

function lastWrittenLine(spy: jest.SpyInstance): Record<string, unknown> {
  const calls = spy.mock.calls as unknown as [string][];
  const [text] = calls[calls.length - 1];
  return JSON.parse(text) as Record<string, unknown>;
}

describe('JsonLoggerService', () => {
  let logger: JsonLoggerService;
  let stdoutSpy: jest.SpyInstance;
  let stderrSpy: jest.SpyInstance;

  beforeEach(() => {
    logger = new JsonLoggerService();
    stdoutSpy = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    stderrSpy = jest
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('writes a JSON line with level, message and context to stdout', () => {
    logger.log('hello world', 'MyContext');

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    const line = lastWrittenLine(stdoutSpy);
    expect(line).toMatchObject({
      level: 'log',
      message: 'hello world',
      context: 'MyContext',
    });
    expect(typeof line.timestamp).toBe('string');
  });

  it('writes errors to stderr including the trace', () => {
    logger.error('boom', 'stack trace here', 'MyContext');

    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const line = lastWrittenLine(stderrSpy);
    expect(line).toMatchObject({
      level: 'error',
      message: 'boom',
      trace: 'stack trace here',
    });
  });

  it('serializes non-string messages', () => {
    logger.log({ some: 'object' });

    const line = lastWrittenLine(stdoutSpy);
    expect(line.message).toBe('{"some":"object"}');
  });

  it('attaches the correlationId from RequestContext when present', () => {
    RequestContext.run({ correlationId: 'req-123' }, () => {
      logger.log('inside context');
    });

    const line = lastWrittenLine(stdoutSpy);
    expect(line.correlationId).toBe('req-123');
  });

  it('omits correlationId when outside any RequestContext', () => {
    logger.log('outside context');

    const line = lastWrittenLine(stdoutSpy);
    expect(line.correlationId).toBeUndefined();
  });
});
