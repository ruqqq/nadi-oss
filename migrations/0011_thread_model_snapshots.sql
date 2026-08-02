ALTER TABLE thread_index ADD COLUMN model_provider TEXT;
ALTER TABLE thread_index ADD COLUMN model TEXT;
ALTER TABLE thread_index ADD COLUMN model_input_modalities TEXT;
ALTER TABLE thread_index ADD COLUMN show_reasoning INTEGER;

UPDATE thread_index
SET
  model_provider = 'openai-oauth',
  model = 'gpt-5.5',
  model_input_modalities = '["text","image","file"]',
  show_reasoning = 1
WHERE model_provider IS NULL OR model IS NULL OR model_input_modalities IS NULL OR show_reasoning IS NULL;
