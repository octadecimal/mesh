CREATE TABLE project_event_streams (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  high_water INTEGER NOT NULL CHECK (high_water >= 0)
);

INSERT INTO project_event_streams (project_id, high_water)
SELECT project_id, MAX(sequence)
FROM project_events
GROUP BY project_id;
