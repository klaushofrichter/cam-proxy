import { describe, expect, it } from 'vitest';
import { cmdFields, whoFields } from '../src/audit/audit-log';

describe('audit whoFields / cmdFields', () => {
  it('carries ip and userAgent only when set, in that order', () => {
    expect(whoFields({ ip: '10.0.0.1', userAgent: 'ua' })).toEqual({ ip: '10.0.0.1', userAgent: 'ua' });
    expect(Object.keys(whoFields({ userAgent: 'ua', ip: '10.0.0.1' }))).toEqual(['ip', 'userAgent']);
    expect(whoFields({ ip: '', userAgent: undefined })).toEqual({});
    expect(whoFields(undefined)).toEqual({});
  });
  it('carries cmdId and actor only when set', () => {
    expect(cmdFields({ cmdId: 'cmd_1', actor: 'klaus' })).toEqual({ cmdId: 'cmd_1', actor: 'klaus' });
    expect(cmdFields({ actor: 'klaus' })).toEqual({ actor: 'klaus' });
    expect(Object.keys(cmdFields({}))).toEqual([]);
  });
});
