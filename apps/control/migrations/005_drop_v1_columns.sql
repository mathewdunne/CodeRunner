-- V2 cleanup: move the active NT4 host port off the V1-shaped sim_port name,
-- then drop the obsolete sim/LSP lease columns.

ALTER TABLE container_leases ADD COLUMN nt4_port INTEGER;
UPDATE container_leases SET nt4_port = sim_port WHERE sim_port IS NOT NULL;

DROP INDEX IF EXISTS idx_container_leases_sim_port_unique;
DROP INDEX IF EXISTS idx_container_leases_lsp_port_unique;

ALTER TABLE container_leases DROP COLUMN sim_container;
ALTER TABLE container_leases DROP COLUMN lsp_container;
ALTER TABLE container_leases DROP COLUMN sim_port;
ALTER TABLE container_leases DROP COLUMN lsp_port;
ALTER TABLE container_leases DROP COLUMN state;
ALTER TABLE container_leases DROP COLUMN lsp_state;

CREATE UNIQUE INDEX idx_container_leases_nt4_port_unique
  ON container_leases(nt4_port)
  WHERE nt4_port IS NOT NULL;
