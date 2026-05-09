-- V2: Add code container columns for the merged openvscode-server + sim image.
-- The V2 merged container publishes both port 3000 (openvscode-server) and
-- port 5810 (NT4 sim). sim_port continues to track the NT4 port. vscode_port
-- tracks the openvscode-server port. Both belong to the same container.

ALTER TABLE container_leases ADD COLUMN vscode_container TEXT;
ALTER TABLE container_leases ADD COLUMN vscode_port INTEGER;
ALTER TABLE container_leases ADD COLUMN code_state TEXT NOT NULL DEFAULT 'missing';

CREATE UNIQUE INDEX idx_container_leases_vscode_port_unique
  ON container_leases(vscode_port)
  WHERE vscode_port IS NOT NULL;
