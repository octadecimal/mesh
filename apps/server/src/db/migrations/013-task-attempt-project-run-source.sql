ALTER TABLE task_attempts ADD COLUMN source_json TEXT
  CHECK (
    source_json IS NULL
    OR (
      source = 'launched'
      AND json_valid(source_json)
      AND json_extract(source_json, '$.type') = 'project_run'
      AND json_type(source_json, '$.runId') = 'text'
      AND length(trim(json_extract(source_json, '$.runId'))) > 0
      AND json_type(source_json, '$.runItemId') = 'text'
      AND length(trim(json_extract(source_json, '$.runItemId'))) > 0
    )
  );
