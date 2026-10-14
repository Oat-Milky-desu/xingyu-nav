import { fromBase64Url, toBase64Url } from './crypto';
import { HttpError } from './http';

/**
 * 需要可逆还原的第三方凭据（API Token / API Key）的对称加密。
 *
 * 这里不能用哈希：服务端必须能取回明文去访问上游接口。因此使用
 * AES-GCM（认证加密）与独立的服务端密钥 USAGE_ENCRYPTION_KEY：
 * - 密钥材料经 SHA-256 派生为 32 字节 AES 密钥，允许任意长度的随机字符串；
 * - 每次加密使用独立的 12 字节随机 IV，密文自带完整性校验；
 * - 存储格式带版本前缀，便于将来轮换密钥。
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const SECRET_VERSION = 'v1';
const MIN_KEY_LENGTH = 16;

export function hasUsableEncryptionKey(key: string | undefined): boolean {
  return typeof key === 'string' && key.trim().length >= MIN_KEY_LENGTH;
}

/** 读取并校验加密密钥；未配置时失败关闭，而不是静默降级为明文 */
export function requireEncryptionKey(env: { USAGE_ENCRYPTION_KEY?: string }): string {
  const key = env.USAGE_ENCRYPTION_KEY;
  if (!hasUsableEncryptionKey(key)) {
    throw new HttpError(
      500,
      'server_misconfigured',
      `服务端未配置 USAGE_ENCRYPTION_KEY（至少 ${MIN_KEY_LENGTH} 位随机字符串），无法保存用量监控凭据`,
    );
  }
  return (key as string).trim();
}

async function deriveKey(material: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(material));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptSecret(plaintext: string, material: string): Promise<string> {
  const key = await deriveKey(material);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(plaintext));
  return `${SECRET_VERSION}.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(cipher))}`;
}

/** 解密失败（密钥变更或数据损坏）时抛出，由调用方转换为面向用户的提示 */
export async function decryptSecret(payload: string, material: string): Promise<string> {
  const parts = payload.split('.');
  if (parts.length !== 3 || parts[0] !== SECRET_VERSION) {
    throw new Error('unsupported secret format');
  }
  const iv = fromBase64Url(parts[1] as string);
  const data = fromBase64Url(parts[2] as string);
  if (iv.length !== 12 || data.length === 0) throw new Error('invalid secret payload');
  const key = await deriveKey(material);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
  return decoder.decode(plain);
}
