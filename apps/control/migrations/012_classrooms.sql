-- Classroom join codes (decision 043). Guest users point at a classroom via
-- the Better Auth user.classroomId column, which Better Auth itself adds
-- (declared as an additionalField) — the user table does not exist yet when
-- these migrations run.
CREATE TABLE classrooms (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ended_at TEXT,
  cleaned_at TEXT
);

-- Codes are unique only among live classrooms; "live" depends on now(), so
-- uniqueness is enforced at creation time rather than by a constraint.
CREATE INDEX idx_classrooms_code ON classrooms(code);
