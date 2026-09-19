SELECT lower(username) AS normalized, COUNT(*) AS count, group_concat(username) AS variants FROM users GROUP BY lower(username) HAVING count > 1;

-- ↑ 语句必须放在文件最前面（D1 控制台粘贴会吃掉换行，注释开头会让整段失效）。
--
-- 用途：检查 users 表里是否存在"大小写不同的重复用户名"。
-- 正常情况下应该返回 0 行 —— 因为注册、验证、管理端建号三条写入路径都会先 toLowerCase。
-- 若返回了行，说明库里有历史遗留的混合大小写数据，先人工处理（改名或合并），
-- 再执行下面的归一化与唯一索引。

SELECT lower(email) AS normalized, COUNT(*) AS count, group_concat(email) AS variants FROM users WHERE email IS NOT NULL GROUP BY lower(email) HAVING count > 1;

-- 同上，检查邮箱。也应返回 0 行。

UPDATE users SET username = lower(username) WHERE username <> lower(username);

-- 把历史遗留的用户名归一化为小写。若上面第一条查出了重复，本语句会因
-- UNIQUE 约束失败 —— 这是预期的保护，不会造成数据丢失（整条语句原子回滚）。

UPDATE users SET email = lower(email) WHERE email IS NOT NULL AND email <> lower(email);

-- 同上，归一化邮箱。email 为 NULL 的管理员账号不受影响。

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_ci ON users(lower(username));

-- 数据库层兜底：用户名大小写不敏感唯一。
-- users 表上的 UNIQUE 用的是 SQLite 默认的二进制比较，'Alice' 与 'alice' 会被视为不同值；
-- 这个表达式索引才是真正的"不重复"保证，且能挡住以后新增的、忘记归一化的写入路径。

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_ci ON users(lower(email));

-- 同上，邮箱大小写不敏感唯一。
-- ⚠️ SQLite 的唯一索引把多个 NULL 视为互不相同，所以 email 为 NULL 的管理员账号不受影响。
--
-- 执行完可用下面这条确认索引已生效：
--   SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_users_%_ci';