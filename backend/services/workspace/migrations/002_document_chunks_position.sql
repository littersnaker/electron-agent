-- 为向量块补充“来源内位置”字段：PDF 记页码，便于回答时展示具体位置。
ALTER TABLE document_chunks ADD COLUMN position TEXT NOT NULL DEFAULT '';
