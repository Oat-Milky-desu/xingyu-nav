-- 管理后台上传的单张壁纸图片保存在 D1 中，与站点设置和备份恢复一起原子更新。
CREATE TABLE wallpaper_image (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  mime_type TEXT NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
  image BLOB NOT NULL CHECK (length(image) BETWEEN 1 AND 1000000),
  updated_at TEXT NOT NULL
);
