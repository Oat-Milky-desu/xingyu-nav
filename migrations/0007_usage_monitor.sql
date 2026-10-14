-- 用量监控：第三方服务凭据（密文）与最近一次取数缓存。
--
-- 与导航内容、JSON 备份刻意隔离：凭据既不出现在 /api/content，也不会被
-- /api/backup 导出。缓存是可重新生成的派生数据，同样不参与内容版本号。
CREATE TABLE usage_providers (
  provider TEXT PRIMARY KEY CHECK (provider IN ('cloudflare', 'deepseek')),
  -- 非敏感配置（Account ID、套餐、Worker 名称等），用于界面展示
  config_json TEXT NOT NULL,
  -- AES-GCM 加密后的凭据密文，格式 v1.<iv>.<ciphertext>（base64url）
  secret_json TEXT NOT NULL,
  -- 凭据每次变更 +1：在途的旧请求不能把过期用量写回缓存
  generation INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE usage_cache (
  provider TEXT PRIMARY KEY REFERENCES usage_providers(provider) ON DELETE CASCADE,
  -- 必须与 usage_providers.generation 一致，缓存才被认可
  generation INTEGER NOT NULL,
  -- 最近一次取数尝试的结果
  status TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('unknown', 'ok', 'error')),
  -- 最近一次成功取数的数据；失败时保留，界面可继续展示并标注时间
  payload_json TEXT,
  -- 最近一次失败原因（成功后被清空）
  error_message TEXT,
  last_success_at TEXT,
  last_success_ms INTEGER,
  last_attempt_ms INTEGER NOT NULL DEFAULT 0,
  -- 取数租约：并发刷新时只有一个请求真正访问上游
  lease_id TEXT,
  lease_until_ms INTEGER,
  updated_at TEXT NOT NULL,
  CHECK ((lease_id IS NULL AND lease_until_ms IS NULL) OR (lease_id IS NOT NULL AND lease_until_ms IS NOT NULL)),
  CHECK (status <> 'ok' OR payload_json IS NOT NULL)
);
