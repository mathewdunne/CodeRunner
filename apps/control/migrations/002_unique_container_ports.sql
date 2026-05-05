CREATE UNIQUE INDEX idx_container_leases_sim_port_unique
  ON container_leases(sim_port)
  WHERE sim_port IS NOT NULL;

CREATE UNIQUE INDEX idx_container_leases_lsp_port_unique
  ON container_leases(lsp_port)
  WHERE lsp_port IS NOT NULL;
