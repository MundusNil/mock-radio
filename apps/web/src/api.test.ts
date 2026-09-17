import { describe, expect, it } from 'vitest';
import { decodeAdminJson } from './api';

describe('decodeAdminJson', () => {
  it('旧进程纯文本 404 不会冒出 JSON.parse 的 position 4', () => {
    expect(() => decodeAdminJson(404, '404 Not Found', '/api/admin/library 404')).toThrow(
      /pnpm stop/,
    );
  });

  it('合法 JSON 错误体抽出 error 字段', () => {
    expect(() => decodeAdminJson(400, '{"error":"缺文件"}', 'fallback')).toThrow('缺文件');
  });

  it('200 JSON 原样返回', () => {
    expect(decodeAdminJson(200, '{"poolSize":2}', 'x')).toEqual({ poolSize: 2 });
  });
});
