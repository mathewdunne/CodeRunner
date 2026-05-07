ALTER TABLE container_leases
  ADD COLUMN lsp_state TEXT NOT NULL DEFAULT 'missing';
