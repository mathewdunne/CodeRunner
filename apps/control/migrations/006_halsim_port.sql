-- Add halsim_port column to container_leases for the HALSim WebSocket proxy.
-- This is the third per-container loopback port (alongside nt4_port and vscode_port).
ALTER TABLE container_leases ADD COLUMN halsim_port INTEGER;
