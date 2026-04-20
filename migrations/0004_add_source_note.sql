-- 添加来源字段：paddle（自动购买）/ manual（手动发放）
ALTER TABLE licenses ADD COLUMN source TEXT NOT NULL DEFAULT 'paddle';

-- 添加备注字段：用于记录手动发放的原因（如 KOL 赠送、退款补偿、内部测试等）
ALTER TABLE licenses ADD COLUMN note TEXT;
